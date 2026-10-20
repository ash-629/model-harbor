import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { extractUpstreamError, upstreamFetch } from '../src/upstream.js';
import {
  OPENCODE_GO_OPENAI_BASE,
  authorizeOpenCodeGo,
  classifyOpenCodeGoModel,
  classifyOpenCodeGoModels,
  discoverOpenCodeGo,
  openCodeSessionId,
  planOpenCodeGoProviders
} from '../src/opencode-go.js';

test('classifies documented and future OpenCode Go model IDs', () => {
  assert.equal(classifyOpenCodeGoModel('gpt-6-luna'), 'responses');
  assert.equal(classifyOpenCodeGoModel('grok-4.7'), 'responses');
  assert.equal(classifyOpenCodeGoModel('muse-spark-1.3-contributor'), 'responses');
  assert.equal(classifyOpenCodeGoModel('claude-haiku-5-5'), 'anthropic');
  assert.equal(classifyOpenCodeGoModel('qwen3.8-max'), 'anthropic');
  assert.equal(classifyOpenCodeGoModel('gemini-4-argon-contributor'), 'google');
  assert.equal(classifyOpenCodeGoModel('minimax-m3'), 'anthropic');
  assert.equal(classifyOpenCodeGoModel('minimax-m3.1-flash-free'), 'chat');
  assert.equal(classifyOpenCodeGoModel('glm-5.3'), 'chat');
  assert.equal(classifyOpenCodeGoModel('omen-alpha'), 'unknown');
  const groups = classifyOpenCodeGoModels(['gpt-6-luna', 'glm-5.3', 'qwen3.8-max', 'gemini-4-argon-contributor', 'omen-alpha', 'glm-5.3']);
  assert.deepEqual(groups.responses, ['gpt-6-luna']);
  assert.deepEqual(groups.chat, ['glm-5.3']);
  assert.deepEqual(groups.anthropic, ['qwen3.8-max']);
  assert.deepEqual(groups.google, ['gemini-4-argon-contributor']);
  assert.deepEqual(groups.unknown, ['omen-alpha']);
});

test('plans one merged provider with each model in its official family', () => {
  const plan = planOpenCodeGoProviders(['glm-5.3', 'gpt-6-luna', 'qwen3.8-max'], 'ocgo');
  assert.deepEqual(plan.providers.map(p => [p.id, p.protocol, p.models]), [['ocgo', 'both', ['glm-5.3', 'gpt-6-luna']]]);
  assert.equal(plan.providers[0].baseUrl, OPENCODE_GO_OPENAI_BASE);
  assert.equal(plan.providers[0].type, 'openai');
});

test('session ID is stable per conversation and forwards a client value', () => {
  const body = { instructions: 'system', input: [{ role: 'user', content: [{ type: 'input_text', text: 'first' }] }] };
  const first = openCodeSessionId(body), second = openCodeSessionId(body);
  assert.equal(first, second);
  assert.match(first, /^mh-[a-f0-9]{32}$/);
  assert.notEqual(first, openCodeSessionId({ instructions: 'system', input: 'second' }));
  assert.equal(openCodeSessionId(body, 'client-session-1'), 'client-session-1');
  assert.match(openCodeSessionId({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] }), /^mh-[a-f0-9]{32}$/);
});

