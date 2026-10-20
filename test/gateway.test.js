// F-01..06/R-01..04: real HTTP integration against controllable upstreams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/server.js';
import { Store } from '../src/store.js';
import { toChat, sseEvents } from '../src/protocol.js';
import { nasCompletion } from '../src/nas.js';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test('LAN deployment requires a password and protects administration separately from Bearer API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-lan-'));
  assert.throws(() => createGateway({ dataDir: dir, publicUrl: 'http://192.0.2.10:8317' }), /PASSWORD/);
  const { server, store } = createGateway({ dataDir: dir, publicUrl: 'http://192.0.2.10:8317', adminPassword: 'test-password' });
  const base = await listen(server);
  const headers = { authorization: 'Basic ' + Buffer.from('admin:test-password').toString('base64') };
  try {
    for (const endpoint of ['/', '/app.js', '/api/session', '/api/key']) assert.equal((await fetch(base + endpoint)).status, 401);
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/', { headers })).status, 200);
    assert.equal((await fetch(base + '/v1/models', { headers })).status, 401);
    assert.equal((await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + store.gatewayKey() } })).status, 200);
    const session = await fetch(base + '/api/session', { headers });
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const config = await (await fetch(base + '/api/config', { headers: { ...headers, cookie } })).json();
    assert.equal(config.baseUrl, 'http://192.0.2.10:8317/v1');
    const requestHost = host => new Promise(resolve => http.get(base + '/health', { headers: { host } }, res => { res.resume(); resolve(res.statusCode); }));
    assert.equal(await requestHost('192.0.2.10:8317'), 200);
    assert.equal(await requestHost('evil.example:8317'), 403);
  } finally { await close(server); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP gateway: authentication, CRUD, isolation, routes, streaming, functions, persistence and cancellation', async t => {
  const received = []; let cancelled;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    received.push({ path: req.url, body, auth: req.headers.authorization });
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'shared-model' }, { id: 'other-model' }] })); }
    if (body.model === 'rate-limit') { res.writeHead(429, { 'retry-after': '3' }); return res.end('{"error":{"message":"secret-key-must-not-leak"}}'); }
    if (body.model === 'slow') { cancelled = new Promise(resolve => res.on('close', resolve)); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[{"index":0,"delta":{"content":"start"}}]}\n\n'); return; }
    const tools = body.messages?.at(-1)?.content === 'tool';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.url === '/v1/responses') {
        res.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: { id: 'resp_native', model: body.model } }) + '\n\n');
        return res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_native', model: body.model, output: [] } }) + '\n\n');
      }
      const deltas = tools ? [{ tool_calls: [{ index: 0, id: 'call_123', type: 'function', function: { name: 'weather', arguments: '{"city":' } }] }, { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }] : [{ role: 'assistant', content: '你好' }, { content: '，世界' }];
      for (const delta of deltas) res.write('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: null }] }) + '\r\n\r\n');
      if (body.model !== 'broken') res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }) + '\n\n');
      return res.end(body.model === 'broken' ? '' : 'data: [DONE]\n\n');
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/responses') return res.end(JSON.stringify({ object: 'response', model: body.model, output: [{ type: 'message', content: [{ type: 'output_text', text: 'native' }] }] }));
    res.end(JSON.stringify({ id: 'chatcmpl_mock', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: tools ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }] } : { role: 'assistant', content: '你好，世界' }, finish_reason: tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }));
  });
  const upstreamURL = await listen(upstream), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-test-'));
  const { server, store, logs } = createGateway({ dataDir: dir }); const base = await listen(server);
  const sessionResponse = await fetch(base + '/api/session');
  const cookie = sessionResponse.headers.get('set-cookie').split(';')[0], { csrf } = await sessionResponse.json();
  const admin = (url, method = 'GET', body) => fetch(base + '/api' + url, { method, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const api = (url, body, options = {}) => fetch(base + '/v1' + url, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + store.gatewayKey(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, ...options });
  try {
    await t.test('local administration protection and gateway authentication', async () => {
      assert.equal((await fetch(base + '/api/config')).status, 401);
      assert.equal((await fetch(base + '/v1/models')).status, 401);
      assert.equal((await fetch(base + '/api/session', { headers: { origin: 'https://evil.example' } })).status, 403);
      const hostStatus = await new Promise(resolve => http.get(base + '/api/session', { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }));
      assert.equal(hostStatus, 403);
      assert.equal((await fetch(base + '/api/providers', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
      assert.equal((await fetch(base + '/')).status, 200);
      assert.match((await fetch(base + '/')).headers.get('content-security-policy'), /frame-ancestors 'none'/);
    });
    const config = { id: 'a', name: 'Provider A', baseUrl: upstreamURL + '/v1', apiKey: 'upstream-test-key', models: [], protocol: 'chat' };
    await t.test('create, discover, mask credentials, encrypt disk, and prevent duplicates', async () => {
      assert.equal((await admin('/providers', 'POST', config)).status, 201);
      assert.equal((await admin('/providers', 'POST', config)).status, 409);
      const refreshed = await (await admin('/providers/a/refresh', 'POST')).json(); assert.equal(refreshed.models.length, 2);
      assert.equal(refreshed.apiKey, undefined); assert.equal(refreshed.hasApiKey, true);
      assert.equal(fs.readFileSync(store.file, 'utf8').includes('upstream-test-key'), false);
      assert.equal(fs.readFileSync(store.file, 'utf8').includes(store.gatewayKey()), false);
      assert.equal(received.at(-1).auth, 'Bearer upstream-test-key');
      const invalid = await admin('/providers', 'POST', { ...config, id: 'bad', baseUrl: upstreamURL + '/v1/chat/completions' }); assert.equal(invalid.status, 400);
      assert.equal(new Store(dir).gatewayKey(), store.gatewayKey());
    });
    await t.test('cross-provider model names, preserving model IDs and upstream keys', async () => {
      await admin('/providers', 'POST', { ...config, id: 'b', models: ['shared-model'], protocol: 'both' });
      const list = await (await api('/models')).json(); assert.ok(list.data.some(m => m.id === 'a/shared-model')); assert.ok(list.data.some(m => m.id === 'b/shared-model'));
      for (const id of ['a', 'b']) {
        const result = await (await api('/chat/completions', { model: `${id}/shared-model`, messages: [{ role: 'user', content: 'hello' }] })).json();
        assert.equal(result.model, `${id}/shared-model`); assert.equal(received.at(-1).body.model, 'shared-model');
      }
      assert.equal((await api('/chat/completions', { model: 'unknown' })).status, 404);
      assert.equal((await api('/responses', { model: 'a/shared-model', input: 'hi', previous_response_id: 'x' })).status, 400);
      assert.equal((await api('/responses', { model: 'a/shared-model', input: 'hi', tools: [{ type: 'custom', name: 'apply_patch' }] })).status, 200);
      assert.deepEqual(received.at(-1).body.tools[0].function.parameters.required, ['input']);
    });
    await t.test('nonstream and SSE text Responses conversion with usage', async () => {
      const body = { model: 'a/shared-model', input: 'hello' };
      const result = await (await api('/responses', body)).json(); assert.equal(result.output[0].content[0].text, '你好，世界'); assert.equal(result.usage.total_tokens, 7);
      const stream = await api('/responses', { ...body, stream: true }); const events = [];
      for await (const e of sseEvents(stream.body)) events.push(JSON.parse(e.data));
      assert.equal(events[0].type, 'response.created'); assert.equal(events.at(-1).type, 'response.completed');
      assert.equal(events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''), '你好，世界');
      assert.equal(events.at(-1).response.model, 'a/shared-model'); assert.equal(events.at(-1).response.usage.total_tokens, 7);
      assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
    });
    await t.test('function streaming and tool result round trip', async () => {
      const response = await api('/responses', { model: 'a/shared-model', input: 'tool', stream: true, tools: [{ type: 'function', name: 'weather', parameters: { type: 'object' } }] });
      const events = []; for await (const e of sseEvents(response.body)) events.push(JSON.parse(e.data));
      const call = events.at(-1).response.output[0]; assert.equal(call.call_id, 'call_123'); assert.equal(call.arguments, '{"city":"Paris"}');
      const result = await api('/responses', { model: 'a/shared-model', input: [{ type: 'function_call', ...call }, { type: 'function_call_output', call_id: call.call_id, output: 'sunny' }] });
      assert.equal(result.status, 200); assert.equal(received.at(-1).body.messages[0].tool_calls[0].id, 'call_123'); assert.equal(received.at(-1).body.messages[1].tool_call_id, 'call_123');
    });
    await t.test('native protocols pass through and retain public model names', async () => {
      const chat = await api('/chat/completions', { model: 'a/shared-model', messages: [{ role: 'user', content: 'hi' }], stream: true });
      const text = await chat.text(); assert.match(text, /a\/shared-model/); assert.match(text, /\[DONE\]/);
      const native = await api('/responses', { model: 'b/shared-model', input: 'hi', stream: true });
      const s = await native.text(); assert.match(s, /event: response.completed/); assert.match(s, /b\/shared-model/); assert.equal(received.at(-1).path, '/v1/responses');
    });
    await t.test('upstream errors, truncated streams, cancellation, no prompt logging', async () => {
      await admin('/providers/a', 'PUT', { ...config, models: ['rate-limit', 'broken', 'slow', 'shared-model'] });
      const err = await api('/chat/completions', { model: 'a/rate-limit', messages: [] }); assert.equal(err.status, 429); assert.equal(err.headers.get('retry-after'), '3'); assert.equal((await err.text()).includes('secret-key'), false);
      const broken = await api('/responses', { model: 'a/broken', input: 'hello', stream: true }); assert.match(await broken.text(), /上游流意外结束/);
      const ac = new AbortController();
      const slow = await api('/chat/completions', { model: 'a/slow', messages: [], stream: true }, { signal: ac.signal });
      const reader = slow.body.getReader(); await reader.read(); ac.abort();
      await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream cancellation did not propagate')), 2000).unref())]);
      assert.equal(logs.some(l => 'messages' in l || 'prompt' in l), false);
    });
    await t.test('management test, disable, secret preservation, delete', async () => {
      const result = await (await admin('/test', 'POST', { model: 'b/shared-model', prompt: 'hi' })).json(); assert.equal(result.text, '你好，世界');
      await admin('/providers/b', 'PUT', { ...config, id: 'b', apiKey: '', enabled: false, models: ['shared-model'] });
      assert.equal(store.unseal(store.get('b').apiKey), 'upstream-test-key');
      assert.equal((await api('/chat/completions', { model: 'b/shared-model' })).status, 404);
      await admin('/providers/b', 'DELETE'); assert.throws(() => store.get('b'));
    });
  } finally { await close(server); await close(upstream); fs.rmSync(dir, { recursive: true }); }
});

test('NAS rejects tools, image inputs and unsupported parameters before executing SSH', async () => {
  for (const extra of [{ tools: [{ type: 'function' }] }, { temperature: 0.5 }, { messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }]) {
    await assert.rejects(nasCompletion({}, 'test', { messages: [{ role: 'user', content: 'hi' }], ...extra }), e => e.status === 400);
  }
});
test('Responses mapping retains instructions, images, grouped calls and structured output', () => {
  const mapped = toChat({ model: 'p/m', instructions: 'system', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }, { type: 'function_call', call_id: 'a', name: 'x', arguments: '{}' }, { type: 'function_call', call_id: 'b', name: 'x', arguments: '{}' }], text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } } });
  assert.equal(mapped.messages[0].role, 'system'); assert.equal(mapped.messages[1].content[0].image_url.url, 'https://example.com/a.png'); assert.equal(mapped.messages[2].tool_calls.length, 2); assert.equal(mapped.response_format.json_schema.name, 'answer');
});
test('SSE parser handles split UTF-8, CRLF and multiline data', async () => {
  const bytes = Buffer.from('event: chunk\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: [DONE]\n\n');
  async function* fragments() { for (const byte of bytes) yield Buffer.from([byte]); }
  const events = []; for await (const event of sseEvents(fragments())) events.push(event);
  assert.equal(events[0].event, 'chunk'); assert.equal(JSON.parse(events[0].data).text, '你好'); assert.equal(events[1].data, '[DONE]');
});
