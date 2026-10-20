import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { OpenCodeGoAuth, openCodeGoCredential } from '../src/opencode-go-auth.js';
import { OPENCODE_GO_OPENAI_BASE } from '../src/opencode-go.js';
import { upstreamFetch, discover } from '../src/upstream.js';

const response = (data, status = 200) => Response.json(data, { status });
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-device-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), calls = [];
  let time = Date.now(), tokenStatus = 'authorization_pending';
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, options, body });
    if (overrides.fetchImpl) return overrides.fetchImpl(url, options, body);
    if (url.endsWith('/device/code')) return response({ device_code: 'device-private', user_code: 'ABCD-EFGH',
      verification_uri_complete: '/console/device?user_code=ABCD-EFGH', expires_in: 600, interval: 5 });
    if (url.endsWith('/device/token')) return tokenStatus === 'success'
      ? response({ access_token: 'access-private', refresh_token: 'refresh-private', expires_in: 3600, org_id: 'org-test' })
      : response({ error: tokenStatus }, 400);
    if (url.endsWith('/api/v2/config')) return response({ providers: {
      go: { settings: { baseURL: OPENCODE_GO_OPENAI_BASE }, models: { 'glm-5.3': {}, 'gpt-6-luna': {}, 'qwen3.8-max': {}, 'kimi-k3': { disabled: true } } },
      other: { settings: { baseURL: 'https://other.example/v1' }, models: { 'not-go': {} } }
    } });
    throw new Error('Unexpected URL');
  };
  const auth = new OpenCodeGoAuth(store, { fetchImpl, now: () => time });
  return { dir, store, auth, calls, fetchImpl, advance: (ms = 5000) => { time += ms; }, approve: () => { tokenStatus = 'success'; }, status: v => { tokenStatus = v; } };
}

test('device flow waits, binds owner, then creates one merged provider without exposing credentials', async t => {
  const f = fixture(t), started = await f.auth.start('owner', { prefix: 'ocgo' });
  assert.equal(started.url, 'https://opencode.ai/console/device?user_code=ABCD-EFGH');
  assert.equal(JSON.stringify(started).includes('device-private'), false);
  assert.equal(f.calls[0].body.client_id, 'model-harbor');
  await assert.rejects(f.auth.poll('other', started.attemptId), { status: 404 });
  assert.equal((await f.auth.poll('owner', started.attemptId)).status, 'pending');
  assert.equal(f.calls.length, 1);
  f.advance(); assert.equal((await f.auth.poll('owner', started.attemptId)).status, 'pending');
  f.approve(); f.advance();
  const [a, b] = await Promise.all([f.auth.poll('owner', started.attemptId), f.auth.poll('owner', started.attemptId)]);
  assert.equal(a.status, 'complete'); assert.deepEqual(a, b);
  assert.equal(f.store.list().length, 1);
  assert.deepEqual(f.store.get('ocgo').models, ['glm-5.3', 'gpt-6-luna']);
  assert.equal(f.store.get('ocgo').protocol, 'both');
  assert.equal(f.store.list().every(p => p.hasApiKey), true);
  for (const value of ['access-private', 'refresh-private', 'device-private']) {
    assert.equal(JSON.stringify(a).includes(value), false);
    assert.equal(fs.readFileSync(f.store.file, 'utf8').includes(value), false);
  }
  const configCall = f.calls.find(c => c.url.endsWith('/api/v2/config'));
  assert.equal(configCall.options.headers['x-org-id'], 'org-test');
  const reloaded = new Store(f.dir);
  assert.deepEqual(await openCodeGoCredential(reloaded, reloaded.get('ocgo')), { apiKey: 'access-private', orgId: 'org-test' });
  const count = f.calls.length;
  assert.equal((await f.auth.poll('owner', started.attemptId)).status, 'complete');
  assert.equal(f.calls.length, count);
});

