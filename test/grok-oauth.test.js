// Grok subscription OAuth: PKCE, token exchange, rotation, CLI identity and routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createGateway } from '../src/server.js';
import { upstreamFetch } from '../src/upstream.js';
import {
  GrokOAuth, createPkce, buildAuthorizeUrl, parseCallbackInput, cliProxyHeaders, grokCredential, tokenValue,
  GROK_CLIENT_ID, GROK_REDIRECT_URI, GROK_TOKEN_URL, GROK_CLI_BASE_URL
} from '../src/grok-oauth.js';

const tempStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-grok-'));
  return { dir, store: new Store(dir) };
};
const providerInput = over => ({ id: 'grokx', name: 'Grok 订阅', type: 'grok', models: ['grok-4.5'], timeout: 120, ...over });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function tokenPayload(over = {}) {
  return { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer', scope: 'openid', ...over };
}

test('PKCE challenge, authorize URL and callback parsing follow the xAI flow', () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  const url = new URL(buildAuthorizeUrl({ state: 'st', challenge, nonce: 'nn' }));
  assert.equal(url.origin + url.pathname, 'https://auth.x.ai/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), GROK_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), GROK_REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.match(url.searchParams.get('scope'), /grok-cli:access/);

  assert.deepEqual(parseCallbackInput('http://127.0.0.1:56121/callback?code=abc&state=xyz'), { code: 'abc', state: 'xyz' });
  assert.deepEqual(parseCallbackInput('?code=abc&state=xyz'), { code: 'abc', state: 'xyz' });
  assert.deepEqual(parseCallbackInput('  bare-code  '), { code: 'bare-code', state: '' });
  assert.deepEqual(parseCallbackInput(''), { code: '', state: '' });
});

test('Grok providers validate their host, mode and credential handling', () => {
  const { dir, store } = tempStore();
  try {
    const oauth = store.upsert(providerInput());
    assert.equal(oauth.type, 'grok');
    assert.equal(oauth.grokAuthMode, 'oauth');
    assert.equal(oauth.baseUrl, GROK_CLI_BASE_URL);
    assert.equal(oauth.protocol, 'both');
    assert.equal(oauth.grok.authorized, false);

    const keyed = store.upsert(providerInput({ id: 'grokkey', grokAuthMode: 'apiKey', apiKey: 'xai-key', baseUrl: 'https://api.x.ai/v1' }));
    assert.equal(keyed.baseUrl, 'https://api.x.ai/v1');
    assert.equal(keyed.hasApiKey, true);
    assert.equal(store.unseal(store.get('grokkey').apiKey), 'xai-key');

    assert.throws(() => store.upsert(providerInput({ id: 'bad1', baseUrl: 'https://evil.example/v1' })), /Grok Base URL/);
    assert.throws(() => store.upsert(providerInput({ id: 'bad2', baseUrl: 'http://cli-chat-proxy.grok.com/v1' })), /HTTPS/);
    assert.throws(() => store.upsert(providerInput({ id: 'bad3', baseUrl: 'https://cli-chat-proxy.grok.com/v1/responses' })), /Base URL/);
    assert.throws(() => store.upsert(providerInput({ id: 'bad4', grokAuthMode: 'password' })), /认证方式/);

    // Switching to OAuth drops any stored API key so only the sealed token is used.
    const switched = store.upsert(providerInput({ id: 'grokkey', grokAuthMode: 'oauth', baseUrl: GROK_CLI_BASE_URL, enabled: true }), 'grokkey');
    assert.equal(switched.hasApiKey, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('authorization stores sealed tokens, rejects replay and never exposes them', async () => {
  const { dir, store } = tempStore();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    return json(tokenPayload({ id_token: 'h.' + Buffer.from(JSON.stringify({ email: 'grok@example.com' })).toString('base64url') + '.s' }));
  };
  try {
    store.upsert(providerInput());
    const oauth = new GrokOAuth(store, { fetchImpl });
    const started = oauth.start('sess-1', 'grokx');
    assert.match(started.url, /state=/);
    const exchange = await oauth.exchange('sess-1', 'grokx', { callback: GROK_REDIRECT_URI + '?code=code-1&state=' + started.state });
    assert.equal(exchange.email, 'grok@example.com');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, GROK_TOKEN_URL);
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code'), 'code-1');
    assert.equal(form.get('client_id'), GROK_CLIENT_ID);
    assert.equal(form.get('redirect_uri'), GROK_REDIRECT_URI);
    assert.ok(form.get('code_verifier'));

    const saved = store.get('grokx');
    assert.ok(!JSON.stringify(store.list().find(p => p.id === 'grokx')).includes('at-1'));
    assert.equal(JSON.parse(store.unseal(store.data.grokAuth[saved.grokAuthId])).access, 'at-1');
    assert.equal(store.list().find(p => p.id === 'grokx').grok.authorized, true);

    await assert.rejects(oauth.exchange('sess-1', 'grokx', { callback: GROK_REDIRECT_URI + '?code=code-1&state=' + started.state }), /重新开始授权/);
    await assert.rejects(oauth.exchange('other', 'grokx', { callback: 'http://127.0.0.1:56121/callback?code=x&state=missing' }), /授权会话已过期/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('expired credentials refresh once with rotation and 401 marks the account invalid', async () => {
  const { dir, store } = tempStore();
  const originalFetch = globalThis.fetch;
  const seen = [];
  try {
    store.upsert(providerInput());
    store.setGrokAuth('grokx', 'auth-1');
    store.data.grokAuth['auth-1'] = store.seal(JSON.stringify({ access: 'stale', refresh: 'rt-old', expires: Date.now() - 1000, email: '' }));
    store.save();
    globalThis.fetch = async (url, init = {}) => {
      seen.push({ url: String(url), body: init.body ? new URLSearchParams(init.body) : null, headers: init.headers || {} });
      if (String(url) === GROK_TOKEN_URL) return json(tokenPayload({ access_token: 'at-2', refresh_token: 'rt-2' }));
      return json({ data: [{ id: 'grok-4.5' }] });
    };
    const provider = store.get('grokx');
    const first = await upstreamFetch(store, provider, 'models');
    await first.body.cancel();
    const refresh = seen[0];
    assert.equal(refresh.url, GROK_TOKEN_URL);
    assert.equal(refresh.body.get('grant_type'), 'refresh_token');
    assert.equal(refresh.body.get('refresh_token'), 'rt-old');
    const stored = JSON.parse(store.unseal(store.data.grokAuth['auth-1']));
    assert.equal(stored.access, 'at-2');
    assert.equal(stored.refresh, 'rt-2');
    const upstreamCall = seen[1];
    assert.match(upstreamCall.url, /^https:\/\/cli-chat-proxy\.grok\.com\/v1\/models$/);
    assert.equal(upstreamCall.headers.authorization, 'Bearer at-2');
    assert.equal(upstreamCall.headers['x-xai-token-auth'], 'xai-grok-cli');
    assert.match(upstreamCall.headers['x-grok-client-version'], /^\d+\.\d+\.\d+$/);
    assert.equal(upstreamCall.headers['x-grok-client-identifier'], 'grok-pager');

    globalThis.fetch = async () => json({ error: { message: 'bad token' } }, 401);
    store.data.grokAuth['auth-1'] = store.seal(JSON.stringify({ access: 'fresh', refresh: 'rt-2', expires: Date.now() + 600000 }));
    store.save();
    await assert.rejects(upstreamFetch(store, store.get('grokx'), 'models'), error => error.status === 401 && error.code === 'grok_needs_auth');

    globalThis.fetch = async () => json({ error: 'invalid_grant' }, 400);
    store.data.grokAuth['auth-1'] = store.seal(JSON.stringify({ access: 'stale', refresh: 'rt-2', expires: Date.now() - 1000 }));
    store.save();
    await assert.rejects(grokCredential(store, store.get('grokx')), error => error.status === 401 && error.code === 'grok_needs_auth');
    assert.equal(JSON.parse(store.unseal(store.data.grokAuth['auth-1'])).invalid, true);
  } finally { globalThis.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI identity headers apply only to the subscription proxy', () => {
  assert.deepEqual(cliProxyHeaders('api.x.ai'), {});
  assert.deepEqual(cliProxyHeaders('auth.x.ai'), {});
  const headers = cliProxyHeaders('cli-chat-proxy.grok.com');
  assert.equal(headers['x-grok-client-mode'], 'interactive');
  assert.equal(headers['x-authenticateresponse'], 'authenticate-response');
  assert.match(headers['user-agent'], /^grok-pager\//);
});

test('token responses require complete credentials', () => {
  assert.throws(() => tokenValue({ refresh_token: 'r', expires_in: 10 }), /访问令牌/);
  assert.throws(() => tokenValue({ access_token: 'a', expires_in: 10 }), /刷新令牌/);
  assert.throws(() => tokenValue({ access_token: 'a', refresh_token: 'r', expires_in: 0 }), /有效期/);
  const kept = tokenValue({ access_token: 'a2', expires_in: 60 }, { refresh: 'r-old', email: 'x@y.z' });
  assert.equal(kept.refresh, 'r-old');
  assert.equal(kept.email, 'x@y.z');
});

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test('admin API drives the authorization flow and hides the tokens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-grok-api-'));
  const { server } = createGateway({ dataDir: dir, publicUrl: 'http://192.0.2.10:8317', adminPassword: 'test-password' });
  const base = await listen(server);
  const originalFetch = globalThis.fetch;
  try {
    const basic = { authorization: 'Basic ' + Buffer.from('admin:test-password').toString('base64') };
    const session = await fetch(base + '/api/session', { headers: basic });
    const cookie = session.headers.get('set-cookie').split(';')[0], { csrf } = await session.json();
    const admin = (url, method = 'GET', body) => fetch(base + '/api' + url, {
      method, headers: { ...basic, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    assert.equal((await admin('/providers', 'POST', providerInput())).status, 201);
    const start = await (await admin('/providers/grokx/grok/oauth/start', 'POST', {})).json();
    assert.match(start.url, /^https:\/\/auth\.x\.ai\/oauth2\/authorize\?/);
    assert.equal(start.redirectUri, GROK_REDIRECT_URI);

    // Delegate gateway traffic to the real fetch; stub only the xAI token endpoint.
    globalThis.fetch = async (url, init) => String(url).startsWith(base) ? originalFetch(url, init) : json(tokenPayload());
    const exchanged = await admin('/providers/grokx/grok/oauth/exchange', 'POST', { callback: GROK_REDIRECT_URI + '?code=abc&state=' + start.state });
    assert.equal(exchanged.status, 200);
    const payload = await exchanged.json();
    assert.equal(payload.provider.grok.authorized, true);
    const config = await (await admin('/config')).text();
    assert.ok(!config.includes('at-1'));
    assert.ok(!config.includes('rt-1'));

    const revoked = await (await admin('/providers/grokx/grok/oauth/revoke', 'POST', {})).json();
    assert.equal(revoked.grok.authorized, false);
  } finally {
    globalThis.fetch = originalFetch;
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gateway chat requests reach the subscription proxy with CLI identity headers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-grok-chat-'));
  const seeded = new Store(dir);
  seeded.upsert(providerInput());
  seeded.setGrokAuth('grokx', 'auth-1');
  seeded.data.grokAuth['auth-1'] = seeded.seal(JSON.stringify({ access: 'at-1', refresh: 'rt-1', expires: Date.now() + 600000, email: '' }));
  seeded.save();
  const gatewayKey = seeded.gatewayKey();
  const { server } = createGateway({ dataDir: dir, publicUrl: 'http://192.0.2.10:8317', adminPassword: 'test-password' });
  const base = await listen(server);
  const originalFetch = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).startsWith(base)) return originalFetch(url, init);
      seen.push({ url: String(url), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
      return json({ id: 'chatcmpl-1', object: 'chat.completion', model: 'grok-4.5', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    };
    const response = await originalFetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + gatewayKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grokx/grok-4.5', messages: [{ role: 'user', content: 'ping' }] })
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.choices[0].message.content, 'pong');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://cli-chat-proxy.grok.com/v1/chat/completions');
    assert.equal(seen[0].headers.authorization, 'Bearer at-1');
    assert.equal(seen[0].headers['x-grok-client-identifier'], 'grok-pager');
    assert.equal(seen[0].body.model, 'grok-4.5');
  } finally {
    globalThis.fetch = originalFetch;
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bare authorization code uses the newest pending session and survives restarts', async () => {
  const { dir, store } = tempStore();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    return json(tokenPayload({ access_token: 'at-bare', refresh_token: 'rt-bare' }));
  };
  try {
    store.upsert(providerInput());
    const started = new GrokOAuth(store, { fetchImpl }).start('sess-1', 'grokx');
    assert.ok(JSON.parse(store.unseal(store.data.grokPending))[started.state], 'pending session is persisted sealed');

    // A fresh instance (as after a restart) restores the pending PKCE verifier.
    const restarted = new GrokOAuth(store, { fetchImpl });
    const result = await restarted.exchange('other-session', 'grokx', { callback: '7hqQxFDuZdJMwrVRpIUsVwIlZh-bare-code' });
    assert.equal(result.provider.grok.authorized, true);
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.get('code'), '7hqQxFDuZdJMwrVRpIUsVwIlZh-bare-code');
    assert.ok(form.get('code_verifier'));
    assert.equal(store.data.grokPending, '');

    await assert.rejects(restarted.exchange('other-session', 'grokx', { callback: 'another-code' }), /先点「开始授权」/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Grok Responses requests drop unsupported items and restore custom tools', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-grok-resp-'));
  const seeded = new Store(dir);
  seeded.upsert(providerInput({ models: ['grok-4.7'] }));
  seeded.setGrokAuth('grokx', 'auth-1');
  seeded.data.grokAuth['auth-1'] = seeded.seal(JSON.stringify({ access: 'at-1', refresh: 'rt-1', expires: Date.now() + 600000, email: '' }));
  seeded.save();
  const gatewayKey = seeded.gatewayKey();
  const { server } = createGateway({ dataDir: dir, publicUrl: 'http://192.0.2.10:8317', adminPassword: 'test-password' });
  const base = await listen(server);
  const originalFetch = globalThis.fetch;
  let captured = null;
  try {
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).startsWith(base)) return originalFetch(url, init);
      captured = JSON.parse(init.body);
      return json({
        id: 'resp_1', object: 'response', model: 'grok-4.7', status: 'completed',
        output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' }]
      });
    };
    const response = await originalFetch(base + '/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + gatewayKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'grokx/grok-4.7',
        input: [
          { type: 'item_reference', id: 'msg_1' },
          { type: 'reasoning', id: null, status: null, content: null, summary: [{ type: 'summary_text', text: 'prior work' }] },
          { type: 'message', role: 'assistant', content: null },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
        ],
        tools: [{ type: 'custom', name: 'apply_patch', description: 'apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } }],
        metadata: { trace: 'x' },
        stream: false
      })
    });
    assert.equal(response.status, 200);
    assert.equal('metadata' in captured, false);
    assert.equal(captured.input.length, 3);
    const [reasoning, assistant, user] = captured.input;
    assert.equal(reasoning.type, 'reasoning');
    assert.equal('content' in reasoning, false);
    assert.equal('id' in reasoning, false);
    assert.equal('status' in reasoning, false);
    assert.deepEqual(reasoning.summary, [{ type: 'summary_text', text: 'prior work' }]);
    assert.deepEqual(assistant.content, []);
    assert.equal(user.content[0].text, 'hi');
    assert.equal(captured.tools[0].type, 'function');
    assert.equal(captured.tools[0].name, 'apply_patch');
    assert.deepEqual(captured.tools[0].parameters.properties.input, { type: 'string' });
    const data = await response.json();
    assert.equal(data.output[0].type, 'custom_tool_call');
    assert.equal(data.output[0].input, '*** Begin Patch');

    globalThis.fetch = async (url, init = {}) => {
      if (String(url).startsWith(base)) return originalFetch(url, init);
      return json({ error: 'Failed to deserialize the JSON body: tools[0].type: unknown variant `custom`' }, 422);
    };
    const failed = await originalFetch(base + '/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + gatewayKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grokx/grok-4.7', input: 'hi', stream: false })
    });
    assert.equal(failed.status, 422);
    const payload = await failed.json();
    assert.match(payload.error.message, /上游详情/);
    assert.match(payload.error.message, /unknown variant/);
  } finally {
    globalThis.fetch = originalFetch;
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('streamed Grok custom tool calls keep the rewritten SSE event name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-grok-sse-'));
  const seeded = new Store(dir);
  seeded.upsert(providerInput({ models: ['grok-4.7'] }));
  seeded.setGrokAuth('grokx', 'auth-1');
  seeded.data.grokAuth['auth-1'] = seeded.seal(JSON.stringify({ access: 'at-1', refresh: 'rt-1', expires: Date.now() + 600000, email: '' }));
  seeded.save();
  const gatewayKey = seeded.gatewayKey();
  const { server } = createGateway({ dataDir: dir, publicUrl: 'http://192.0.2.10:8317', adminPassword: 'test-password' });
  const base = await listen(server);
  const originalFetch = globalThis.fetch;
  try {
    const events = [
      { type: 'response.created', response: { id: 'resp_1', model: 'grok-4.7', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'apply_patch', arguments: '', call_id: 'call_1', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"input":"*** Begin Patch"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{"input":"*** Begin Patch"}' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}', call_id: 'call_1', status: 'completed' } },
      { type: 'response.completed', response: { id: 'resp_1', model: 'grok-4.7', status: 'completed', output: [{ id: 'fc_1', type: 'function_call', name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}', call_id: 'call_1' }] } }
    ];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).startsWith(base)) return originalFetch(url, init);
      const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const response = await originalFetch(base + '/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + gatewayKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'grokx/grok-4.7',
        input: 'hi',
        tools: [{ type: 'custom', name: 'apply_patch', description: 'patch' }],
        stream: true
      })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: response\.custom_tool_call_input\.done/);
    assert.match(text, /"type":"response\.custom_tool_call_input\.done"/);
    assert.doesNotMatch(text, /event: response\.function_call_arguments\.done/);
    assert.match(text, /"type":"custom_tool_call"/);
  } finally {
    globalThis.fetch = originalFetch;
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
