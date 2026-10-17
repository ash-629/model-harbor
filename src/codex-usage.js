// Return quota data only; never expose account identity, credentials or reset-credit IDs.
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function normalizeUsage(result) {
  const map = result?.rateLimitsByLimitId;
  const entries = map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length
    ? Object.entries(map) : result?.rateLimits ? [[result.rateLimits.limitId || 'codex', result.rateLimits]] : [];
  const buckets = entries.filter(([, value]) => value && typeof value === 'object').map(([id, value]) => ({
    id: String(value.limitId || id).slice(0, 128), name: typeof value.limitName === 'string' ? value.limitName.slice(0, 128) : null,
    planType: typeof value.planType === 'string' ? value.planType.slice(0, 64) : null,
    windows: ['primary', 'secondary'].filter(key => value[key] && typeof value[key] === 'object').map(key => {
      const window = value[key], used = finite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null;
      return { usedPercent: used, remainingPercent: used === null ? null : 100 - used,
        durationMins: finite(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : null,
        resetsAt: finite(window.resetsAt) && window.resetsAt > 0 && window.resetsAt < 8640000000000 ? window.resetsAt : null };
    })
  }));
  const count = result?.rateLimitResetCredits?.availableCount;
  return { buckets, resetCredits: Number.isSafeInteger(count) && count >= 0 ? count : null, checkedAt: new Date().toISOString() };
}