test('denial, expiry and cancellation create no providers', async t => {
  for (const mode of ['access_denied', 'expired', 'cancelled']) {
    const f = fixture(t), a = await f.auth.start('o', {});
    if (mode === 'cancelled') f.auth.cancel('o', a.attemptId);
    else if (mode === 'expired') f.advance(601000);
    else { f.status(mode); f.advance(); }
    assert.equal((await f.auth.poll('o', a.attemptId)).status, mode === 'access_denied' ? 'denied' : mode);
    assert.equal(f.store.list().length, 0);
  }
});

test('slow_down is respected on the server', async t => {
  const f = fixture(t), a = await f.auth.start('o', {});
  f.status('slow_down'); f.advance();
  assert.equal((await f.auth.poll('o', a.attemptId)).interval, 10);
  const calls = f.calls.length;
  f.advance(); await f.auth.poll('o', a.attemptId);
  assert.equal(f.calls.length, calls);
});

test('legacy responses card is folded into the merged provider on reauthorization', async t => {
  const f = fixture(t);
  f.store.upsert({ id: 'ocgo-r', baseUrl: 'https://opencode.ai/inference/go/openai/v1', protocol: 'responses', apiKey: 'legacy', models: ['gpt-6-luna'] });
  const a = await f.auth.start('o', {}); f.approve(); f.advance();
  assert.equal((await f.auth.poll('o', a.attemptId)).status, 'complete');
  assert.deepEqual(f.store.list().map(p => p.id), ['ocgo']);
  assert.deepEqual(f.store.get('ocgo').models, ['glm-5.3', 'gpt-6-luna']);
  assert.equal(Object.keys(f.store.data.openCodeGoAuth).length, 1);
  assert.equal(f.store.get('ocgo').openCodeAuthId, Object.keys(f.store.data.openCodeGoAuth)[0]);
  const g = fixture(t);
  const original = g.auth.fetchImpl;
  g.auth.fetchImpl = (u, o) => u.endsWith('/api/v2/config') ? response({ providers: {} }) : original(u, o);
  const b = await g.auth.start('o', {}); g.approve(); g.advance();
  await assert.rejects(g.auth.poll('o', b.attemptId), { status: 400 });
  assert.equal(g.store.list().length, 0);
  assert.equal(g.store.data.openCodeGoAuth, undefined);
});

