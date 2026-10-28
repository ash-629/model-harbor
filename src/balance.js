// Prepaid balance lookup for OpenAI-compatible providers that expose one (currently DeepSeek).
import { HttpError } from './store.js';
import { dispatcherFor } from './provider-proxy.js';

export function balanceSupported(p) {
  try { return p.type === 'openai' && /(^|\.)deepseek\.com$/.test(new URL(p.baseUrl).hostname); } catch { return false; }
}
export async function providerBalance(store, p, signal) {
  if (!balanceSupported(p)) throw new HttpError(400, '该供应商暂不支持余额查询');
  const key = store.unseal(p.apiKey);
  if (!key) throw new HttpError(400, '未配置 API Key');
  let response;
  try {
    const target = new URL(p.baseUrl).origin + '/user/balance';
    response = await fetch(target, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), redirect: 'error',
      dispatcher: dispatcherFor(p, target, value => store.unseal(value)) });
  } catch { throw new HttpError(502, '无法连接上游余额接口'); }
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status === 401 ? 401 : 502, `上游余额接口返回 HTTP ${response.status}`); }
  const data = await response.json();
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  return { kind: 'balance', available: data.is_available !== false, checkedAt: new Date().toISOString(),
    balances: (data.balance_infos || []).map(b => ({ currency: String(b.currency || ''), total: num(b.total_balance), granted: num(b.granted_balance), toppedUp: num(b.topped_up_balance) })) };
}
