// API-key paths only. Lossy transformations require provider opt-in.
import { HttpError } from './store.js';
const defaults = { enabled: false, toolDescriptionChars: 2000, oldToolResultChars: 32768, keepRecentUserTurns: 3, captureStreamUsage: false };
export function tokenPolicy(value) {
  if (value == null) return { ...defaults };
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(defaults, k))) throw new HttpError(400, '无效的 tokenOptimization 配置');
  const p = { ...defaults, ...value };
  for (const k of ['enabled', 'captureStreamUsage']) if (typeof p[k] !== 'boolean') throw new HttpError(400, `${k} 必须为布尔值`);
  for (const [k, min, max] of [['toolDescriptionChars', 256, 16000], ['oldToolResultChars', 4096, 262144], ['keepRecentUserTurns', 2, 20]]) {
    if (!Number.isInteger(p[k]) || p[k] < min || p[k] > max) throw new HttpError(400, `${k} 超出允许范围 ${min}–${max}`);
  }
  return p;
}
const bytes = v => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
export function requestStats(body) {
  const items = body.messages || (Array.isArray(body.input) ? body.input : []);
  let textChars = typeof body.input === 'string' ? body.input.length : 0, toolResultChars = 0, images = 0;
  const scan = v => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) scan(x); return; }
    if (['input_image', 'image_url', 'image'].includes(v.type)) { images++; return; }
    if (typeof v.text === 'string') textChars += v.text.length;
    for (const [k, x] of Object.entries(v)) if (k !== 'text') scan(x);
  };
  for (const item of items) {
    if (item.role === 'tool' || item.type === 'function_call_output') {
      const v = item.role === 'tool' ? item.content : item.output;
      if (typeof v === 'string') toolResultChars += v.length; else scan(v);
    } else if (typeof item.content === 'string') textChars += item.content.length; else scan(item.content);
  }
  return { requestBytes: bytes(body), toolCount: body.tools?.length || 0, toolBytes: bytes(body.tools || []), textChars, toolResultChars, images };
}
function clip(text, limit, kind) {
  if (text.length <= limit) return text;
  let retained = limit, marker;
  for (let i = 0; i < 4; i++) {
    marker = `\n[Model Harbor: ${kind} shortened; ${text.length - retained} characters omitted. Re-read the source if needed.]\n`;
    const next = Math.max(2, limit - marker.length);
    if (next === retained) break;
    retained = next;
  }
  const head = Math.ceil(retained / 2), tail = Math.floor(retained / 2);
  return text.slice(0, head) + marker + text.slice(-tail);
}
export function optimizeApiPayload(body, policy, disabled = false) {
  const p = tokenPolicy(policy), before = requestStats(body);
  const changes = { toolDescriptions: 0, oldToolResults: 0 };
  if (!p.enabled || disabled) return { payload: body, stats: { before, after: before, changes, enabled: false } };
  // Unknown/native/custom tools and JSON schemas are left intact.
  const payload = structuredClone(body);
  const trimTool = t => {
    if (t.type === 'namespace') { for (const tool of t.tools || []) trimTool(tool); return; }
    if (t.type !== 'function') return;
    const fn = t.function || t;
    if (typeof fn.description === 'string' && fn.description.length > p.toolDescriptionChars) {
      fn.description = clip(fn.description, p.toolDescriptionChars, 'tool description'); changes.toolDescriptions++;
    }
  };
  for (const t of payload.tools || []) trimTool(t);
  const items = payload.messages || (Array.isArray(payload.input) ? payload.input : []);
  const users = items.map((x, i) => x.role === 'user' ? i : -1).filter(i => i >= 0);
  const cutoff = users.length >= p.keepRecentUserTurns ? users.at(-p.keepRecentUserTurns) : 0;
  const calls = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    for (const c of item.tool_calls || []) calls.add(c.id);
    if (item.type === 'function_call') calls.add(item.call_id);
    if (i >= cutoff) continue;
    const field = item.role === 'tool' && calls.has(item.tool_call_id) ? 'content' : item.type === 'function_call_output' && calls.has(item.call_id) ? 'output' : null;
    if (field && typeof item[field] === 'string' && item[field].length > p.oldToolResultChars) {
      item[field] = clip(item[field], p.oldToolResultChars, 'old tool result'); changes.oldToolResults++;
    }
  }
  return { payload, stats: { before, after: requestStats(payload), changes, enabled: true } };
}
export function usageMetrics(u) {
  if (!u) return null;
  return { inputTokens: u.input_tokens ?? u.prompt_tokens ?? null, outputTokens: u.output_tokens ?? u.completion_tokens ?? null,
    cachedInputTokens: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? null,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? null };
}
