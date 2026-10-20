import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactionFallback, route } from '../src/upstream.js';
import { OPENCODE_GO_OPENAI_BASE } from '../src/opencode-go.js';

test('compaction fallback preserves visible history and summaries without leaking ciphertext or mutating input', () => {
  const message = { role: 'user', content: 'continue' };
  const body = { input: [{ type: 'compaction', encrypted_content: 'private', summary: [{ type: 'summary_text', text: 'Keep task state' }] }, { type: 'compaction', encrypted_content: 'opaque' }, message], tools: [] };
  const saved = structuredClone(body), result = compactionFallback(body);
  assert.equal(result.count, 2); assert.equal(result.missing, 1);
  assert.equal(result.payload.input[0].content[0].text, 'Keep task state');
  assert.match(result.payload.input[1].content[0].text, /history is unavailable/);
  assert.equal(result.payload.input[2], message);
  assert.equal(JSON.stringify(result.payload).includes('encrypted_content'), false);
  assert.deepEqual(body, saved);
  assert.equal(compactionFallback({ input: 'hi' }), null);
  assert.equal(compactionFallback({ input: [message] }), null);
});

test('OpenCode retries rejected compaction once, preserves valid blobs and does not retry unrelated errors', async t => {
  const provider = { id: 'ocgo', name: 'OpenCode Go', type: 'openai', baseUrl: OPENCODE_GO_OPENAI_BASE, protocol: 'both' };
  const body = { model: 'ocgo/grok-4.6', input: [{ type: 'compaction', encrypted_content: 'foreign-blob' }, { role: 'user', content: 'hi' }] };
  const store = { unseal: () => '' }, calls = [];
  let mode = 'fallback';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(JSON.parse(options.body));
    if (mode === 'valid' || ['fallback', 'decrypt'].includes(mode) && calls.length === 2) return new Response(JSON.stringify({ output: [], status: 'completed' }));
    return new Response(JSON.stringify({ error: { message: mode === 'unrelated' ? 'other error' : mode === 'decrypt' ? 'Could not decrypt the provided encrypted_content.' : 'Could not decode the compaction blob. Ensure it is unmodified from the compact response.' } }), { status: 400 });
  });
  const run = res => route(store, provider, 'grok-4.6', body, 'responses', res);
  const res = {};
  await run(res);
  assert.equal(calls.length, 2); assert.equal(calls[0].input[0].type, 'compaction');
  assert.equal(calls[1].input[0].type, 'message'); assert.deepEqual(calls[1].input[1], body.input[1]);
  assert.deepEqual(res.apiMetrics.compactionFallback, { count: 1, missing: 1 });
  mode = 'decrypt'; calls.length = 0; await run({}); assert.equal(calls.length, 2);
  mode = 'valid'; calls.length = 0; await run({});
  assert.equal(calls.length, 1); assert.equal(calls[0].input[0].encrypted_content, 'foreign-blob');
  mode = 'unrelated'; calls.length = 0; await assert.rejects(run({}), /other error/); assert.equal(calls.length, 1);
  mode = 'always-fail'; calls.length = 0; await assert.rejects(run({}), /Could not decode/); assert.equal(calls.length, 2);
});

test('encrypted reasoning and mixed compaction are portable without losing visible messages or tool pairs', () => {
  const pair = [{ type: 'function_call', name: 'probe', call_id: 'a', arguments: '{}' }, { type: 'function_call_output', call_id: 'a', output: 'done' }];
  const body = { input: [
    { type: 'reasoning', encrypted_content: 'opaque', summary: [] },
    { type: 'reasoning', encrypted_content: 'opaque-2', summary: [{ type: 'summary_text', text: 'Visible reasoning summary' }] },
    { type: 'compaction', encrypted_content: 'compact' },
    ...pair, { role: 'user', content: 'Continue' }
  ] };
  const before = structuredClone(body), result = compactionFallback(body);
  assert.equal(result.count, 3);
  assert.equal(result.payload.input.length, 5);
  assert.equal(result.payload.input[0].content[0].text, 'Visible reasoning summary');
  assert.match(result.payload.input[1].content[0].text, /history is unavailable/);
  assert.deepEqual(result.payload.input.slice(2, 4), pair);
  assert.equal(JSON.stringify(result.payload).includes('encrypted_content'), false);
  assert.deepEqual(body, before);
});

test('reasoning-only history retries the exact compaction decode error once', async t => {
  const provider = { id: 'ocgo', name: 'OpenCode Go', type: 'openai', baseUrl: OPENCODE_GO_OPENAI_BASE, protocol: 'both' };
  const body = { model: 'ocgo/grok-4.6', input: [{ type: 'reasoning', encrypted_content: 'foreign', summary: [] }, { role: 'user', content: 'hi' }] };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const payload = JSON.parse(options.body); calls.push(payload);
    return payload.input.some(item => item.encrypted_content)
      ? new Response(JSON.stringify({ error: { message: 'Could not decode the compaction blob. Ensure it is unmodified from the compact response.' } }), { status: 400 })
      : new Response(JSON.stringify({ status: 'completed', output: [] }));
  });
  await route({ unseal: () => '' }, provider, 'grok-4.6', body, 'responses', {});
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].input, [body.input[1]]);
  assert.equal(body.input[0].encrypted_content, 'foreign');
});
