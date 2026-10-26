// F-01/F-04/P-01/P-02/R-01/R-02: local API server and same-origin administration.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, HttpError } from './store.js';
import { AdminAuth } from './admin-auth.js';
import { sendMessages, errorType as anthropicErrorType } from './anthropic.js';
import { route, routeWithFailover, discover } from './upstream.js';
import { writeSSE } from './protocol.js';
import { NasAgentBridge } from './nas-agent.js';
import { ImageProviders } from './image-providers.js';
import { claudeUsage } from './claude-usage.js';
import { providerBalance } from './balance.js';
import { ClaudeCodeBridge } from './claude-code.js';
import { GrokCodeBridge } from './grok-code.js';
import { ImageJobs, runnerFile, grokRunnerFile } from './images.js';
import { VideoProviders } from './video-providers.js';
import { VideoJobs } from './videos.js';
import { grokVideoRunnerFile } from './grok-video.js';
import { grokUsage } from './grok-usage.js';
import { authorizeOpenCodeGo, isOpenCodeGoProvider, classifyOpenCodeGoModel } from './opencode-go.js';
import { openCodeGoUsage } from './opencode-go-usage.js';
import { OpenCodeGoAuth } from './opencode-go-auth.js';
import { ToolDownloads } from './tools.js';
import { mediaAPI } from './media-api.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = path.join(root, 'public');
const equal = (a, b) => { const aa = Buffer.from(a || ''), bb = Buffer.from(b || ''); return aa.length === bb.length && crypto.timingSafeEqual(aa, bb); };
export function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function readBody(req, limit = 4 * 1024 * 1024) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请使用 application/json');
  const tooLarge = () => new HttpError(413, `请求体超过允许大小（上限 ${limit / (1024 * 1024)} MiB）`, 'request_too_large');
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw tooLarge(); }
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw tooLarge(); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, '请求 JSON 格式不正确'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new HttpError(400, '请求体必须为 JSON 对象');
  return body;
}
const CLIENT_SESSION_HEADERS = ['x-opencode-session', 'x-session-id', 'session-id', 'session_id', 'x-conversation-id', 'conversation-id', 'conversation_id', 'x-thread-id', 'thread-id', 'thread_id'];
function clientSessionId(req) {
  for (const name of CLIENT_SESSION_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 128);
  }
  return '';
}
async function syncGroupCooldowns(store, group, nasAgent, signal) {
  for (const id of group.members || []) {
    const provider = store.data.providers.find(p => p.id === id);
    if (!provider || provider.type !== 'nas-codex' || !provider.enabled) continue;
    try {
      const usage = await nasAgent.usage(provider, signal, true);
      const windows = (usage?.buckets || []).flatMap(bucket => bucket.windows || []);
      const exhausted = windows.filter(w => Number(w.usedPercent) >= 100 && Number(w.resetsAt) > 0);
      if (exhausted.length) {
        const until = Math.max(Date.now() + 60 * 1000, ...exhausted.map(w => Number(w.resetsAt) * 1000));
        store.setGroupCooldown(group.id, id, { until, kind: 'quota', at: new Date().toISOString() });
      } else {
        store.clearGroupCooldown(group.id, id);
      }
    } catch {}
  }
}

