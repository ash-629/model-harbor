import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGrokBilling, grokSubscriptionUsage } from '../src/grok-billing.js';

test('normalizes weekly credits and monthly limit without inventing a 5-hour window', () => {
  const value = normalizeGrokBilling({
    weekly: { config: { creditUsagePercent: 12.5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-28T08:20:49.714+00:00' } } },
    monthly: { config: { monthlyLimit: { val: 15000 }, used: { val: 1500 }, billingPeriodEnd: '2026-11-01T00:00:00.000+00:00' } }
  });
  assert.deepEqual(value.buckets[0].windows.map(window => window.durationMins), [10080, 43200]);
  assert.equal(value.buckets[0].windows[0].usedPercent, 12.5);
  assert.equal(value.buckets[0].windows[0].resetsAt, 1793175649);
  assert.equal(value.buckets[0].windows[1].usedPercent, 10);
  assert.equal(value.resetCredits, null);
});

test('unknown billing payloads stay empty instead of showing a fabricated percentage', () => {
  const value = normalizeGrokBilling({ weekly: { config: { creditUsagePercent: null } }, monthly: { config: {} } });
  assert.equal(value.buckets[0].windows.length, 1);
  assert.equal(value.buckets[0].windows[0].usedPercent, null);
  assert.equal(value.buckets[0].windows[0].durationMins, 10080);
});

test('subscription usage reads both billing endpoints through the provider proxy', async t => {
  const provider = { id: 'grokx', type: 'grok', grokAuthMode: 'oauth', grokAuthId: 'auth-1', baseUrl: 'https://cli-chat-proxy.grok.com/v1' };
  const store = {
    data: { grokAuth: { 'auth-1': JSON.stringify({ access: 'at-live', refresh: 'rt-live', expires: Date.now() + 3600000 }) }, proxies: [] },
    unseal: value => value, seal: value => value, save() {}
  };
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: String(url), authorization: options.headers.authorization, client: options.headers['x-grok-client-identifier'] });
    const weekly = String(url).includes('format=credits');
    const payload = weekly
      ? { config: { creditUsagePercent: 4, currentPeriod: { end: '2026-11-04T00:00:00.000Z' } } }
      : { config: { monthlyLimit: { val: 100 }, used: { val: 25 }, billingPeriodEnd: '2026-11-30T00:00:00.000Z' } };
    return new Response(JSON.stringify(payload));
  });
  const value = await grokSubscriptionUsage(store, provider);
  assert.deepEqual(seen.map(item => item.url), [
    'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    'https://cli-chat-proxy.grok.com/v1/billing'
  ]);
  assert.equal(seen[0].authorization, 'Bearer at-live');
  assert.equal(seen[0].client, 'grok-pager');
  assert.equal(value.buckets[0].windows[0].usedPercent, 4);
  assert.equal(value.buckets[0].windows[1].usedPercent, 25);
  await assert.rejects(grokSubscriptionUsage(store, { ...provider, grokAuthMode: 'apiKey' }), /订阅/);
});
