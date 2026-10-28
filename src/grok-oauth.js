// Grok subscription OAuth (xAI PKCE) and cli-chat-proxy client identity.
// Tokens never leave the encrypted store; only access tokens reach the upstream.
import crypto from 'node:crypto';
import { HttpError } from './store.js';
import { dispatcherFor } from './provider-proxy.js';

import { GROK_AUTHORIZE_URL, GROK_TOKEN_URL, GROK_CLIENT_ID, GROK_SCOPE, GROK_REDIRECT_URI, GROK_CLI_HOST } from './grok-config.js';
export { GROK_AUTHORIZE_URL, GROK_TOKEN_URL, GROK_CLIENT_ID, GROK_SCOPE, GROK_REDIRECT_URI, GROK_CLI_HOST, GROK_CLI_BASE_URL, GROK_API_BASE_URL } from './grok-config.js';

const SESSION_TTL = 10 * 60 * 1000;
const TOKEN_TIMEOUT = 30000;
const REFRESH_SKEW = 60 * 1000;
const DEFAULT_CLI_VERSION = '1.0.46';
const MIN_CLI_VERSION = [1, 0, 13];
const locks = new WeakMap();

const needsAuth = () => new HttpError(401, 'Grok 订阅授权已失效或尚未完成，请重新授权', 'grok_needs_auth');

export function cliVersion() {
  const raw = String(process.env.MH_GROK_CLI_VERSION || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(raw)) return DEFAULT_CLI_VERSION;
  const parts = raw.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i] > MIN_CLI_VERSION[i]) return raw;
    if (parts[i] < MIN_CLI_VERSION[i]) return DEFAULT_CLI_VERSION;
  }
  return raw;
}

function platformTag() {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform;
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'ia32' ? 'x86' : process.arch;
  return `${platform}; ${arch}`;
}

// cli-chat-proxy rejects Grok Build OAuth tokens without the official CLI identity.
export function cliProxyHeaders(hostname) {
  if (String(hostname || '').toLowerCase() !== GROK_CLI_HOST) return {};
  const version = cliVersion();
  return {
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-client-version': version,
    'x-grok-client-identifier': 'grok-pager',
    'x-grok-client-mode': 'interactive',
    'x-authenticateresponse': 'authenticate-response',
    'user-agent': `grok-pager/${version} grok-shell/${version} (${platformTag()})`
  };
}

const b64url = value => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createPkce(size = 32) {
  const verifier = b64url(crypto.randomBytes(size));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl({ state, challenge, redirectUri = GROK_REDIRECT_URI, nonce }) {
  const params = new URLSearchParams({
    response_type: 'code', client_id: GROK_CLIENT_ID, redirect_uri: redirectUri,
    scope: GROK_SCOPE, state, nonce, code_challenge: challenge,
    code_challenge_method: 'S256', plan: 'generic', referrer: 'model-harbor'
  });
  return `${GROK_AUTHORIZE_URL}?${params.toString()}`;
}

// Accepts a full callback URL, a bare query string, or a raw authorization code.
export function parseCallbackInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > 8192) return { code: '', state: '' };
  try {
    const url = new URL(text);
    const code = String(url.searchParams.get('code') || '').trim();
    if (code) return { code, state: String(url.searchParams.get('state') || '').trim() };
  } catch {}
  const query = text.replace(/^\?/, '');
  if (query.includes('=')) {
    const params = new URLSearchParams(query);
    const code = String(params.get('code') || '').trim();
    if (code) return { code, state: String(params.get('state') || '').trim() };
  }
  return { code: text, state: '' };
}

function decodeEmail(idToken) {
  if (typeof idToken !== 'string') return '';
  const part = idToken.split('.')[1];
  if (!part) return '';
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email.slice(0, 200) : '';
  } catch { return ''; }
}

export function tokenValue(data, previous = {}) {
  const access = data?.access_token, refresh = data?.refresh_token ?? previous.refresh, expiresIn = Number(data?.expires_in);
  if (typeof access !== 'string' || !access || access.length > 16000 || /[\r\n\x00]/.test(access)) throw new HttpError(502, 'xAI 未返回有效的访问令牌');
  if (typeof refresh !== 'string' || !refresh || refresh.length > 16000 || /[\r\n\x00]/.test(refresh)) throw new HttpError(502, 'xAI 未返回有效的刷新令牌');
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 60 * 60 * 24 * 90) throw new HttpError(502, 'xAI 未返回有效的令牌有效期');
  return { access, refresh, expires: Date.now() + expiresIn * 1000, email: decodeEmail(data?.id_token ?? previous.idToken) || previous.email || '' };
}

async function tokenCall(store, provider, form, { fetchImpl = fetch, signal } = {}) {
  const body = new URLSearchParams(form).toString();
  let response;
  try {
    response = await fetchImpl(GROK_TOKEN_URL, {
      method: 'POST', redirect: 'error',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'model-harbor/0.1.0' },
      body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT)]) : AbortSignal.timeout(TOKEN_TIMEOUT),
      dispatcher: dispatcherFor(provider, GROK_TOKEN_URL, value => store.unseal(value))
    });
  } catch {
    throw new HttpError(502, '无法连接 xAI 授权服务，请检查供应商代理设置', 'grok_oauth_network');
  }
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, ok: response.ok, data };
}

