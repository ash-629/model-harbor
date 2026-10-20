import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { normalizeOpenCodeGoUsage, openCodeGoUsage } from '../src/opencode-go-usage.js';
test('Go usage preserves zero and unknown, clamps and calculates remaining quota', () => {
  const data = normalizeOpenCodeGoUsage({ usage: { rolling: { percent: 0, resetsAt: '2026-10-19T17:24:14Z' }, weekly: { percent: 27.5 }, monthly: { percent: 110 } } });
  assert.deepEqual(data.windows.map(w => w.remainingPercent), [100, 72.5, 0]);
  assert.equal(data.windows[0].resetsAt, Date.parse('2026-10-19T17:24:14Z') / 1000);
  const unknown = normalizeOpenCodeGoUsage({ usage: { rolling: { percent: null, resetsAt: 'bad' } } });
  assert.equal(unknown.windows[0].usedPercent, null); assert.equal(unknown.windows[1].remainingPercent, null);
  assert.equal(unknown.windows[0].resetsAt, null);
  assert.throws(() => normalizeOpenCodeGoUsage({ usage: {} }), { status: 502 });
});
test('Go cards share cached usage and secrets stay in request headers only', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-go-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.data.openCodeGoAuth = { shared: store.seal(JSON.stringify({ access: 'private-token', refresh: 'private-refresh', expires: Date.now() + 3600000, orgId: 'org-a' })) };
  const p = { openCodeAuthId: 'shared' };
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++; assert.equal(url, 'https://opencode.ai/inference/go/v1/usage');
    assert.equal(options.headers.authorization, 'Bearer private-token'); assert.equal(options.headers['x-opencode-org-id'], 'org-a');
    return Response.json({ usage: { rolling: { percent: 10 } }, credential: 'must-not-return' });
  };
  const [a, b] = await Promise.all([openCodeGoUsage(store, p, undefined, { fetchImpl }), openCodeGoUsage(store, { ...p }, undefined, { fetchImpl })]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  await openCodeGoUsage(store, p, undefined, { fetchImpl }); assert.equal(calls, 1);
  assert.equal(JSON.stringify(a).includes('private'), false); assert.equal(JSON.stringify(a).includes('must-not-return'), false);
});
