// Official Go subscription windows, shared by the Chat and Responses cards.
import { HttpError } from './store.js';
import { openCodeGoCredential } from './opencode-go-auth.js';
const caches = new WeakMap();
export function normalizeOpenCodeGoUsage(data, checkedAt = new Date().toISOString()) {
  const usage = data?.usage;
  if (!usage || !['rolling', 'weekly', 'monthly'].some(k => usage[k] && typeof usage[k] === 'object')) throw new HttpError(502, 'OpenCode Go 未返回有效的用量数据');
  return { kind: 'opencode-go', checkedAt, windows: ['rolling', 'weekly', 'monthly'].map(id => {
    const source = usage[id], value = source?.percent;
    const usedPercent = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
    const resets = typeof source?.resetsAt === 'string' ? Date.parse(source.resetsAt) : NaN;
    return { id, usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent,
      resetsAt: Number.isFinite(resets) ? resets / 1000 : null,
      status: ['ok', 'limited', 'exceeded'].includes(source?.status) ? source.status : null };
  }) };
}
export async function openCodeGoUsage(store, provider, signal, { fetchImpl = fetch } = {}) {
  let cache = caches.get(store);
  if (!cache) { cache = new Map(); caches.set(store, cache); }
  const id = provider.openCodeAuthId || provider.apiKey;
  const existing = cache.get(id);
  if (existing?.value && Date.now() - existing.at < 30000) return existing.value;
  if (existing?.pending) return existing.pending;
  const pending = (async () => {
    const credential = await openCodeGoCredential(store, provider, { fetchImpl, signal });
    if (!credential.apiKey) throw new HttpError(400, '请先授权 OpenCode Go');
    let response;
    try {
      response = await fetchImpl('https://opencode.ai/inference/go/v1/usage', {
        headers: { authorization: `Bearer ${credential.apiKey}`, accept: 'application/json', 'user-agent': 'model-harbor/0.1.0',
          ...(credential.orgId ? { 'x-opencode-org-id': credential.orgId } : {}) },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), redirect: 'error'
      });
    } catch { throw new HttpError(502, '无法连接 OpenCode Go 用量接口'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status === 401 ? 401 : 502, `OpenCode Go 用量查询失败（HTTP ${response.status}）`);
    }
    let data;
    try { data = await response.json(); } catch { throw new HttpError(502, 'OpenCode Go 用量接口返回无效 JSON'); }
    const value = normalizeOpenCodeGoUsage(data);
    cache.set(id, { value, at: Date.now() });
    return value;
  })();
  cache.set(id, { pending });
  try { return await pending; } catch (e) { cache.delete(id); throw e; }
}
