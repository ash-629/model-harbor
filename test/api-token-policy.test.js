import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { optimizeApiPayload, tokenPolicy, usageMetrics } from '../src/api-token-policy.js';
import { createGateway } from '../src/server.js';
import { toResponses } from '../src/anthropic.js';
const tool = { type: 'function', name: 'read', description: 'description '.repeat(400), parameters: { type: 'object', properties: { path: { type: 'string', description: 'important', default: 'a', examples: ['b'], enum: ['a','b'] } }, required: ['path'], additionalProperties: false } };
const source = () => ({ model: 'p/m', tools: [structuredClone(tool)], input: [
  { role: 'user', content: 'original task' },
  { type: 'function_call', call_id: 'old', name: 'read', arguments: '{"path":"a"}' },
  { type: 'function_call_output', call_id: 'old', output: 'HEAD' + 'old data '.repeat(10000) + 'TAIL' },
  ...['one','two','three'].map(content => ({ role: 'user', content })),
  { type: 'function_call', call_id: 'new', name: 'read', arguments: '{}' },
  { type: 'function_call_output', call_id: 'new', output: 'recent data '.repeat(10000) }
] });
test('API policy is opt-in, validates bounds, and allows per-request bypass', () => {
  const b = source();
  assert.equal(optimizeApiPayload(b).payload, b);
  assert.equal(optimizeApiPayload(b, { enabled: true }, true).payload, b);
  for (const invalid of [[], { enabled: 'true' }, { oldToolResultChars: 0 }, { keepRecentUserTurns: 1 }, { captureStreamUsage: 1 }, { unexpected: true }]) assert.throws(() => tokenPolicy(invalid), e => e.status === 400);
});
test('trims only opted-in function descriptions and old paired string results, preserves schema and recent history', () => {
  const b = source(), original = structuredClone(b);
  b.tools.push({ type: 'custom', name: 'patch', description: 'grammar '.repeat(1000), format: { type: 'grammar', syntax: 'lark', definition: 'start: TEXT' } });
  const { payload, stats } = optimizeApiPayload(b, { enabled: true });
  assert.deepEqual(b.input, original.input);
  assert.ok(payload.tools[0].description.length <= 2000);
  assert.ok(payload.input[2].output.length <= 32768);
  assert.deepEqual(payload.tools[0].parameters, original.tools[0].parameters);
  assert.deepEqual(payload.tools[1], b.tools[1]);
  assert.match(payload.input[2].output, /^HEAD/); assert.match(payload.input[2].output, /TAIL$/); assert.match(payload.input[2].output, /characters omitted/);
  assert.deepEqual(payload.input.slice(3), b.input.slice(3));
  assert.deepEqual(stats.changes, { toolDescriptions: 1, oldToolResults: 1 });
  assert.ok(stats.after.requestBytes < stats.before.requestBytes);
});
test('preserves images, multimodal results, reasoning and single long tool loops', () => {
  const b = source(); b.input.splice(3, 3);
  b.input.push({ type: 'reasoning', encrypted_content: 'opaque' }, { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] });
  assert.deepEqual(optimizeApiPayload(b, { enabled: true }).payload.input, b.input);
  const multi = source(); multi.input[2].output = [{ type: 'input_image', image_url: 'https://example.test/a.png' }, { type: 'input_text', text: 'image metadata' }];
  assert.deepEqual(optimizeApiPayload(multi, { enabled: true }).payload.input, multi.input);
});
test('Messages thinking is omitted without disturbing ordered tool calls and their results', () => {
  const r = toResponses({ model: 'p/m', max_tokens: 50, messages: [
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thought' }, { type: 'tool_use', id: 'a', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'done' }] }
  ] });
  assert.deepEqual(r.input.map(i => i.type), ['function_call','function_call_output']);
  assert.equal(JSON.stringify(r).includes('secret thought'), false);
  assert.equal(r.input[1].call_id, 'a');
});
test('usage separates cached and reasoning values without inventing absent usage', () => {
  assert.equal(usageMetrics(), null);
  assert.equal(usageMetrics({ prompt_tokens: 50 }).cachedInputTokens, null);
  assert.deepEqual(usageMetrics({ prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 30, completion_tokens_details: { reasoning_tokens: 5 } }), { inputTokens: 50, outputTokens: 10, cachedInputTokens: 30, reasoningTokens: 5 });
});
test('real HTTP API routes expose numeric-only metrics for Chat, Responses and Messages, streamed or not', async () => {
  const received = [];
  const rawUsage = { prompt_tokens: 123, completion_tokens: 5, prompt_cache_hit_tokens: 64 };
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c; const b = JSON.parse(raw); received.push(b);
    if (b.model === 'fail') { res.writeHead(429); return res.end('{}'); }
    const native = req.url === '/responses';
    const usage = native ? { input_tokens: 123, output_tokens: 5, input_tokens_details: { cached_tokens: 64 } } : rawUsage;
    if (b.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (native) return res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage } }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }) + '\n\n');
      if (b.model !== 'no-usage') res.write('data: ' + JSON.stringify({ choices: [], usage }) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(native ? { status: 'completed', output: [], usage } : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-api-policy-')), g = createGateway({ dataDir: dir });
  const config = { id: 'p', type: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}`, models: ['m','fail','no-usage'], tokenOptimization: { enabled: true, captureStreamUsage: true } };
  g.store.upsert(config);
  g.store.upsert({ ...config, name: 'updated', tokenOptimization: undefined }, 'p');
  assert.equal(g.store.get('p').tokenOptimization.enabled, true);
  await new Promise(r => g.server.listen(0, '127.0.0.1', r));
  const send = (endpoint, body, headers = {}) => fetch(`http://127.0.0.1:${g.server.address().port}/v1/${endpoint}`, { method: 'POST', headers: { authorization: 'Bearer ' + g.store.gatewayKey(), 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    for (const protocol of ['chat','both']) {
      g.store.upsert({ ...config, protocol }, 'p');
      for (const endpoint of ['responses','chat/completions','messages']) for (const stream of [false,true]) {
        const common = { model: 'p/m', stream };
        const body = endpoint === 'responses' ? { ...source(), ...common } : endpoint === 'messages' ? { ...common, max_tokens: 32, system: 'PRIVATE RULE', messages: [{ role: 'user', content: 'PRIVATE PROMPT' }] } : { ...common, tools: [{ type: 'function', function: tool }], messages: [{ role: 'user', content: 'PRIVATE PROMPT' }] };
        const r = await send(endpoint, body); assert.equal(r.status, 200); await r.text();
        await new Promise(r => setImmediate(r));
        const metrics = g.logs[0].tokenMetrics;
        assert.equal(metrics.usage.inputTokens, 123); assert.equal(metrics.usage.cachedInputTokens, 64);
        assert.notEqual(metrics.completion, 'pending');
        assert.equal(JSON.stringify(metrics).includes('PRIVATE'), false);
        if (endpoint === 'responses') assert.deepEqual(metrics.changes, { toolDescriptions: 1, oldToolResults: 1 });
        if (stream && !received.at(-1).input) assert.equal(received.at(-1).stream_options.include_usage, true);
      }
    }
    await (await send('responses', source(), { 'x-model-harbor-optimize': 'off' })).text();
    assert.equal(g.logs[0].tokenMetrics.enabled, false); assert.equal(received.at(-1).tools[0].description, tool.description);
    const bad = await send('responses', { ...source(), model: 'p/fail' }); assert.equal(bad.status, 429); await bad.text();
    assert.equal(g.logs[0].tokenMetrics.completion, 'failed');
    g.store.upsert({ ...config, protocol: 'chat' }, 'p');
    await (await send('responses', { model: 'p/no-usage', input: 'test', stream: true })).text();
    await new Promise(r => setImmediate(r)); assert.equal(g.logs[0].tokenMetrics.usage, null);
    assert.equal(JSON.stringify(g.logs).includes('PRIVATE PROMPT'), false);
  } finally {
    g.server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => g.server.close(r)), new Promise(r => upstream.close(r))]); fs.rmSync(dir, { recursive: true, force: true });
  }
});
