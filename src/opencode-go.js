// OpenCode Go onboarding and upstream helpers.
// The Go subscription exposes OpenAI Chat/Responses endpoints but assigns each
// model to one endpoint family. The UI can create two managed providers from a
// single API key, while this module keeps the classification and session-header
// rules in one place.
import crypto from 'node:crypto';
import { HttpError } from './store.js';
import { openCodeGoCredential } from './opencode-go-auth.js';

export const OPENCODE_GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models';
export const OPENCODE_GO_OPENAI_BASE = 'https://opencode.ai/inference/go/openai/v1';
export const OPENCODE_GO_CHAT_URL = `${OPENCODE_GO_OPENAI_BASE}/chat/completions`;
export const OPENCODE_GO_SESSION_HEADER = 'x-opencode-session';
export const OPENCODE_GO_USER_AGENT = 'model-harbor/0.1.0';

// Documented model assignments. Keep this table for exact matches, then fall
// back to conservative prefixes so newly published models still land in the
// right group. Unknown IDs are reported instead of being routed blindly.
const ENDPOINT_BY_MODEL = new Map([
  ['grok-4.7', 'responses'],
  ['gpt-6-luna', 'responses'],
  ['gpt-5.6-luna', 'responses'],
  ['muse-spark-1.3-contributor', 'responses'],
  ['muse-spark-1.2-contributor', 'responses'],
  ['claude-haiku-5-5', 'anthropic'],
  ['minimax-m3', 'anthropic'],
  ['qwen3.8-max', 'anthropic'],
  ['qwen3.8-flash', 'anthropic'],
  ['qwen3.7-plus', 'anthropic'],
  ['gemini-4-argon-contributor', 'google'],
  ['glm-5.3-flash', 'chat'],
  ['glm-5.3', 'chat'],
  ['glm-5.2', 'chat'],
  ['kimi-k3', 'chat'],
  ['kimi-k2.7-code', 'chat'],
  ['longcat-2.0', 'chat'],
  ['deepseek-v4.1-flash', 'chat'],
  ['deepseek-v4-pro', 'chat'],
  ['mimo-v2.6-flash', 'chat'],
  ['mimo-v2.6-pro', 'chat'],
  ['mimo-v2.5', 'chat'],
  ['mimo-v2.5-pro', 'chat'],
  ['hy4-preview', 'chat'],
  ['hy3', 'chat'],
  ['minimax-m3.1-flash-free', 'chat'],
  ['longcat-2.5-preview-free', 'chat'],
  ['step-5-preview', 'chat'],
  ['beam-free', 'chat']
]);

const CHAT_PREFIX = /^(?:glm|kimi|deepseek|mimo|longcat|minimax|hy\d|step|beam)/i;
const RESPONSES_PREFIX = /^(?:gpt|grok|muse-spark)/i;
const ANTHROPIC_PREFIX = /^(?:claude|qwen)/i;
const GOOGLE_PREFIX = /^gemini/i;

export function classifyOpenCodeGoModel(id) {
  const value = String(id || '').trim();
  if (!value) return 'unknown';
  const exact = ENDPOINT_BY_MODEL.get(value);
  if (exact) return exact;
  if (RESPONSES_PREFIX.test(value)) return 'responses';
  if (ANTHROPIC_PREFIX.test(value)) return 'anthropic';
  if (GOOGLE_PREFIX.test(value)) return 'google';
  if (CHAT_PREFIX.test(value)) return 'chat';
  return 'unknown';
}

export function classifyOpenCodeGoModels(ids) {
  const groups = { chat: [], responses: [], anthropic: [], google: [], unknown: [] };
  const seen = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    groups[classifyOpenCodeGoModel(id)].push(id);
  }
  return groups;
}

export function isOpenCodeGoProvider(provider) {
  if (!provider || provider.type !== 'openai') return false;
  return String(provider.baseUrl || '').replace(/\/+$/, '') === OPENCODE_GO_OPENAI_BASE;
}

export function normalizeOpenCodeGoPrefix(prefix) {
  const value = String(prefix || 'ocgo').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,37}$/.test(value)) {
    throw new HttpError(400, '前缀只能包含小写字母、数字、下划线、短横线，最多 38 字符');
  }
  return value;
}

export function planOpenCodeGoProviders(ids, prefix = 'ocgo') {
  const value = normalizeOpenCodeGoPrefix(prefix);
  const groups = classifyOpenCodeGoModels(ids);
  const base = {
    type: 'openai',
    baseUrl: OPENCODE_GO_OPENAI_BASE,
    timeout: 600,
    enabled: true,
    tokenOptimization: { enabled: false, captureStreamUsage: false }
  };
  // One provider exposes both model families. upstream.js routes each model to
  // its official endpoint and translates when the public endpoint differs.
  const models = [...groups.chat, ...groups.responses];
  const providers = models.length ? [{
    ...base, id: value, name: 'OpenCode Go',
    protocol: 'both', models
  }] : [];
  return { prefix: value, groups, providers };
}