function saveCredential(store, authId, value) {
  store.data.grokAuth ||= {};
  store.data.grokAuth[authId] = store.seal(JSON.stringify(value));
  store.save();
}

export async function grokCredential(store, provider, options = {}) {
  if (provider.type !== 'grok' || provider.grokAuthMode !== 'oauth') return { apiKey: store.unseal(provider.apiKey) };
  const id = provider.grokAuthId;
  if (!id) throw needsAuth();
  let map = locks.get(store);
  if (!map) { map = new Map(); locks.set(store, map); }
  if (map.has(id)) return map.get(id);
  const operation = (async () => {
    const sealed = store.data.grokAuth?.[id];
    if (!sealed) throw needsAuth();
    const value = JSON.parse(store.unseal(sealed));
    if (value.invalid) throw needsAuth();
    if (value.expires <= Date.now() + REFRESH_SKEW) {
      // Refresh tokens rotate. Persist the new pair before inference so a
      // restart cannot replay a consumed refresh token.
      saveCredential(store, id, { invalid: true });
      const result = await tokenCall(store, provider, { grant_type: 'refresh_token', client_id: GROK_CLIENT_ID, refresh_token: value.refresh }, options);
      if (!result.ok) {
        if ([400, 401, 403].includes(result.status)) {
          saveCredential(store, id, { invalid: true });
          throw needsAuth();
        }
        throw new HttpError(502, `Grok 令牌续期结果不确定（HTTP ${result.status}），请重新授权`, 'grok_refresh_uncertain');
      }
      const next = tokenValue(result.data, value);
      saveCredential(store, id, next);
      return { apiKey: next.access };
    }
    return { apiKey: value.access };
  })();
  map.set(id, operation);
  try { return await operation; } finally { if (map.get(id) === operation) map.delete(id); }
}

export class GrokOAuth {
  constructor(store, { fetchImpl = null, now = () => Date.now() } = {}) {
    this.store = store; this.fetchImpl = fetchImpl; this.now = now; this.sessions = new Map();
  }
  prune() {
    for (const [state, session] of this.sessions) if (session.expires < this.now()) this.sessions.delete(state);
  }
  start(owner, providerId) {
    this.prune();
    const provider = this.store.get(providerId);
    if (provider.type !== 'grok') throw new HttpError(400, '仅 Grok 订阅供应商支持 OAuth 授权');
    if (provider.grokAuthMode !== 'oauth') throw new HttpError(400, '请先把此供应商的认证方式设为 OAuth');
    if (this.sessions.size >= 20) throw new HttpError(429, '授权请求过多，请稍后重试');
    const state = b64url(crypto.randomBytes(24));
    const { verifier, challenge } = createPkce();
    const nonce = b64url(crypto.randomBytes(16));
    const expires = this.now() + SESSION_TTL;
    this.sessions.set(state, { owner, providerId, verifier, redirectUri: GROK_REDIRECT_URI, expires, consumed: false });
    return { state, url: buildAuthorizeUrl({ state, challenge, nonce }), redirectUri: GROK_REDIRECT_URI, expiresAt: new Date(expires).toISOString() };
  }
  async exchange(owner, providerId, input, signal) {
    this.prune();
    const parsed = parseCallbackInput(input?.callback ?? input?.code ?? '');
    if (!parsed.code) throw new HttpError(400, '请粘贴浏览器地址栏里的回调地址，或直接粘贴 code');
    const state = parsed.state || String(input?.state || '').trim();
    const session = this.sessions.get(state);
    if (!session) throw new HttpError(400, '授权会话已过期，请重新开始授权');
    if (session.owner !== owner || session.providerId !== providerId) throw new HttpError(404, '授权会话不存在，请重新开始授权');
    if (session.consumed) throw new HttpError(409, '该授权回调已经使用过，请重新开始授权');
    session.consumed = true;
    const provider = this.store.get(providerId);
    const options = { signal };
    if (this.fetchImpl) options.fetchImpl = this.fetchImpl;
    const result = await tokenCall(this.store, provider, {
      grant_type: 'authorization_code', client_id: GROK_CLIENT_ID, code: parsed.code,
      redirect_uri: session.redirectUri, code_verifier: session.verifier
    }, options);
    if (!result.ok) {
      const detail = String(result.data?.error || '');
      if (result.status === 400 && /invalid_grant/i.test(detail)) throw new HttpError(400, '授权码无效或已过期，请重新开始授权', 'grok_oauth_invalid_code');
      throw new HttpError(result.status === 429 ? 429 : 502, `xAI 授权服务返回 HTTP ${result.status}`, 'grok_oauth_failed');
    }
    const value = tokenValue(result.data);
    const authId = crypto.randomUUID();
    saveCredential(this.store, authId, value);
    const saved = this.store.setGrokAuth(providerId, authId);
    this.sessions.delete(state);
    return { provider: saved, email: value.email || '', expiresAt: new Date(value.expires).toISOString() };
  }
}
