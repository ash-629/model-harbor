// Saved proxy library: CRUD, provider binding, connectivity probe and routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createGateway } from '../src/server.js';
import { upstreamFetch } from '../src/upstream.js';
import { dispatcherForProvider, clearProxyAgents } from '../src/provider-proxy.js';
import { testSavedProxy } from '../src/proxy-test.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const tempStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-proxies-'));
  return { dir, store: new Store(dir) };
};
const providerInput = over => ({ id: 'grokx', name: 'Grok', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'responses', models: ['grok-4.5'], timeout: 60, ...over });

test('proxy library validates, seals passwords and protects providers in use', () => {
  const { dir, store } = tempStore();
  try {
    const created = store.upsertProxy({ id: 'nikki', name: 'OpenWrt Nikki', url: 'http://192.168.2.2:7890', username: 'root', password: 'proxy-secret', noProxy: ['localhost'] });
    assert.equal(created.hasPassword, true);
    assert.ok(!JSON.stringify(created).includes('proxy-secret'));
    assert.ok(!JSON.stringify(store.listProxies()).includes('proxy-secret'));
    assert.equal(store.unseal(store.getProxy('nikki').password), 'proxy-secret');

    store.upsertProxy({ id: 'nikki', name: 'Renamed', url: 'http://192.168.2.2:7890' }, 'nikki');
    assert.equal(store.getProxy('nikki').name, 'Renamed');
    assert.equal(store.unseal(store.getProxy('nikki').password), 'proxy-secret');

    assert.throws(() => store.upsertProxy({ id: 'bad1', url: 'socks5://192.168.2.2:7890' }), /代理地址/);
    assert.throws(() => store.upsertProxy({ id: 'bad2', url: 'http://u:p@192.168.2.2:7890' }), /代理地址/);
    assert.throws(() => store.upsertProxy({ id: 'nikki', url: 'http://192.168.2.2:7890' }), /已存在/);

    store.upsert(providerInput({ proxyId: 'nikki', proxyEnabled: true, proxyUrl: 'http://example.com:3128' }));
    const provider = store.get('grokx');
    assert.equal(provider.proxyId, 'nikki');
    assert.equal(provider.proxyUrl, '');
    assert.equal(provider.proxyEnabled, false);
    assert.throws(() => store.removeProxy('nikki'), /仍被供应商使用/);
    store.remove('grokx');
    assert.doesNotThrow(() => store.removeProxy('nikki'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('providers resolve the selected proxy and honour its bypass list', async () => {
  const { dir, store } = tempStore();
  try {
    store.upsertProxy({ id: 'nikki', name: 'Nikki', url: 'http://192.168.2.2:7890', noProxy: ['internal.example'] });
    store.upsert(providerInput({ proxyId: 'nikki' }));
    const provider = store.get('grokx');
    assert.ok(dispatcherForProvider(store, provider, 'https://cli-chat-proxy.grok.com/v1/models'));
    assert.equal(dispatcherForProvider(store, provider, 'https://api.internal.example/v1/models'), undefined);
    store.upsertProxy({ id: 'nikki', name: 'Nikki', url: 'http://192.168.2.2:7890', enabled: false }, 'nikki');
    assert.equal(dispatcherForProvider(store, store.get('grokx'), 'https://cli-chat-proxy.grok.com/v1/models'), undefined);
    store.upsertProxy({ id: 'nikki', name: 'Nikki', url: 'http://192.168.2.2:7890', enabled: true }, 'nikki');
    assert.ok(dispatcherForProvider(store, store.get('grokx'), 'https://cli-chat-proxy.grok.com/v1/models'), 're-enabling the saved proxy restores routing');
  } finally { await clearProxyAgents(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('connectivity probe reports reachability and failures', async () => {
  const proxy = { id: 'p', url: 'http://127.0.0.1:1', username: '', password: '' };
  const ok = await testSavedProxy(proxy, v => v, { fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 200);
  const failed = await testSavedProxy(proxy, v => v, { fetchImpl: async () => { throw Object.assign(new Error('boom'), { cause: { code: 'ECONNREFUSED' } }); } });
  assert.equal(failed.ok, false);
  assert.equal(failed.message, 'ECONNREFUSED');
});

test('a provider bound to a saved proxy routes through it end to end', async () => {
  const records = [];
  const upstream = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"grok-4.5"}]}'); });
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket, head) => {
    records.push({ target: req.url, auth: req.headers['proxy-authorization'] || '' });
    const [host, port] = req.url.split(':');
    const socket = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) socket.write(head);
      socket.pipe(clientSocket); clientSocket.pipe(socket);
    });
    socket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => socket.destroy());
  });
  const { dir, store } = tempStore();
  const upstreamUrl = await listen(upstream);
  const proxyUrl = await listen(proxy);
  try {
    store.upsertProxy({ id: 'nikki', name: 'Nikki', url: proxyUrl, username: 'root', password: 'proxy-secret' });
    store.upsert(providerInput({ baseUrl: upstreamUrl + '/v1', proxyId: 'nikki' }));
    const response = await upstreamFetch(store, store.get('grokx'), 'models');
    await response.body.cancel();
    assert.equal(records.length, 1);
    assert.equal(records[0].target, new URL(upstreamUrl).host);
    assert.equal(records[0].auth, 'Basic ' + Buffer.from('root:proxy-secret').toString('base64'));
  } finally {
    await clearProxyAgents();
    await close(proxy); await close(upstream);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('admin API exposes proxy CRUD and hides passwords from config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-proxies-api-'));
  const { server } = createGateway({ dataDir: dir, publicUrl: 'http://192.0.2.10:8317', adminPassword: 'test-password' });
  const base = await listen(server);
  try {
    const basic = { authorization: 'Basic ' + Buffer.from('admin:test-password').toString('base64') };
    const session = await fetch(base + '/api/session', { headers: basic });
    const cookie = session.headers.get('set-cookie').split(';')[0], { csrf } = await session.json();
    const admin = (url, method = 'GET', body) => fetch(base + '/api' + url, { method, headers: { ...basic, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await admin('/proxies', 'POST', { id: 'nikki', name: 'OpenWrt Nikki', url: 'http://192.168.2.2:7890', username: 'root', password: 'proxy-secret' })).status, 201);
    const config = await (await admin('/config')).text();
    assert.ok(!config.includes('proxy-secret'));
    const listed = JSON.parse(config).proxies;
    assert.equal(listed[0].id, 'nikki');
    assert.equal(listed[0].hasPassword, true);
    assert.equal((await admin('/providers', 'POST', providerInput({ proxyId: 'nikki' }))).status, 201);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url).startsWith(base) ? realFetch(url, init) : new Response('{}', { status: 200 });
    const probe = await admin('/proxies/nikki/test', 'POST', {});
    globalThis.fetch = realFetch;
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).ok, true);
    const deleteInUse = await admin('/proxies/nikki', 'DELETE');
    assert.equal(deleteInUse.status, 409);
    assert.equal((await admin('/providers/grokx', 'DELETE')).status, 200);
    assert.equal((await admin('/proxies/nikki', 'DELETE')).status, 200);
  } finally { await close(server); fs.rmSync(dir, { recursive: true, force: true }); }
});