export function createGateway({ dataDir = path.join(root, 'data'), port = 8317, publicUrl, adminPassword, nasAgent = new NasAgentBridge(), claudeBridge = new ClaudeCodeBridge(), grokBridge = new GrokCodeBridge(), apiBodyLimitMb = 128 } = {}) {
  if (!Number.isInteger(apiBodyLimitMb) || apiBodyLimitMb < 1 || apiBodyLimitMb > 256) throw new Error('GATEWAY_API_BODY_LIMIT_MB 必须是 1–256 的整数');
  const external = publicUrl ? new URL(publicUrl) : null;
  if (external && (!['http:', 'https:'].includes(external.protocol) || external.username || external.password || external.pathname !== '/' || external.search || external.hash)) throw new Error('GATEWAY_PUBLIC_URL 必须是服务根地址');
  const store = new Store(dataDir), sessions = new Map(), logs = [];
  const adminAuth = new AdminAuth(store, adminPassword);
  const openCodeAuth = new OpenCodeGoAuth(store);
  let settingsSaving = false;
  if (external && !adminAuth.configured) throw new Error('局域网部署必须设置 GATEWAY_ADMIN_PASSWORD 或已保存的管理密码');
  const imageProviders = new ImageProviders(store), imageJobs = new ImageJobs(store, imageProviders, dataDir);
  const videoProviders = new VideoProviders(store), videoJobs = new VideoJobs(store, videoProviders, dataDir);
  const toolDownloads = new ToolDownloads(dataDir);
  const log = value => { logs.unshift({ time: new Date().toISOString(), ...value }); if (logs.length > 100) logs.pop(); };
  const server = http.createServer(async (req, res) => {
    const started = Date.now(), controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    req.on('aborted', () => controller.abort());
    res.apiOptimizationDisabled = req.headers['x-model-harbor-optimize'] === 'off';
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let requestModel, requestEndpoint, anthropicRequest = req.url?.split('?')[0] === '/v1/messages';
    try {
      const address = server.address();
      const actualPort = typeof address === 'object' ? address.port : port;
      const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (external) allowedHosts.push(external.host);
      if (!allowedHosts.includes(req.headers.host)) throw new HttpError(403, 'Host 不被允许；请通过配置的服务地址访问');
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`, external?.origin].includes(origin)) throw new HttpError(403, '不允许跨站请求');
      const url = new URL(req.url, 'http://' + req.headers.host), pathname = url.pathname;
      const method = req.method;
      const requestSessionId = clientSessionId(req);
      if (pathname.startsWith('/v1/media/')) {
        if (!equal(req.headers.authorization, `Bearer ${store.gatewayKey()}`)) throw new HttpError(401, '无效的网关 API Key', 'invalid_api_key');
        return await mediaAPI({ pathname, method, url, req, res, imageProviders, videoProviders, imageJobs, videoJobs, json, readBody });
      }
      if (adminAuth.enabled && pathname !== '/health' && !/^\/v1(?:\/|$)/.test(pathname)) {
        if (!await adminAuth.accepts(req.headers.authorization)) {
          res.setHeader('www-authenticate', 'Basic realm="Model Harbor", charset="UTF-8"');
          throw new HttpError(401, '请输入管理账号和密码');
        }
      }
      if (pathname === '/health' && method === 'GET') return json(res, 200, { status: 'ok', version: '0.1.0' });
      if (pathname === '/api/session' && method === 'GET') {
        for (const [id, s] of sessions) if (s.expires < Date.now()) sessions.delete(id);
        if (sessions.size > 200) sessions.delete(sessions.keys().next().value);
        const id = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
        sessions.set(id, { csrf, expires: Date.now() + 24 * 3600 * 1000 });
        res.setHeader('set-cookie', `mh_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
        return json(res, 200, { csrf });
      }
      const isAdmin = pathname.startsWith('/api/');
      if (isAdmin) {
        const sessionId = /(?:^|;\s*)mh_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1], session = sessions.get(sessionId);
        if (!session || session.expires < Date.now()) throw new HttpError(401, '管理会话已过期，请刷新页面');
        if (method !== 'GET' && !equal(req.headers['x-csrf-token'], session.csrf)) throw new HttpError(403, '无效的管理请求');
        if (pathname === '/api/settings' && method === 'GET') return json(res, 200, adminAuth.public());
        if (pathname === '/api/settings' && method === 'PUT') {
          const input = await readBody(req);
          if (settingsSaving) throw new HttpError(409, '设置正在保存，请稍后重试');
          settingsSaving = true;
          try {
            const result = await adminAuth.update(input);
            sessions.clear();
            return json(res, 200, result);
          } finally { settingsSaving = false; }
        }
        if (pathname === '/api/tools' && method === 'GET') return json(res, 200, { tools: toolDownloads.list() });
        if (pathname === '/api/tools/chatgpt/check' && method === 'POST') return json(res, 200, { tool: await toolDownloads.check() });
        if (pathname === '/api/tools/chatgpt/download' && method === 'GET') {
          const { file, name } = toolDownloads.file();
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size,
            'content-disposition': `attachment; filename="${name}"` });
          const stream = fs.createReadStream(file);
          stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
        }
        const skillDownload = /^\/api\/skills\/(model-harbor-(?:codex-image|grok-image|grok-video))\.zip$/.exec(pathname);
        if (skillDownload && method === 'GET') {
          const name = skillDownload[1] + '.zip';
          const file = path.join(root, 'src', 'media-skills', name);
          res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(file).size, 'content-disposition': `attachment; filename="${name}"` });
          const stream = fs.createReadStream(file);
          stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
        }
        if (pathname === '/api/image/providers' && method === 'GET') return json(res, 200, { providers: imageProviders.list() });
        if (pathname === '/api/image/providers' && method === 'POST') return json(res, 201, imageProviders.upsert(await readBody(req)));
        const imageProviderMatch = /^\/api\/image\/providers\/([a-z0-9_-]+)(\/check)?$/.exec(pathname);
        if (imageProviderMatch) {
          const [, id, action] = imageProviderMatch;
          if (method === 'POST' && action) return json(res, 200, await imageJobs.check(id));
          if (method === 'PUT' && !action) return json(res, 200, imageProviders.upsert(await readBody(req), id));
          if (method === 'DELETE' && !action) { imageProviders.remove(id); return json(res, 200, { deleted: true }); }
        }
        if (pathname === '/api/image/jobs' && method === 'GET') return json(res, 200, { jobs: imageJobs.list() });
        if (pathname === '/api/image/jobs' && method === 'POST') return json(res, 202, imageJobs.create(await readBody(req, 22 * 1024 * 1024)));
        const imageJobMatch = /^\/api\/image\/jobs\/([a-f0-9-]{36})$/.exec(pathname);
        if (imageJobMatch && method === 'GET') return json(res, 200, imageJobs.public(imageJobs.get(imageJobMatch[1])));
        const imageFileMatch = /^\/api\/image\/files\/([a-f0-9-]{36})$/.exec(pathname);
        if (imageFileMatch && method === 'GET') {
          const { file, job } = imageJobs.file(imageFileMatch[1]);
          res.writeHead(200, { 'content-type': job.mime, 'content-length': fs.statSync(file).size,
            'content-disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="model-harbor-${job.id}.${job.ext}"` });
          const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
        }
        if (pathname === '/api/image/runner' && method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/x-python; charset=utf-8', 'content-disposition': 'attachment; filename="codex-image-runner.py"' });
          return res.end(fs.readFileSync(runnerFile));
        }
        if (pathname === '/api/image/grok-runner' && method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/x-python; charset=utf-8', 'content-disposition': 'attachment; filename="grok-image-runner.py"' });
          return res.end(fs.readFileSync(grokRunnerFile));
        }
        if (pathname === '/api/video/providers' && method === 'GET') return json(res, 200, { providers: videoProviders.list() });
        if (pathname === '/api/video/providers' && method === 'POST') return json(res, 201, videoProviders.upsert(await readBody(req)));
        const videoProviderMatch = /^\/api\/video\/providers\/([a-z0-9_-]+)(\/check)?$/.exec(pathname);
        if (videoProviderMatch) {
          const [, id, action] = videoProviderMatch;
          if (method === 'POST' && action) return json(res, 200, await videoJobs.check(id));
          if (method === 'PUT' && !action) return json(res, 200, videoProviders.upsert(await readBody(req), id));
          if (method === 'DELETE' && !action) { videoProviders.remove(id); return json(res, 200, { deleted: true }); }
        }
        if (pathname === '/api/video/jobs' && method === 'GET') return json(res, 200, { jobs: videoJobs.list() });
        if (pathname === '/api/video/jobs' && method === 'POST') return json(res, 202, videoJobs.create(await readBody(req, 22 * 1024 * 1024)));
        const videoJobMatch = /^\/api\/video\/jobs\/([a-f0-9-]{36})$/.exec(pathname);
        if (videoJobMatch && method === 'GET') return json(res, 200, videoJobs.public(videoJobs.get(videoJobMatch[1])));
        const videoFileMatch = /^\/api\/video\/files\/([a-f0-9-]{36})$/.exec(pathname);
        if (videoFileMatch && method === 'GET') {
          const { file, job } = videoJobs.file(videoFileMatch[1]);
          res.writeHead(200, { 'content-type': job.mime, 'content-length': fs.statSync(file).size,
            'content-disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="model-harbor-${job.id}.${job.ext}"` });
          const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
        }
        if (pathname === '/api/video/runner' && method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/x-python; charset=utf-8', 'content-disposition': 'attachment; filename="grok-video-runner.py"' });
          return res.end(fs.readFileSync(grokVideoRunnerFile));
        }
        if (pathname === '/api/config' && method === 'GET') return json(res, 200, { providers: store.list(), groups: store.listGroups(), models: store.models(), logs, baseUrl: `${external?.origin || `http://127.0.0.1:${actualPort}`}/v1` });
        if (pathname === '/api/key' && method === 'GET') return json(res, 200, { key: store.gatewayKey() });
        if (pathname === '/api/providers/order' && method === 'PUT') return json(res, 200, { providers: store.reorderProviders((await readBody(req))?.ids) });
        if (pathname === '/api/providers' && method === 'POST') return json(res, 201, store.upsert(await readBody(req)));
        if (pathname === '/api/groups' && method === 'GET') return json(res, 200, { groups: store.listGroups() });
        if (pathname === '/api/groups' && method === 'POST') {
          const created = store.upsertGroup(await readBody(req));
          await syncGroupCooldowns(store, store.getGroup(created.id), nasAgent, controller.signal);
          return json(res, 201, store.publicGroup(store.getGroup(created.id)));
        }
        const groupMatch = /^\/api\/groups\/([a-z0-9_-]+)(?:\/(clear-cooldowns|sync))?$/.exec(pathname);
        if (groupMatch) {
          const [, groupId, groupAction] = groupMatch;
          const group = store.getGroup(groupId);
          if (method === 'PUT' && !groupAction) {
            store.upsertGroup(await readBody(req), groupId);
            return json(res, 200, store.publicGroup(store.getGroup(groupId)));
          }
          if (method === 'DELETE' && !groupAction) { store.removeGroup(groupId); return json(res, 200, { deleted: true }); }
          if (method === 'POST' && groupAction === 'clear-cooldowns') { store.clearGroupCooldowns(groupId); return json(res, 200, store.publicGroup(group)); }
          if (method === 'POST' && groupAction === 'sync') {
            await syncGroupCooldowns(store, group, nasAgent, controller.signal);
            return json(res, 200, store.publicGroup(group));
          }
        }
        if (pathname === '/api/opencode-go/authorize' && method === 'POST') return json(res, 200, await authorizeOpenCodeGo(store, await readBody(req), { signal: controller.signal }));
        if (pathname === '/api/opencode-go/auth/start' && method === 'POST') return json(res, 200, await openCodeAuth.start(sessionId, await readBody(req), controller.signal));
        const openCodeAuthMatch = /^\/api\/opencode-go\/auth\/([a-f0-9-]{36})\/(poll|cancel)$/.exec(pathname);
        if (openCodeAuthMatch && method === 'POST') {
          const [, id, action] = openCodeAuthMatch;
          return json(res, 200, action === 'cancel' ? openCodeAuth.cancel(sessionId, id) : await openCodeAuth.poll(sessionId, id, controller.signal));
        }
        const usageMatch = /^\/api\/providers\/([a-z0-9_-]+)\/usage$/.exec(pathname);
        if (usageMatch && method === 'GET') {
          const provider = store.get(usageMatch[1]);
          if (isOpenCodeGoProvider(provider)) return json(res, 200, await openCodeGoUsage(store, provider, controller.signal));
          if (provider.type === 'claude-code') return json(res, 200, await claudeUsage(provider, controller.signal));
          if (provider.type === 'grok-code') return json(res, 200, await grokUsage(provider, controller.signal));
          if (provider.type === 'openai') return json(res, 200, await providerBalance(store, provider, controller.signal));
          return json(res, 200, await nasAgent.usage(provider, controller.signal));
        }
        const resetMatch = /^\/api\/providers\/([a-z0-9_-]+)\/reset$/.exec(pathname);
        if (resetMatch && method === 'POST') return json(res, 200, await nasAgent.resetUsage(store.get(resetMatch[1]), await readBody(req), controller.signal));
        const match = /^\/api\/providers\/([a-z0-9_-]+)(\/refresh)?$/.exec(pathname);
        if (match) {
          const [, id, action] = match;
          if (method === 'POST' && action) {
            const provider = store.get(id);
            const models = await discover(store, provider, controller.signal, nasAgent);
            return json(res, 200, store.setModels(id, models));
          }
          if (method === 'PUT' && !action) return json(res, 200, store.upsert(await readBody(req), id));
          if (method === 'DELETE' && !action) { store.remove(id); return json(res, 200, { deleted: true }); }
        }
        if (pathname === '/api/test' && method === 'POST') {
          const input = await readBody(req);
          if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000) throw new HttpError(400, '请输入测试内容（最多 16000 字符）');
          const resolved = store.resolve(input.model);
          const { provider, model } = resolved;
          const endpoint = provider.protocol === 'responses' || (isOpenCodeGoProvider(provider) && classifyOpenCodeGoModel(model) === 'responses') ? 'responses' : 'chat/completions';
          const body = endpoint === 'responses' ? { model: input.model, input: input.prompt, store: false } : { model: input.model, messages: [{ role: 'user', content: input.prompt }] };
          requestModel = body.model; requestEndpoint = 'test';
          const output = await routeWithFailover(store, resolved, body, endpoint, res, controller.signal, nasAgent, claudeBridge, requestSessionId, grokBridge);
          const text = output.choices?.[0]?.message?.content ?? output.output?.filter(i => i.type === 'message').flatMap(i => i.content || []).map(c => c.text || c.refusal || '').join('\n') ?? '';
          log({ model: body.model, endpoint: 'test', status: 200, duration: Date.now() - started, ...(res.apiMetrics ? { tokenMetrics: res.apiMetrics } : {}) });
          return json(res, 200, { text, usage: output.usage, duration: Date.now() - started, ...(res.apiMetrics ? { tokenMetrics: res.apiMetrics } : {}) });
        }
        throw new HttpError(404, '管理接口不存在');
      }
      if (pathname === '/v1' || pathname === '/v1/' || pathname.startsWith('/v1/')) {
        if (!(req.headers.authorization && equal(req.headers.authorization, `Bearer ${store.gatewayKey()}`)) && !(req.headers['x-api-key'] && equal(req.headers['x-api-key'], store.gatewayKey()))) throw new HttpError(401, '无效的网关 API Key', 'invalid_api_key');
        if (pathname.replace(/\/$/, '') === '/v1' && method === 'GET') return json(res, 200, { service: 'Model Harbor', models: '/v1/models' });
        if (pathname === '/v1/models' && method === 'GET') return json(res, 200, { object: 'list', data: store.models() });
        if (pathname === '/v1/messages' && method === 'POST') {
          const body = await readBody(req, apiBodyLimitMb * 1024 * 1024);
          requestModel = body.model; requestEndpoint = 'messages';
          if (req.headers['anthropic-version'] && req.headers['anthropic-version'] !== '2023-06-01') throw new HttpError(400, 'Unsupported anthropic-version; use 2023-06-01');
          const resolved = store.resolve(body.model);
          const result = await sendMessages(body, res, (request, target) => routeWithFailover(store, resolved, request, 'responses', target, controller.signal, nasAgent, claudeBridge, requestSessionId, grokBridge));
          log({model:body.model,endpoint:'messages',status:200,duration:Date.now()-started,...(res.apiMetrics?{tokenMetrics:res.apiMetrics}:{})});
          if (result) json(res,200,result);
          return;
        }
        if (['/v1/chat/completions', '/v1/responses'].includes(pathname) && method === 'POST') {
          const body = await readBody(req, apiBodyLimitMb * 1024 * 1024);
          if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new HttpError(400, 'stream 必须为布尔值');
          const resolved = store.resolve(body.model);
          const endpoint = pathname.slice(4); requestModel = body.model; requestEndpoint = endpoint;
          const result = await routeWithFailover(store, resolved, body, endpoint, res, controller.signal, nasAgent, claudeBridge, requestSessionId, grokBridge);
          log({ model: body.model, endpoint, status: 200, duration: Date.now() - started, ...(res.apiMetrics ? { tokenMetrics: res.apiMetrics } : {}) });
          if (result) json(res, 200, result);
          return;
        }
        throw new HttpError(404, '接口不存在；支持 /v1/models、/v1/chat/completions、/v1/responses');
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '不支持此方法');
      const asset = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/image-ui.js': ['image-ui.js', 'text/javascript'], '/video-ui.js': ['video-ui.js', 'text/javascript'], '/i18n.js': ['i18n.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/pixel.woff2': ['pixel.woff2', 'font/woff2'], '/FONT-LICENSE.txt': ['FONT-LICENSE.txt', 'text/plain'] }[pathname];
      if (!asset) throw new HttpError(404, '页面不存在');
      res.writeHead(200, { 'content-type': asset[1] + '; charset=utf-8' });
      if (method === 'HEAD') return res.end();
      res.end(fs.readFileSync(path.join(publicDir, asset[0])));
    } catch (e) {
      const status = e.status || (e.name === 'TimeoutError' ? 504 : 502);
      const error = { message: e instanceof HttpError ? e.message : '请求处理失败，请检查上游响应格式与协议配置', type: e.code || 'gateway_error', code: e.code || 'gateway_error' };
      if (anthropicRequest) { error.type = anthropicErrorType(status); delete error.code; }
      if (requestModel) log({ model: requestModel, endpoint: requestEndpoint, status, duration: Date.now() - started, error: error.message, ...(res.apiMetrics ? { tokenMetrics: { ...res.apiMetrics, completion: 'failed' } } : {}) });
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        try {
          if (requestEndpoint === 'responses' && !anthropicRequest) {
            const response = { id: 'resp_error_' + Date.now(), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'failed', model: requestModel || '', output: [], error };
            await writeSSE(res, { type: 'response.failed', response }, 'response.failed');
          } else await writeSSE(res, { type: 'error', error }, requestEndpoint === 'responses' || anthropicRequest ? 'error' : undefined);
          res.end();
        } catch { res.destroy(); }
      } else {
        if (e.retryAfter && /^[\w ,:-]{1,80}$/.test(e.retryAfter)) res.setHeader('retry-after', e.retryAfter);
        json(res, status === 499 ? 408 : status, anthropicRequest ? { type:'error', error } : { error });
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('close', () => { imageJobs.close(); videoJobs.close(); toolDownloads.close(); nasAgent.close(); });
  return { server, store, logs, imageProviders, imageJobs, videoProviders, videoJobs, toolDownloads };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8317);
  const host = process.env.HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.GATEWAY_PUBLIC_URL) throw new Error('非本机监听必须配置公开地址及管理密码');
  const { server } = createGateway({ port, dataDir: process.env.GATEWAY_DATA_DIR || path.join(root, 'data'), publicUrl: process.env.GATEWAY_PUBLIC_URL, adminPassword: process.env.GATEWAY_ADMIN_PASSWORD, apiBodyLimitMb: Number(process.env.GATEWAY_API_BODY_LIMIT_MB || 128) });
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置 PORT 环境变量` : '服务启动失败：' + e.message); process.exit(1); });
  server.listen(port, host, () => console.log(`Model Harbor ready: ${process.env.GATEWAY_PUBLIC_URL || `http://${host}:${port}`}`));
}
