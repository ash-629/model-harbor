import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGrokUsage } from '../src/grok-usage.js';

test('normalizes Grok weekly credit usage and reset time', () => {
  const value = normalizeGrokUsage({
    subscription_tier: 'SuperGrok',
    config: {
      creditUsagePercent: 7,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-21T08:20:49.714+00:00', end: '2026-10-28T08:20:49.714+00:00' }
    }
  });
  assert.equal(value.buckets[0].id, 'grok');
  assert.equal(value.buckets[0].planType, 'SuperGrok');
  assert.equal(value.buckets[0].windows[0].durationMins, 10080);
  assert.equal(value.buckets[0].windows[0].usedPercent, 7);
  assert.equal(value.buckets[0].windows[0].remainingPercent, 93);
  assert.equal(value.buckets[0].windows[0].resetsAt, 1793175649);
});