function timeoutSignal(signal, ms = 30000) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function headers(apiKey, extra = {}) {
  return {
    accept: 'application/json',
    'user-agent': OPENCODE_GO_USER_AGENT,
    authorization: `Bearer ${apiKey}`,
    ...extra
  };
}

async function responseText(response) {
  try { return (await response.text()).slice(0, 500); } catch { return ''; }
}

function networkError() {
  return new HttpError(502, '无法连接 OpenCode Go，请检查 NAS 网络或代理设置', 'opencode_go_unreachable');
}

export async function fetchOpenCodeGoModels(apiKey, { fetchImpl = fetch, signal, orgId } = {}) {
  let response;
  try {
    response = await fetchImpl(OPENCODE_GO_MODELS_URL, {
      method: 'GET',
      headers: headers(apiKey, orgId ? { 'x-opencode-org-id': orgId } : {}),
      signal: timeoutSignal(signal),
      redirect: 'error'
    });
  } catch {
    throw networkError();
  }
  if (!response.ok) {
    await responseText(response);
    if ([401, 403].includes(response.status)) {
      throw new HttpError(401, 'OpenCode Go API Key 无效或没有权限', 'invalid_api_key');
    }
    throw new HttpError(502, `OpenCode Go 模型列表返回 HTTP ${response.status}`, 'opencode_go_models_failed');
  }
  let data;
  try { data = await response.json(); } catch {
    throw new HttpError(502, 'OpenCode Go 模型列表不是有效 JSON', 'opencode_go_models_failed');
  }
  const ids = Array.isArray(data?.data)
    ? data.data.map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string' && id.trim())
    : [];
  if (!ids.length) throw new HttpError(502, 'OpenCode Go 没有返回模型列表', 'opencode_go_models_failed');
  return [...new Set(ids.map(id => id.trim()))];
}

// A minimal completion validates the credential. Free models are tried first;
// a cheap paid model is the fallback when the free tiers are unavailable.
export async function probeOpenCodeGoKey(apiKey, { fetchImpl = fetch, signal } = {}) {
  const probes = ['minimax-m3.1-flash-free', 'longcat-2.5-preview-free', 'beam-free', 'mimo-v2.6-flash'];
  let last = null, rateLimited = null;
  for (const model of probes) {
    let response;
    try {
      response = await fetchImpl(OPENCODE_GO_CHAT_URL, {
        method: 'POST',
        headers: headers(apiKey, {
          'content-type': 'application/json',
          [OPENCODE_GO_SESSION_HEADER]: `mh-auth-${crypto.randomUUID()}`
        }),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        }),
        signal: timeoutSignal(signal),
        redirect: 'error'
      });
    } catch {
      return { ok: false, code: 'unreachable', status: 0, model, warning: '无法连接 OpenCode Go 完成验证，供应商已创建，请用测试按钮确认。' };
    }
    if (response.ok) {
      try { await response.body?.cancel(); } catch {}
      return { ok: true, status: response.status, model };
    }
    await responseText(response);
    last = { ok: false, status: response.status, model };
    if ([401, 403].includes(response.status)) return { ...last, authFailed: true };
    if (response.status === 429) {
      rateLimited = { ok: false, code: 'rate_limited', status: 429, model, warning: 'OpenCode Go 验证请求被限流，供应商已创建，请稍后用测试按钮确认。' };
    }
  }
  if (rateLimited) return rateLimited;
  return {
    ok: false,
    code: 'probe_failed',
    status: last?.status || 0,
    model: last?.model,
    warning: `未能完成密钥验证${last?.status ? `（HTTP ${last.status}）` : ''}，供应商已创建，请用测试按钮确认。`
  };
}

function existingProvider(store, id) {
  try { return store.get(id); } catch (e) { if (e?.status === 404) return null; throw e; }
}

function ensureManageable(existing, id) {
  if (existing && !isOpenCodeGoProvider(existing)) {
    throw new HttpError(409, `前缀 ${id} 已被其他供应商使用，请换一个模型前缀`, 'prefix_conflict');
  }
}