test('refresh is shared by the merged provider, rotates once and persists before use', async t => {
  const f = fixture(t), a = await f.auth.start('o', {}); f.approve(); f.advance();
  await f.auth.poll('o', a.attemptId);
  const id = f.store.get('ocgo').openCodeAuthId;
  f.store.data.openCodeGoAuth[id] = f.store.seal(JSON.stringify({ access: 'old-access', refresh: 'old-refresh', expires: 0, orgId: 'org-test' })); f.store.save();
  let refreshes = 0;
  const fetchImpl = async (url, options) => {
    refreshes++;
    const body = JSON.parse(options.body);
    assert.equal(body.grant_type, 'refresh_token'); assert.equal(body.refresh_token, 'old-refresh');
    await new Promise(resolve => setTimeout(resolve, 10));
    return response({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
  };
  const values = await Promise.all(['ocgo', 'ocgo'].map(p => openCodeGoCredential(f.store, f.store.get(p), { fetchImpl })));
  assert.equal(refreshes, 1);
  assert.deepEqual(values, [{ apiKey: 'new-access', orgId: 'org-test' }, { apiKey: 'new-access', orgId: 'org-test' }]);
  const persisted = JSON.parse(f.store.unseal(f.store.data.openCodeGoAuth[id]));
  assert.equal(persisted.refresh, 'new-refresh');
  assert.equal(fs.readFileSync(f.store.file, 'utf8').includes('new-refresh'), false);
});

test('invalid refresh requires reauthorization and is not repeatedly retried', async t => {
  const f = fixture(t), a = await f.auth.start('o', {}); f.approve(); f.advance(); await f.auth.poll('o', a.attemptId);
  const p = f.store.get('ocgo');
  f.store.data.openCodeGoAuth[p.openCodeAuthId] = f.store.seal(JSON.stringify({ refresh: 'bad', access: 'old', expires: 0 }));
  let calls = 0;
  const fetchImpl = async () => { calls++; return response({ error: 'invalid_grant' }, 400); };
  await assert.rejects(openCodeGoCredential(f.store, p, { fetchImpl }), { code: 'opencode_go_needs_auth' });
  await assert.rejects(openCodeGoCredential(f.store, p, { fetchImpl }), { code: 'opencode_go_needs_auth' });
  assert.equal(calls, 1);
});

test('provider edits preserve OAuth, manual key or changed URL detaches it', async t => {
  const f = fixture(t), a = await f.auth.start('o', {}); f.approve(); f.advance(); await f.auth.poll('o', a.attemptId);
  const p = f.store.list()[0], id = p.openCodeAuthId;
  f.store.upsert({ ...p, name: 'Renamed' }, p.id);
  assert.equal(f.store.get(p.id).openCodeAuthId, id);
  f.store.upsert({ ...p, baseUrl: 'https://other.example/v1' }, p.id);
  assert.equal(f.store.get(p.id).openCodeAuthId, undefined);
  const q = f.store.list()[0];
  f.store.upsert({ ...q, apiKey: 'manual-key' }, q.id);
  assert.equal(f.store.get(q.id).openCodeAuthId, undefined);
});

test('foreign authorization URLs are rejected', async t => {
  const f = fixture(t, { fetchImpl: async () => response({ device_code: 'private', user_code: 'code',
    verification_uri_complete: 'https://evil.example/device', expires_in: 600, interval: 5 }) });
  await assert.rejects(f.auth.start('o', {}), { status: 502 });
  assert.equal(f.auth.attempts.size, 0);
});

test('uncertain refresh is not replayed after a lost response or restart', async t => {
  const f = fixture(t), a = await f.auth.start('o', {}); f.approve(); f.advance(); await f.auth.poll('o', a.attemptId);
  const p = f.store.get('ocgo');
  f.store.data.openCodeGoAuth[p.openCodeAuthId] = f.store.seal(JSON.stringify({ refresh: 'single-use', access: 'old', expires: 0 }));
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('lost response'); };
  await assert.rejects(openCodeGoCredential(f.store, p, { fetchImpl }), { status: 502 });
  const reloaded = new Store(f.dir);
  await assert.rejects(openCodeGoCredential(reloaded, reloaded.get('ocgo'), { fetchImpl }), { code: 'opencode_go_needs_auth' });
  assert.equal(calls, 1);
});

test('Go inference and model discovery use the shared OAuth token and workspace header', async t => {
  const f = fixture(t), a = await f.auth.start('o', {}); f.approve(); f.advance(); await f.auth.poll('o', a.attemptId);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith('/models') ? { data: [{ id: 'glm-5.3' }, { id: 'gpt-6-luna' }] } : { choices: [] });
  });
  const p = f.store.get('ocgo');
  await upstreamFetch(f.store, p, 'chat/completions', { model: 'glm-5.3' }, undefined, 'session-test');
  assert.equal(calls[0].url, OPENCODE_GO_OPENAI_BASE + '/chat/completions');
  assert.equal(calls[0].options.headers.authorization, 'Bearer access-private');
  assert.equal(calls[0].options.headers['x-opencode-org-id'], 'org-test');
  assert.equal(calls[0].options.headers['x-opencode-session'], 'session-test');
  assert.deepEqual(await discover(f.store, p), ['glm-5.3', 'gpt-6-luna']);
  assert.equal(calls[1].options.headers.authorization, 'Bearer access-private');
  assert.equal(calls[1].options.headers['x-opencode-org-id'], 'org-test');
});
