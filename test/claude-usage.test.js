import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaudeUsage } from '../src/claude-usage.js';

test('normalizes Claude five-hour and weekly subscription usage', () => {
  const value = normalizeClaudeUsage({
    subscriptionType: 'pro',
    rateLimitTier: 'default_claude_ai',
    five_hour: { utilization: 3.2, resets_at: '2026-10-18T10:40:00.102519+00:00' },
    seven_day: { utilization: 12, resets_at: '2026-10-22T00:00:00.102542+00:00' }
  });
  assert.equal(value.resetCredits, null);
  assert.equal(value.buckets[0].id, 'claude');
  assert.equal(value.buckets[0].planType, 'pro');
  assert.equal(value.buckets[0].windows.length, 2);
  const [five, week] = value.buckets[0].windows;
  assert.deepEqual(
    { durationMins: five.durationMins, usedPercent: five.usedPercent, remainingPercent: five.remainingPercent },
    { durationMins: 300, usedPercent: 3.2, remainingPercent: 96.8 }
  );
  assert.equal(typeof five.resetsAt, 'number');
  assert.equal(week.durationMins, 10080);
  assert.equal(week.usedPercent, 12);
  assert.equal(week.remainingPercent, 88);
});

test('falls back to Claude limits and clamps percentages', () => {
  const fallback = normalizeClaudeUsage({
    limits: [
      { kind: 'session', percent: 5, resets_at: '2026-10-18T10:40:00+00:00' },
      { kind: 'weekly_all', percent: 7, resets_at: '2026-10-22T00:00:00+00:00' }
    ]
  });
  assert.equal(fallback.buckets[0].windows[0].usedPercent, 5);
  assert.equal(fallback.buckets[0].windows[1].usedPercent, 7);

  const clamped = normalizeClaudeUsage({ five_hour: { utilization: 120 } });
  assert.equal(clamped.buckets[0].windows[0].usedPercent, 100);
  assert.equal(clamped.buckets[0].windows[0].remainingPercent, 0);
  assert.equal(clamped.buckets[0].windows[0].resetsAt, null);
});