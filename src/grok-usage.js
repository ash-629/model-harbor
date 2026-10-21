// Grok subscription weekly usage through the fixed official-CLI TUI runner.
import { HttpError } from './store.js';
import { grokRemote } from './grok-code.js';
const cache = new Map();
const CACHE_MS = 30000;
export function normalizeGrokUsage(data) {
  const cfg = data?.config;
  const used = Number(cfg?.creditUsagePercent);
  const period = cfg?.currentPeriod;
  const millis = typeof period?.end === 'string' ? Date.parse(period.end) : NaN;
  const windows = [];
  if (Number.isFinite(used)) {
    const bounded = Math.max(0, Math.min(100, used));
    const weekly = !period?.type || /WEEKLY/i.test(String(period.type));
    windows.push({ durationMins: weekly ? 10080 : null, usedPercent: bounded, remainingPercent: 100 - bounded, resetsAt: Number.isFinite(millis) && millis > 0 ? Math.floor(millis / 1000) : null });
  }
  return { buckets: [{ id: 'grok', name: 'Grok', planType: typeof data?.subscription_tier === 'string' ? data.subscription_tier : null, windows }], resetCredits: null, checkedAt: new Date().toISOString() };
}
export async function grokUsage(p, signal) {
  if (p.type !== 'grok-code') throw new HttpError(400, '仅 Grok Code 供应商支持账号用量查询');
  const signature = JSON.stringify([p.execution, p.sshHost, p.sshUser, p.sshPort, p.sshKeyPath, p.container, p.grokPath]);
  const cached = cache.get(p.id);
  if (cached?.signature === signature && Date.now() - cached.at < CACHE_MS) return structuredClone(cached.value);
  const runner = p.usageRunnerPath || '/workspace/model-harbor/grok-usage.py';
  const command = p.execution === 'ssh-docker'
    ? ['sudo', '-n', p.dockerPath || '/usr/local/bin/docker', 'exec', '-i', p.container, 'python3', runner]
    : ['python3', runner];
  const usageProvider = { ...p, timeout: Math.min(p.timeout || 180, 30) };
  let raw;
  try { raw = await grokRemote(usageProvider, command, '', signal); }
  catch (e) { throw e instanceof HttpError ? e : new HttpError(502, '无法读取 Grok 用量，请检查目标环境的登录状态和网络'); }
  let data;
  try { data = JSON.parse(raw.trim()); } catch { throw new HttpError(502, 'Grok 用量返回了无法解析的结果'); }
  if (data?.error) throw new HttpError(502, String(data.error).slice(0, 300));
  const value = normalizeGrokUsage(data);
  if (!value.buckets[0].windows.length) throw new HttpError(502, 'Grok 用量接口没有返回可用的用量窗口');
  cache.set(p.id, { signature, value, at: Date.now() });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return structuredClone(value);
}
