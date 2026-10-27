// GT-01..GT-06: official Grok CLI structured client-tool bridge over SSH.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { HttpError } from './store.js';
import { openSSE, writeSSE } from './protocol.js';
import { agentChat } from './nas-agent.js';
import { grokContext, grokPrompt, grokSchema, grokResult } from './grok-tools.js';
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
export function grokRemote(p, command, stdin, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-p', String(p.sshPort || 22), '-i', p.sshKeyPath, `${p.sshUser}@${p.sshHost}`, command.map(quote).join(' ')], { windowsHide: true, signal });
    let out = '', err = '', size = 0; const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => { child.kill(); reject(new HttpError(504, 'Grok 远程调用超时')); }, (p.timeout || 180) * 1000 + 15000);
    child.stdout.on('data', data => { size += data.length; if (size > 8 * 1024 * 1024) { child.kill(); reject(new HttpError(502, 'Grok 远程输出超出限制')); } else out += decoder.write(data); });
    child.stderr.on('data', data => { if (err.length < 2000) err += data.toString(); });
    child.on('error', () => { clearTimeout(timer); reject(new HttpError(signal?.aborted ? 499 : 502, signal?.aborted ? '请求已取消' : '无法启动 SSH，请检查 SSH 客户端及私钥路径')); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer); out += decoder.end();
      if (code === 0) resolve(out);
      else {
        const reason = /Permission denied/.test(err) ? 'SSH 认证失败'
          : /sudo.*password|password is required/.test(err) ? '远程 sudo 需要配置免交互 Docker 权限'
          : /Host key verification/.test(err) ? 'SSH 主机密钥未受信，请先手动连接核对'
          : /timed out|unreachable|refused/i.test(err) ? '远程网络连接失败'
          : /Model Harbor SSH command denied/.test(err) ? '模型港 SSH 白名单未放行 Grok 命令'
          : 'SSH / Grok CLI 执行失败';
        reject(new HttpError(502, `${reason}（退出码 ${code}）`));
      }
    });
    child.stdin.end(stdin);
  });
}

export function parseGrokModels(text) {
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  const models = [];
  for (const line of clean.split(/\r?\n/)) {
    const match = /^\s*[*-]\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,199})(?:\s|$)/.exec(line);
    if (match) models.push(match[1]);
  }
  return [...new Set(models)];
}

export function grokModelsCommand(p) {
  const tail = [p.grokPath || 'grok', 'models'];
  return p.execution === 'ssh-docker' ? ['sudo', '-n', p.dockerPath || '/usr/local/bin/docker', 'exec', '-i', p.container, ...tail] : tail;
}

export async function grokModels(p, signal) {
  const raw = await grokRemote(p, grokModelsCommand(p), '', signal);
  const models = parseGrokModels(raw);
  if (!models.length) throw new HttpError(502, 'Grok CLI 未返回可用模型，请检查登录状态');
  return models;
}

export function grokTranscript(body, endpoint) { return grokContext(body, endpoint).transcript; }
export function grokToolCommand(p) {
  const tail = ['timeout', '--signal=TERM', '--kill-after=5s', '610s', 'python3', '/workspace/model-harbor/grok-tool-runner.py', '--cli', p.grokPath || 'grok'];
  return p.execution === 'ssh-docker' ? ['sudo', '-n', p.dockerPath || '/usr/local/bin/docker', 'exec', '-i', p.container, ...tail] : tail;
}
export class GrokCodeBridge {
  constructor({ remote = grokRemote, maxConcurrent = 4 } = {}) { this.remote = remote; this.active = 0; this.maxConcurrent = maxConcurrent; }
  async run(p, model, body, endpoint, signal) {
    if (signal?.aborted) throw new HttpError(499, '请求已取消');
    const context = grokContext(body, endpoint), schema = grokSchema(context);
    if (this.active >= this.maxConcurrent) throw new HttpError(429, 'Grok 工具桥接繁忙，请稍后重试');
    this.active++;
    try {
      const payload = { model, timeout: p.timeout || 180, prompt: grokPrompt(context), schema };
      if (context.images.length) payload.images = context.images;
      const raw = await this.remote(p, grokToolCommand(p), JSON.stringify(payload), signal);
      if (signal?.aborted) throw new HttpError(499, '请求已取消');
      let data; try { data = JSON.parse(raw); } catch { throw new HttpError(502, 'Grok CLI 执行器没有返回有效 JSON'); }
      return grokResult(data, context, body.model);
    } finally { this.active--; }
  }
}
export async function sendGrok(bridge, p, model, body, endpoint, res, signal) {
  // Validate before opening SSE, then keep long CLI calls alive. Structured
  // tool calls are emitted only after the completed result passes validation.
  const context = grokContext(body, endpoint); grokSchema(context);
  let heartbeat, sequence = 0;
  const emit = (type, fields) => writeSSE(res, { type, sequence_number: sequence++, ...fields }, type);
  if (body.stream) { openSSE(res); heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000); heartbeat.unref(); }
  let response; try { response = await bridge.run(p, model, body, endpoint, signal); } finally { clearInterval(heartbeat); }
  if (!body.stream) return endpoint === 'responses' ? response : agentChat(response);
  if (endpoint === 'responses') {
    const initial = { ...response, status: 'in_progress', output: [], usage: null };
    await emit('response.created', { response: initial }); await emit('response.in_progress', { response: initial });
    for (let index = 0; index < response.output.length; index++) {
      const item = response.output[index], meta = { item_id: item.id, output_index: index };
      const custom = item.type === 'custom_tool_call', fn = item.type === 'function_call';
      await emit('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : custom ? { input: '' } : fn ? { arguments: '' } : {}) } });
      if (custom || fn) { const stem = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments', field = custom ? 'input' : 'arguments'; await emit(stem + '.delta', { ...meta, delta: item[field] }); await emit(stem + '.done', { ...meta, [field]: item[field], name: item.name }); }
      else if (item.type === 'message') {
        const part = item.content[0], fields = { ...meta, content_index: 0 };
        await emit('response.content_part.added', { ...fields, part: { ...part, text: '' } });
        await emit('response.output_text.delta', { ...fields, delta: part.text, logprobs: [] }); await emit('response.output_text.done', { ...fields, text: part.text, logprobs: [] });
        await emit('response.content_part.done', { ...fields, part });
      }
      await emit('response.output_item.done', { output_index: index, item });
    }
    await emit('response.completed', { response });
  } else {
    const chat = agentChat(response), choice = chat.choices[0], base = { id: chat.id, object: 'chat.completion.chunk', created: chat.created, model: chat.model };
    await writeSSE(res, { ...base, choices: [{ index: 0, delta: { ...choice.message, ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((t, index) => ({ ...t, index })) } : {}) }, finish_reason: null }] });
    await writeSSE(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] });
    await writeSSE(res, { ...base, choices: [], usage: chat.usage }); await writeSSE(res, '[DONE]');
  }
  res.end(); return null;
}
