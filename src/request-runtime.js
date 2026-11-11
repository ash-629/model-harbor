import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './store.js';
import { usageMetrics } from './api-token-policy.js';

export function retryBudget() {
  const count = Number(process.env.MH_CAPACITY_RETRIES ?? 2);
  const window = Number(process.env.MH_RETRY_WINDOW_SECONDS ?? 30);
  return { remaining: Math.min(5, Math.max(0, Math.floor(count) || 0)), retries: 0, attempts: 0,
    deadline: Date.now() + Math.max(1, Number.isFinite(window) ? window : 30) * 1000 };
}
export async function retryDelay(budget, delayMs, signal) {
  if (signal?.aborted) throw new HttpError(499, '请求已取消');
  const ms = Math.max(0, Number(delayMs) || 0) * (budget.retries + 1);
  if (budget.remaining <= 0 || Date.now() + ms >= budget.deadline) return false;
  budget.remaining--; budget.retries++;
  try { await delay(ms, undefined, { signal }); }
  catch { throw new HttpError(499, '请求已取消'); }
  return true;
}
export function outputStarted(res) {
  // SSE headers/keepalives are not model output. Other adapters keep their
  // conservative headersSent boundary until they explicitly support this flag.
  return res.apiRetrySafe === true ? res.apiOutputStarted === true : Boolean(res.headersSent);
}
export function markOutput(res) {
  res.apiOutputStarted = true;
  if (res.apiMetrics && res.apiMetrics.firstTokenMs == null) res.apiMetrics.firstTokenMs = Date.now() - (res.requestStarted || Date.now());
}
export function completeMetrics(res, response) {
  if (!res.apiMetrics) return;
  Object.assign(res.apiMetrics, { completion: response.status === 'incomplete' ? 'incomplete' : 'completed', usage: usageMetrics(response.usage),
    reconstructed: response.metadata?.model_harbor_session === 'reconstructed_after_tool_result' });
}
