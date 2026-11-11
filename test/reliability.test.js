import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/server.js';
import { HttpError } from '../src/store.js';
import { RequestJournal } from '../src/request-journal.js';
import { retryBudget, retryDelay } from '../src/request-runtime.js';
import { ImageJobs } from '../src/images.js';
import { VideoJobs } from '../src/videos.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mh-reliability-'));
const wait = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('condition timed out'); };
const item = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'LIVE', annotations: [] }] };
const result = () => ({ id: 'resp_test', object: 'response', created_at: 1, status: 'completed', output: [item], usage: { input_tokens: 17, output_tokens: 4, input_tokens_details: { cached_tokens: 8 } } });
const codex = id => ({ id, type: 'nas-codex', sshHost: '192.0.2.1', sshUser: 'test', sshKeyPath: '/key', container: 'test', execution: 'ssh-docker', models: ['m'] });
async function gateway(bridge) {
  const dir = temp(), g = createGateway({ dataDir: dir, nasAgent: { close() {}, ...bridge } });
  g.store.upsert(codex('one')); g.store.upsert(codex('two'));
  g.store.upsertGroup({ id: 'group', name: 'group', members: ['one', 'two'] });
  await new Promise(r => g.server.listen(0, '127.0.0.1', r));
  const send = () => fetch(`http://127.0.0.1:${g.server.address().port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer ' + g.store.gatewayKey(), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'group/m', input: 'PRIVATE PROMPT', stream: true }) });
  return { g, dir, send, async close() { await g.shutdown({ timeoutMs: 100 }); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('group failover streams text before completion and records one durable final result', { timeout: 5000 }, async () => {
  let finish, done = false;
  const gate = new Promise(r => { finish = r; }), calls = [];
  const ctx = await gateway({ usage: async () => ({ buckets: [] }), async run(p, m, b, e, signal, onEvent) {
    calls.push(p.id);
    if (p.id === 'one') throw new HttpError(429, 'usage limit');
    await onEvent({ type: 'text_delta', itemId: item.id, delta: 'LIVE' });
    await gate; done = true;
    await onEvent({ type: 'message_done', item }); return result();
  } });
  try {
    const response = await ctx.send(), reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
    while (!text.includes('response.output_text.delta')) { const part = await reader.read(); assert.equal(part.done, false); text += decoder.decode(part.value); }
    assert.equal(done, false, 'text reaches the HTTP client while inference is still running');
    finish(); for (;;) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value); }
    assert.equal((text.match(/event: response.created\n/g) || []).length, 1);
    assert.match(text, /response.completed/); assert.deepEqual(calls, ['one', 'two']);
    await ctx.g.journal.flush();
    const rows = new RequestJournal(ctx.dir).rows; assert.equal(rows.length, 1);
    assert.equal(rows[0].tokenMetrics.provider, 'two'); assert.equal(rows[0].tokenMetrics.completion, 'completed');
    assert.equal(rows[0].tokenMetrics.usage.inputTokens, 17); assert.equal(rows[0].tokenMetrics.usage.cachedInputTokens, 8);
    assert.ok(Number.isFinite(rows[0].tokenMetrics.firstTokenMs)); assert.equal(rows[0].tokenMetrics.attempts, 2);
    assert.equal(JSON.stringify(rows).includes('PRIVATE'), false);
  } finally { finish(); await ctx.close(); }
});

test('capacity failure after model output never switches accounts or replays the turn', async () => {
  const calls = [];
  const ctx = await gateway({ async run(p, m, b, e, signal, onEvent) {
    calls.push(p.id); await onEvent({ type: 'text_delta', itemId: item.id, delta: 'LIVE' }); throw new HttpError(502, 'Selected model is at capacity');
  } });
  try { const text = await (await ctx.send()).text(); assert.match(text, /response.failed/); assert.deepEqual(calls, ['one']); assert.equal(ctx.g.logs[0].tokenMetrics.completion, 'failed'); }
  finally { await ctx.close(); }
});

test('retry backoff is cancellable and expired retry windows cannot issue new attempts', async () => {
  const controller = new AbortController(), budget = retryBudget();
  const pending = retryDelay(budget, 1000, controller.signal); controller.abort();
  await assert.rejects(pending, e => e.status === 499);
  budget.deadline = Date.now() - 1; assert.equal(await retryDelay(budget, 0), false);
});

test('request journal survives restart, enforces bounds and discards arbitrary content', async () => {
  const dir = temp();
  try {
    const journal = new RequestJournal(dir, { maxEntries: 3, maxBytes: 4096 });
    for (let i = 0; i < 8; i++) journal.add({ requestId: String(i), status: 200, duration: 12, prompt: 'SECRET', error: 'SECRET', tokenMetrics: { prompt: 'SECRET', completion: 'completed', usage: { inputTokens: 2, outputTokens: 1 } } });
    await journal.flush(); const restored = new RequestJournal(dir, { maxEntries: 3, maxBytes: 4096 });
    assert.equal(restored.rows.length, 3); assert.equal(restored.rows[0].requestId, '7');
    assert.equal(restored.stats().inputTokens, 6); assert.equal(fs.readFileSync(restored.file, 'utf8').includes('SECRET'), false);
    assert.ok(fs.statSync(restored.file).size <= 4096);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=', 'base64');
const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
for (const [kind, Jobs, output] of [['images', ImageJobs, png], ['videos', VideoJobs, { bytes: mp4, ext: 'mp4' }]]) {
  test(`${kind}: cancellation, durable references, manual retry, pinning, pagination and exact cleanup preview`, async () => {
    const dir = temp(), providers = { get: () => ({ id: 'p', name: 'p', type: 'grok', enabled: true, timeout: 10, supportsImageInput: true }) };
    const execute = async (p, job, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const jobs = new Jobs({}, providers, dir, { execute }); let reloaded;
    try {
      const input = { providerId: 'p', prompt: 'boat', references: ['data:image/png;base64,' + png.toString('base64')] };
      const first = jobs.create(input), second = jobs.create(input);
      jobs.cancel(second.id); await wait(() => jobs.get(first.id).status === 'running'); jobs.cancel(first.id);
      await wait(() => !jobs.active); assert.equal(jobs.get(first.id).status, 'cancelled'); assert.equal(jobs.get(second.id).status, 'cancelled');
      assert.equal(jobs.get(first.id).references, undefined);
      jobs.close();
      let referencesSeen;
      reloaded = new Jobs({}, providers, dir, { execute: async (p, job) => { referencesSeen = job.references; return output; } });
      const retried = reloaded.retry(first.id); await wait(() => !reloaded.active && reloaded.get(retried.id).status === 'completed');
      assert.deepEqual(referencesSeen, input.references);
      reloaded.pin(retried.id, true); assert.throws(() => reloaded.remove(retried.id), /保留/);
      const page = reloaded.page({ offset: 1, limit: 1 }); assert.equal(page.total, 3); assert.equal(page.jobs.length, 1); assert.ok(page.storage.bytes > 0);
      const plan = reloaded.previewCleanup({ olderDays: 0 }); assert.equal(plan.jobs.length, 2); assert.ok(!plan.jobs.some(j => j.id === retried.id));
      // Jobs created after the preview are never swept by the existing token.
      const later = reloaded.create(input); await wait(() => reloaded.get(later.id).status === 'completed');
      assert.equal(reloaded.cleanup(plan.token).deleted, 2); assert.ok(reloaded.get(later.id)); assert.ok(reloaded.get(retried.id));
      assert.throws(() => reloaded.cleanup(plan.token), /过期/);
      reloaded.beginDrain(); assert.throws(() => reloaded.create(input), e => e.status === 503);
    } finally { jobs.close(); reloaded?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('graceful shutdown waits for active inference and flushes its completed record', { timeout: 5000 }, async () => {
  let finish, started = false;
  const gate = new Promise(r => { finish = r; });
  const ctx = await gateway({ async run(p, m, b, e, signal, onEvent) { started = true; await gate; assert.equal(signal.aborted, false); await onEvent({ type: 'message_done', item }); return result(); } });
  try {
    const response = await ctx.send(); await wait(() => started);
    const text = response.text(), shutdown = ctx.g.shutdown({ timeoutMs: 2000 });
    assert.throws(() => ctx.g.imageJobs.create({}), e => e.status === 503);
    finish(); assert.match(await text, /response.completed/); await shutdown;
    assert.equal(new RequestJournal(ctx.dir).rows[0].tokenMetrics.completion, 'completed');
  } finally { finish(); await ctx.close(); }
});
