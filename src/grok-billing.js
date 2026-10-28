// Grok subscription billing for the OAuth provider. The CLI proxy exposes a
// weekly credits window and a monthly limit; it does not expose a 5-hour window.
import { HttpError } from './store.js';
import { grokCredential, cliProxyHeaders } from './grok-oauth.js';
import { dispatcherForProvider } from './provider-proxy.js';

const cache = new Map();
const CACHE_MS = 30000;

function amount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.val === 'number' && Number.isFinite(value.val)) return value.val;
  return null;
}

function percent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function resetsAt(value) {
  const millis = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(millis) && millis > 0 ? Math.floor(millis / 1000) : null;
}

function windowFor(durationMins, usedPercent, end) {
  const used = percent(usedPercent);
  if (used === null) return null;
  return { durationMins, usedPercent: used, remainingPercent: 100 - used, resetsAt: resetsAt(end) };
}

export function normalizeGrokBilling({ weekly, monthly } = {}) {
  const windows = [];
  const weeklyWindow = windowFor(10080, weekly?.config?.creditUsagePercent, weekly?.config?.currentPeriod?.end);
  if (weeklyWindow) windows.push(weeklyWindow);
  const limit = amount(monthly?.config?.monthlyLimit);
  const used = amount(monthly?.config?.used);
  if (limit !== null && limit > 0 && used !== null) {
    const monthlyWindow = windowFor(43200, used / limit * 100, monthly?.config?.billingPeriodEnd);
    if (monthlyWindow) windows.push(monthlyWindow);
  }
  if (!windows.length) windows.push({ durationMins: 10080, usedPercent: null, remainingPercent: null, resetsAt: null });
  return { buckets: [{ id: 'grok', name: 'Grok', planType: null, windows }], resetCredits: null, checkedAt: new Date().toISOString() };
}

async function readBilling(store, provider, path, signal) {
  const credential = await grokCredential(store, provider);
  const base = String(provider.baseUrl || '').replace(/\/$/, '');
  const url = base + path;
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', ...(credential.apiKey ? { authorization: `Bearer ${credential.apiKey}` } : {}), ...cliProxyHeaders(new URL(url).hostname) },
      signal, redirect: 'error', dispatcher: dispatcherForProvider(store, provider, url)
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new HttpError(502, '无法连接 Grok 用量接口，请检查代理和网络');
  }
  if (response.status === 401) {
    await response.body?.cancel();
    throw new HttpError(401, 'Grok 订阅授权已失效，请重新授权', 'grok_needs_auth');
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  try { return await response.json(); }
  catch { throw new HttpError(502, 'Grok 用量接口返回了无法解析的结果'); }
}

export async function grokSubscriptionUsage(store, provider, signal) {
  if (provider.type !== 'grok' || provider.grokAuthMode !== 'oauth') throw new HttpError(400, '仅已授权的 Grok 订阅供应商支持用量查询');
  const cached = cache.get(provider.id);
  if (cached && Date.now() - cached.at < CACHE_MS) return structuredClone(cached.value);
  const [weekly, monthly] = await Promise.all([
    readBilling(store, provider, '/billing?format=credits', signal),
    readBilling(store, provider, '/billing', signal)
  ]);
  if (!weekly && !monthly) throw new HttpError(502, 'Grok 用量接口没有返回可用的用量窗口');
  const value = normalizeGrokBilling({ weekly, monthly });
  cache.set(provider.id, { value, at: Date.now() });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return structuredClone(value);
}