export async function authorizeOpenCodeGo(store, input, { fetchImpl = fetch, signal, oauth } = {}) {
  const apiKey = String(input?.apiKey || '').trim();
  if (!apiKey) throw new HttpError(400, '请输入 OpenCode Go API Key');
  if (apiKey.length > (oauth ? 16000 : 4096) || /[\r\n\x00]/.test(apiKey)) throw new HttpError(400, 'OpenCode Go API Key 格式不正确');
  const prefix = normalizeOpenCodeGoPrefix(input?.prefix);
  const ids = oauth?.models || await fetchOpenCodeGoModels(apiKey, { fetchImpl, signal });
  const plan = planOpenCodeGoProviders(ids, prefix);
  if (!plan.providers.length) throw new HttpError(502, 'OpenCode Go 没有返回可接入的 Chat/Responses 模型', 'opencode_go_no_models');

  const validation = oauth ? { ok: true, method: 'device_authorization' } : await probeOpenCodeGoKey(apiKey, { fetchImpl, signal });
  if (validation.authFailed) throw new HttpError(401, 'OpenCode Go API Key 无效或没有权限', 'invalid_api_key');

  // Validate existing IDs before writing anything so a conflict cannot leave a
  // half-applied set of providers.
  for (const provider of plan.providers) ensureManageable(existingProvider(store, provider.id), provider.id);
  const legacy = existingProvider(store, `${prefix}-r`);
  if (legacy && isOpenCodeGoProvider(legacy)) ensureManageable(legacy, legacy.id);

  const created = [], updated = [];
  for (const provider of plan.providers) {
    const existing = existingProvider(store, provider.id);
    const input = { ...provider, apiKey: oauth ? '' : apiKey, clearApiKey: Boolean(oauth) };
    if (existing) {
      input.name = existing.name || provider.name;
      input.timeout = existing.timeout ?? provider.timeout;
      input.enabled = existing.enabled !== false;
      input.tokenOptimization = existing.tokenOptimization || provider.tokenOptimization;
    }
    store.upsert(input, existing ? provider.id : undefined);
    if (oauth) store.get(provider.id).openCodeAuthId = oauth.id;
    store.setModels(provider.id, provider.models);
    (existing ? updated : created).push(provider.id);
  }
  // Earlier versions created a separate `-r` card. Fold its models into the
  // merged card before deleting it. Only managed Go cards are removed.
  if (legacy && legacy.id !== plan.prefix) {
    const merged = new Set([...store.get(plan.prefix).models, ...legacy.models]);
    store.setModels(plan.prefix, [...merged]);
    store.remove(legacy.id);
  }
  return {
    ok: true,
    prefix: plan.prefix,
    baseUrl: OPENCODE_GO_OPENAI_BASE,
    validation,
    groups: {
      total: ids.length,
      chat: plan.groups.chat,
      responses: plan.groups.responses,
      skipped: {
        anthropic: plan.groups.anthropic,
        google: plan.groups.google,
        unknown: plan.groups.unknown
      }
    },
    providers: store.list().filter(p => plan.providers.some(item => item.id === p.id)),
    created,
    updated
  };
}

export async function discoverOpenCodeGo(store, provider, signal, { fetchImpl = fetch } = {}) {
  const credential = await openCodeGoCredential(store, provider, { fetchImpl, signal });
  const ids = await fetchOpenCodeGoModels(credential.apiKey, { fetchImpl, signal, orgId: credential.orgId });
  const groups = classifyOpenCodeGoModels(ids);
  if (provider.protocol === 'both') {
    const models = [...groups.chat, ...groups.responses];
    if (!models.length) throw new HttpError(502, 'OpenCode Go 没有返回可接入的模型', 'opencode_go_no_models');
    return models;
  }
  // Keep old chat/responses cards refreshable during migration.
  const group = provider.protocol === 'responses' ? 'responses' : 'chat';
  if (!groups[group].length) throw new HttpError(502, `OpenCode Go 没有返回 ${group} 组模型`, 'opencode_go_no_models');
  return groups[group];
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.content === 'string') return part.content;
    return '';
  }).join('\n');
}

function sessionSeed(body) {
  if (!body || typeof body !== 'object') return '';
  const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  for (const key of ['session_id', 'conversation_id', 'thread_id']) {
    if (metadata[key]) return `meta:${metadata[key]}`;
  }
  if (body.prompt_cache_key) return `cache:${body.prompt_cache_key}`;
  if (Array.isArray(body.messages)) {
    const system = body.messages.find(item => item?.role === 'system' || item?.role === 'developer');
    const user = body.messages.find(item => item?.role === 'user');
    const seed = `${contentText(system?.content)}\n${contentText(user?.content)}`.trim();
    if (seed) return `chat:${seed}`;
  }
  if (typeof body.input === 'string' || Array.isArray(body.input) || body.instructions) {
    const input = typeof body.input === 'string'
      ? body.input
      : body.input?.find(item => item?.role === 'user' || item?.type === 'message')?.content;
    const seed = `${body.instructions || ''}\n${contentText(input)}`.trim();
    if (seed) return `responses:${seed}`;
  }
  return '';
}

// OpenCode Go requires a stable x-opencode-session value. Prefer a client
// header; otherwise derive one from the system prompt + first user turn so all
// turns of a conversation share routing/cache affinity.
export function openCodeSessionId(body, requestSessionId = '') {
  const supplied = String(requestSessionId || '').trim();
  if (supplied && supplied.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(supplied)) return supplied;
  const seed = sessionSeed(body);
  if (!seed) return `mh-${crypto.randomUUID().replace(/-/g, '')}`;
  return `mh-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}
