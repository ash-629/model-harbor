// Claude subscription usage over the same fixed SSH / SSH+Docker transport.
import { HttpError } from './store.js';
import { claudeRemote } from './claude-code.js';

const cache = new Map();
const CACHE_MS = 30000;

export function normalizeClaudeUsage(data) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const windows = [];
  for (const [key, durationMins] of [['five_hour', 300], ['seven_day', 10080]]) {
    const window = data?.[key];
    if (!window || typeof window !== 'object' || !finite(window.utilization)) continue;
    const used = Math.max(0, Math.min(100, window.utilization));
    const millis = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    windows.push({ durationMins, usedPercent: used, remainingPercent: 100 - used, resetsAt: Number.isFinite(millis) && millis > 0 ? Math.floor(millis / 1000) : null });
  }
  if (!windows.length && Array.isArray(data?.limits)) {
    for (const limit of data.limits) {
      const durationMins = limit?.kind === 'session' ? 300 : limit?.kind === 'weekly_all' ? 10080 : null;
      if (!durationMins || !finite(limit.percent)) continue;
      const used = Math.max(0, Math.min(100, limit.percent));
      const millis = typeof limit.resets_at === 'string' ? Date.parse(limit.resets_at) : NaN;
      windows.push({ durationMins, usedPercent: used, remainingPercent: 100 - used, resetsAt: Number.isFinite(millis) && millis > 0 ? Math.floor(millis / 1000) : null });
    }
  }
  const planType = typeof data?.subscriptionType === 'string' ? data.subscriptionType : typeof data?.rateLimitTier === 'string' ? data.rateLimitTier : null;
  return { buckets: [{ id: 'claude', name: 'Claude', planType, windows }], resetCredits: null, checkedAt: new Date().toISOString() };
}

export async function claudeUsage(p, signal) {
  if (p.type !== 'claude-code') throw new HttpError(400, '仅 Claude Code 供应商支持账号用量查询');
  const signature = JSON.stringify([p.execution, p.sshHost, p.sshUser, p.sshPort, p.sshKeyPath, p.container, p.claudePath]);
  const cached = cache.get(p.id);
  if (cached?.signature === signature && Date.now() - cached.at < CACHE_MS) return structuredClone(cached.value);
  const command = p.execution === 'ssh-docker'
    ? ['sudo', '-n', p.dockerPath || '/usr/local/bin/docker', 'exec', '-i', p.container, 'python3', '/workspace/model-harbor/claude-usage.py']
    : ['python3', p.usageRunnerPath || '/workspace/model-harbor/claude-usage.py'];
  const usageProvider = { ...p, timeout: Math.min(p.timeout || 180, 30) };
  let raw;
  try { raw = await claudeRemote(usageProvider, command, '', signal); }
  catch (e) { throw e instanceof HttpError ? e : new HttpError(502, '无法读取 Claude 用量，请检查目标环境的登录状态和网络'); }
  let data;
  try { data = JSON.parse(raw.trim()); } catch { throw new HttpError(502, 'Claude 用量返回了无法解析的结果'); }
  if (data?.error) throw new HttpError(502, String(data.error).slice(0, 300));
  const value = normalizeClaudeUsage(data);
  if (!value.buckets[0].windows.length) throw new HttpError(502, 'Claude 用量接口没有返回可用的用量窗口');
  cache.set(p.id, { signature, value, at: Date.now() });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return structuredClone(value);
}