test('authorize validates the key, creates one merged provider, and reuses it on the next run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ocgo-'));
  const store = new Store(dir);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [
        { id: 'glm-5.3' }, { id: 'gpt-6-luna' }, { id: 'qwen3.8-max' }, { id: 'omen-alpha' }
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'ok', choices: [{ message: { content: 'ok' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const first = await authorizeOpenCodeGo(store, { apiKey: 'sk-test', prefix: 'ocgo' }, { fetchImpl });
    assert.equal(first.providers.length, 1);
    assert.deepEqual(first.created, ['ocgo']);
    assert.deepEqual(first.providers[0].models, ['glm-5.3', 'gpt-6-luna']);
    assert.equal(first.groups.skipped.anthropic.includes('qwen3.8-max'), true);
    assert.equal(first.groups.skipped.unknown.includes('omen-alpha'), true);
    assert.equal(first.providers.every(p => p.hasApiKey), true);
    assert.equal(first.validation.ok, true);
    assert.equal(first.providers[0].protocol, 'both');

    const modelCall = calls.find(c => c.url.endsWith('/v1/models'));
    assert.equal(modelCall.headers.authorization, 'Bearer sk-test');
    const probeCall = calls.find(c => c.method === 'POST');
    assert.equal(probeCall.headers['x-opencode-session'].startsWith('mh-auth-'), true);
    assert.equal(probeCall.headers['user-agent'], 'model-harbor/0.1.0');

    const raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    assert.equal(raw.includes('sk-test'), false);

    const current = store.publicProvider(store.get('ocgo'));
    store.upsert({ ...current, name: 'My Go', enabled: false, timeout: 300, tokenOptimization: { enabled: true, captureStreamUsage: false } }, 'ocgo');

    const second = await authorizeOpenCodeGo(store, { apiKey: 'sk-test-2', prefix: 'ocgo' }, { fetchImpl });
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.updated, ['ocgo']);
    assert.equal(store.list().filter(p => p.id === 'ocgo' || p.id === 'ocgo-r').length, 1);
    assert.equal(store.unseal(store.get('ocgo').apiKey), 'sk-test-2');
    const chat = store.get('ocgo');
    assert.equal(chat.name, 'My Go');
    assert.equal(chat.enabled, false);
    assert.equal(chat.timeout, 300);
    assert.equal(chat.tokenOptimization.enabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenCode Go upstream 400 exposes a bounded sanitized reason', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ocgo-upstream-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const provider = { id: 'ocgo', name: 'OpenCode Go', type: 'openai', baseUrl: OPENCODE_GO_OPENAI_BASE, protocol: 'both', timeout: 600 };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Maximum context length exceeded. Bearer secret-token-value contact support' } }), { status: 400 }));
  await assert.rejects(upstreamFetch(store, provider, 'chat/completions', { model: 'deepseek-v4.1-flash', messages: [] }), error => {
    assert.equal(error.status, 400);
    assert.match(error.message, /Maximum context length exceeded/);
    assert.match(error.message, /Bearer \[redacted\]/);
    assert.equal(error.message.includes('secret-token-value'), false);
    return true;
  });
});

test('authorize rejects an invalid key before creating providers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ocgo-bad-'));
  const store = new Store(dir);
  const fetchImpl = async url => {
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'glm-5.3' }] }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: 'Invalid credential' } }), { status: 401 });
  };
  try {
    await assert.rejects(authorizeOpenCodeGo(store, { apiKey: 'bad', prefix: 'ocgo' }, { fetchImpl }), e => e.status === 401);
    assert.equal(store.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('authorize refuses to overwrite an unrelated provider with the same prefix', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ocgo-conflict-'));
  const store = new Store(dir);
  store.upsert({ id: 'ocgo', name: 'Other', type: 'openai', baseUrl: 'https://example.com/v1', protocol: 'chat', apiKey: 'x', models: ['m'] });
  const fetchImpl = async url => url.endsWith('/v1/models')
    ? new Response(JSON.stringify({ data: [{ id: 'glm-5.3' }] }), { status: 200 })
    : new Response('{}', { status: 200 });
  try {
    await assert.rejects(authorizeOpenCodeGo(store, { apiKey: 'sk-test', prefix: 'ocgo' }, { fetchImpl }), e => e.status === 409);
    assert.equal(store.get('ocgo').baseUrl, 'https://example.com/v1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discover filters by the provider protocol', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ocgo-discover-'));
  const store = new Store(dir);
  const fetchImpl = async () => new Response(JSON.stringify({ data: [
    { id: 'glm-5.3' }, { id: 'gpt-6-luna' }, { id: 'qwen3.8-max' }
  ] }), { status: 200 });
  try {
    const chat = { type: 'openai', baseUrl: OPENCODE_GO_OPENAI_BASE, protocol: 'chat', apiKey: store.seal('k') };
    assert.deepEqual(await discoverOpenCodeGo(store, chat, undefined, { fetchImpl }), ['glm-5.3']);
    assert.deepEqual(await discoverOpenCodeGo(store, { ...chat, protocol: 'responses' }, undefined, { fetchImpl }), ['gpt-6-luna']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});



test('OpenCode Go error body parser covers nested and plain shapes safely', () => {
  assert.equal(extractUpstreamError(JSON.stringify({ type: 'error', error: { type: 'ModelProtocolUnsupported', message: 'Model does not support this protocol.' } })), 'Model does not support this protocol.');
  assert.equal(extractUpstreamError(JSON.stringify({ error: { error: { message: 'nested twice' } } })), 'nested twice');
  assert.equal(extractUpstreamError(JSON.stringify({ message: 'plain json message' })), 'plain json message');
  assert.equal(extractUpstreamError('plain text reason'), 'plain text reason');
  assert.equal(extractUpstreamError('<html>not exposed</html>'), '');
  assert.equal(extractUpstreamError('Bad Bearer secret-token-value', ''), 'Bad Bearer [redacted]');
  assert.equal(extractUpstreamError('x'.repeat(1000)).length, 400);
});
