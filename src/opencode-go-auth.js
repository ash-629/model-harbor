// F-01 browser device authorization; F-02 encrypted shared credentials and
// single-flight rotating refresh; F-03 automatic Chat/Responses onboarding.
import crypto from 'node:crypto';
import { HttpError } from './store.js';
import { authorizeOpenCodeGo, normalizeOpenCodeGoPrefix } from './opencode-go.js';

const CONSOLE = 'https://opencode.ai/console';
const CLIENT = 'model-harbor';
const locks = new WeakMap();
const needsAuth = () => new HttpError(401, 'OpenCode Go 授权已失效，请重新进行浏览器授权', 'opencode_go_needs_auth');

async function request(path, body, { fetchImpl = fetch, signal, token, orgId } = {}) {
  let response;
  try {
    response = await fetchImpl(`${CONSOLE}${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { accept: 'application/json', 'user-agent': 'model-harbor/0.1.0',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(orgId ? { 'x-org-id': orgId } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    });
  } catch { throw new HttpError(502, '无法连接 OpenCode 授权服务，请检查 NAS 网络或代理', 'opencode_auth_network'); }
  let data;
  try { data = await response.json(); } catch { throw new HttpError(502, 'OpenCode 授权服务返回了无效响应'); }
  return { status: response.status, ok: response.ok, data };
}

function tokenValue(data, previousOrg) {
  if (typeof data?.access_token !== 'string' || !data.access_token || data.access_token.length > 16000 ||
      typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 16000 ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0 || /[\r\n\x00]/.test(data.access_token)) {
    throw new HttpError(502, 'OpenCode 未返回有效的授权凭据');
  }
  if (previousOrg && data.org_id != null && data.org_id !== previousOrg) throw new HttpError(502, 'OpenCode 续期返回的工作区不一致，请重新授权');
  return { access: data.access_token, refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
    orgId: typeof data.org_id === 'string' ? data.org_id : previousOrg };
}

function saveCredential(store, id, value) {
  store.data.openCodeGoAuth ||= {};
  store.data.openCodeGoAuth[id] = store.seal(JSON.stringify(value));
  store.save();
}

export async function openCodeGoCredential(store, provider, options = {}) {
  const id = provider.openCodeAuthId;
  if (!id) return { apiKey: store.unseal(provider.apiKey) };
  let map = locks.get(store);
  if (!map) { map = new Map(); locks.set(store, map); }
  if (map.has(id)) return map.get(id);
  const operation = (async () => {
    const sealed = store.data.openCodeGoAuth?.[id];
    if (!sealed) throw needsAuth();
    const value = JSON.parse(store.unseal(sealed));
    if (value.invalid) throw needsAuth();
    if (value.expires <= Date.now() + 60000) {
      // Refresh tokens are single use. Never retry or let the sibling provider
      // race this exchange. Persist rotation before issuing inference requests.
      // A crash or lost response must not cause the old token to be reused.
      saveCredential(store, id, { invalid: true });
      const result = await request('/auth/device/token', {
        grant_type: 'refresh_token', refresh_token: value.refresh, client_id: CLIENT
      }, options);
      if (!result.ok) {
        if ([400, 401, 403].includes(result.status)) {
          saveCredential(store, id, { invalid: true });
          throw needsAuth();
        }
        throw new HttpError(502, `OpenCode 续期结果不确定（HTTP ${result.status}），请重新授权`);
      }
      const next = tokenValue(result.data, value.orgId);
      saveCredential(store, id, next);
      return { apiKey: next.access, orgId: next.orgId };
    }
    return { apiKey: value.access, orgId: value.orgId };
  })();
  map.set(id, operation);
  try { return await operation; } finally { if (map.get(id) === operation) map.delete(id); }
}

export class OpenCodeGoAuth {
  constructor(store, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.store = store; this.fetchImpl = fetchImpl; this.now = now; this.attempts = new Map();
  }
  prune() {
    for (const [id, attempt] of this.attempts) if (attempt.expires < this.now() && !attempt.running) this.attempts.delete(id);
  }
  async start(owner, input, signal) {
    this.prune();
    const prefix = normalizeOpenCodeGoPrefix(input?.prefix);
    if (this.attempts.size >= 50) throw new HttpError(429, '授权请求过多，请稍后重试');
    const result = await request('/auth/device/code', { client_id: CLIENT, supports_org_scope: true }, { fetchImpl: this.fetchImpl, signal });
    const d = result.data;
    if (!result.ok) throw new HttpError(502, `OpenCode 授权服务返回 HTTP ${result.status}`);
    if (typeof d.device_code !== 'string' || typeof d.user_code !== 'string' ||
        !Number.isFinite(d.expires_in) || d.expires_in <= 0 || !Number.isFinite(d.interval) || d.interval < 0) {
      throw new HttpError(502, 'OpenCode 未返回有效的设备码');
    }
    let url;
    try { url = new URL(d.verification_uri_complete, CONSOLE + '/'); } catch { throw new HttpError(502, '无效的授权地址'); }
    if (url.origin !== 'https://opencode.ai' || url.username || url.password) throw new HttpError(502, '不受信任的授权地址');
    const id = crypto.randomUUID(), interval = Math.max(5, d.interval) * 1000;
    const expires = this.now() + Math.min(d.expires_in, 1800) * 1000;
    this.attempts.set(id, { owner, prefix, deviceCode: d.device_code, interval, nextPoll: this.now() + interval, expires, status: 'pending' });
    return { attemptId: id, userCode: d.user_code, url: url.href, expiresAt: expires, interval: interval / 1000 };
  }
  get(owner, id) {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.owner !== owner) throw new HttpError(404, '授权会话不存在，请重新发起授权');
    return attempt;
  }
  cancel(owner, id) {
    const attempt = this.get(owner, id);
    attempt.status = 'cancelled'; attempt.deviceCode = undefined; attempt.token = undefined;
    return { status: 'cancelled' };
  }
  async poll(owner, id, signal) {
    const a = this.get(owner, id);
    if (a.status === 'complete') return { status: 'complete', result: a.result };
    if (a.status !== 'pending') return { status: a.status };
    if (a.expires <= this.now()) { a.status = 'expired'; a.deviceCode = undefined; return { status: 'expired' }; }
    if (a.running) return a.running;
    if (a.nextPoll > this.now()) return { status: 'pending', interval: Math.ceil((a.nextPoll - this.now()) / 1000) };
    a.running = this.finish(a, signal);
    try { return await a.running; } finally { a.running = undefined; }
  }
  async finish(a, signal) {
    const options = { fetchImpl: this.fetchImpl, signal };
    a.nextPoll = this.now() + a.interval;
    if (!a.token) {
      const result = await request('/auth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: a.deviceCode, client_id: CLIENT
      }, options);
      if (a.status !== 'pending') return { status: a.status };
      if (!result.ok || !result.data.access_token) {
        if (result.data.error === 'slow_down') a.interval += 5000;
        if (['authorization_pending', 'slow_down'].includes(result.data.error)) {
          a.nextPoll = this.now() + a.interval;
          return { status: 'pending', interval: a.interval / 1000 };
        }
        if (result.status >= 500) throw new HttpError(502, 'OpenCode 授权服务暂时不可用');
        a.status = result.data.error === 'expired_token' ? 'expired' : 'denied';
        a.deviceCode = undefined;
        return { status: a.status };
      }
      a.token = tokenValue(result.data);
      a.deviceCode = undefined;
    }
    // Verify the selected workspace and use only Go models from its official
    // config. A general Console account is not proof of a Go subscription.
    const config = await request('/api/v2/config', undefined, { ...options, token: a.token.access, orgId: a.token.orgId });
    if (!config.ok) throw new HttpError(config.status === 401 ? 401 : 502, '无法读取 OpenCode 工作区配置，请确认授权和 Go 订阅');
    const models = [];
    for (const provider of Object.values(config.data?.providers || {})) {
      let base;
      try { base = new URL(provider.settings?.baseURL); } catch { continue; }
      if (base.origin !== 'https://opencode.ai' || !base.pathname.startsWith('/inference/go/')) continue;
      for (const [key, value] of Object.entries(provider.models || {})) {
        if (!value?.disabled) models.push(value?.modelID || key);
      }
    }
    if (!models.length) throw new HttpError(400, '当前工作区没有可用的 OpenCode Go 模型，请在授权页选择已订阅 Go 的工作区');
    if (a.status !== 'pending') return { status: a.status };
    const connectionId = crypto.randomUUID();
    saveCredential(this.store, connectionId, a.token);
    try {
      const result = await authorizeOpenCodeGo(this.store, { apiKey: a.token.access, prefix: a.prefix },
        { ...options, oauth: { id: connectionId, models } });
      a.status = 'complete'; a.result = result; a.token = undefined;
      return { status: 'complete', result };
    } catch (error) {
      delete this.store.data.openCodeGoAuth[connectionId]; this.store.save(); throw error;
    }
  }
}
