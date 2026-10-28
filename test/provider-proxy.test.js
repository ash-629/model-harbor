// Per-provider outbound proxy: validation, secret handling, bypass and a real tunnel.
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
import { parseProxyUrl, normalizeNoProxy, dispatcherFor, proxyBypass, clearProxyAgents } from '../src/provider-proxy.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

function tunnelProxy(records) {
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket, head) => {
    records.push({ target: req.url, auth: req.headers['proxy-authorization'] || '' });
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  return proxy;
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-proxy-'));
  const store = new Store(dir);
  return { dir, store };
}

const baseProvider = { id: 'grok', name: 'Grok', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'responses', models: ['grok-4.7'], timeout: 30 };

test('proxy URLs and bypass rules are validated', () => {
  assert.equal(parseProxyUrl(' http://192.168.2.2:7890/ '), 'http://192.168.2.2:7890');
  assert.equal(parseProxyUrl('https://proxy.lan:8080'), 'https://proxy.lan:8080');
  assert.equal(parseProxyUrl('socks5://192.168.2.2:7890'), null);
  assert.equal(parseProxyUrl('http://user:pass@192.168.2.2:7890'), null);
  assert.equal(parseProxyUrl('http://192.168.2.2:7890/?x=1'), null);
  assert.deepEqual(normalizeNoProxy('localhost, *.internal.example ,127.0.0.1'), ['localhost', 'internal.example', '127.0.0.1']);
  assert.equal(normalizeNoProxy('bad host!'), null);
  assert.equal(proxyBypass({ noProxy: ['internal.example'] }, 'api.internal.example'), true);
  assert.equal(proxyBypass({ noProxy: ['internal.example'] }, 'internal.example.'), true);
  assert.equal(proxyBypass({ noProxy: ['internal.example'] }, 'notinternal.example'), false);
});

test('provider proxy settings persist, stay sealed and survive unrelated edits', () => {
  const { dir, store } = tempStore();
  try {
    store.upsert({ ...baseProvider, proxyEnabled: true, proxyUrl: 'http://192.168.2.2:7890', proxyUsername: 'root', proxyPassword: 'proxy-secret', noProxy: ['localhost'] });
    const saved = store.get('grok');
    assert.equal(saved.proxyEnabled, true);
    assert.equal(saved.proxyUrl, 'http://192.168.2.2:7890');
    assert.equal(store.unseal(saved.proxyPassword), 'proxy-secret');
    assert.ok(!JSON.stringify(saved).includes('proxy-secret'));
    const listed = store.list()[0];
    assert.equal(listed.hasProxyPassword, true);
    assert.equal(listed.proxyPassword, undefined);
    assert.ok(!JSON.stringify(listed).includes('proxy-secret'));
    store.upsert({ ...baseProvider, name: 'Renamed' }, 'grok');
    assert.equal(store.unseal(store.get('grok').proxyPassword), 'proxy-secret');
    assert.equal(store.get('grok').proxyEnabled, true);
    store.upsert({ ...baseProvider, proxyEnabled: true, proxyUrl: 'http://192.168.2.2:7890', clearProxyPassword: true, noProxy: [] }, 'grok');
    assert.equal(store.get('grok').proxyPassword, '');
    assert.throws(() => store.upsert({ ...baseProvider, id: 'bad-scheme', proxyUrl: 'ftp://192.168.2.2:7890' }), /代理地址/);
    assert.throws(() => store.upsert({ ...baseProvider, id: 'bad-creds', proxyUrl: 'http://u:p@192.168.2.2:7890' }), /代理地址/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inference and model discovery traverse the provider proxy with its credentials', async () => {
  const records = [];
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'grok-4.7' }], object: 'response', model: 'grok-4.7', output: [] }));
  });
  const proxy = tunnelProxy(records);
  const { dir, store } = tempStore();
  const upstreamUrl = await listen(upstream);
  const proxyUrl = await listen(proxy);
  try {
    const provider = store.upsert({ ...baseProvider, baseUrl: upstreamUrl + '/v1', proxyEnabled: true, proxyUrl, proxyUsername: 'root', proxyPassword: 'proxy-secret', noProxy: ['localhost'] });
    const p = store.get(provider.id);
    const models = await upstreamFetch(store, p, 'models');
    assert.equal(models.status, 200);
    await models.body.cancel();
    assert.equal(records.length, 1);
    assert.equal(records[0].target, new URL(upstreamUrl).host);
    assert.equal(records[0].auth, 'Basic ' + Buffer.from('root:proxy-secret').toString('base64'));
    assert.equal(dispatcherFor(p, upstreamUrl, v => store.unseal(v)) === undefined, false);
    const bypassed = store.upsert({ ...baseProvider, id: 'direct', baseUrl: upstreamUrl + '/v1', proxyEnabled: true, proxyUrl, noProxy: ['127.0.0.1'] });
    const direct = await upstreamFetch(store, store.get(bypassed.id), 'models');
    await direct.body.cancel();
    assert.equal(records.length, 1, 'bypass rules must connect directly');
  } finally {
    await clearProxyAgents();
    await close(proxy); await close(upstream);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('disabled proxy settings connect directly and never leak credentials', async () => {
  const records = [];
  const upstream = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); });
  const proxy = tunnelProxy(records);
  const { dir, store } = tempStore();
  const upstreamUrl = await listen(upstream);
  const proxyUrl = await listen(proxy);
  try {
    const provider = store.upsert({ ...baseProvider, baseUrl: upstreamUrl + '/v1', proxyEnabled: false, proxyUrl });
    const response = await upstreamFetch(store, store.get(provider.id), 'models');
    await response.body.cancel();
    assert.equal(records.length, 0);
    assert.equal(store.get('grok').proxyEnabled, false);
    assert.equal(dispatcherFor(store.get('grok'), upstreamUrl, v => v), undefined);
  } finally { await close(proxy); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('admin API saves proxy settings and never returns the proxy password', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-proxy-api-'));
  const { server } = createGateway({ dataDir: dir, publicUrl: 'http://192.0.2.10:8317', adminPassword: 'test-password' });
  const base = await listen(server);
  try {
    const basic = { authorization: 'Basic ' + Buffer.from('admin:test-password').toString('base64') };
    const session = await fetch(base + '/api/session', { headers: basic });
    const cookie = session.headers.get('set-cookie').split(';')[0], { csrf } = await session.json();
    const admin = (url, method = 'GET', body) => fetch(base + '/api' + url, { method, headers: { ...basic, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const created = await admin('/providers', 'POST', { ...baseProvider, baseUrl: 'http://127.0.0.1:9/v1', proxyEnabled: true, proxyUrl: 'http://192.168.2.2:7890', proxyUsername: 'root', proxyPassword: 'proxy-secret', noProxy: ['localhost'] });
    assert.equal(created.status, 201);
    const config = await (await admin('/config')).text();
    assert.ok(!config.includes('proxy-secret'));
    const provider = JSON.parse(config).providers.find(p => p.id === 'grok');
    assert.equal(provider.proxyEnabled, true);
    assert.equal(provider.proxyUrl, 'http://192.168.2.2:7890');
    assert.equal(provider.proxyUsername, 'root');
    assert.equal(provider.hasProxyPassword, true);
    assert.deepEqual(provider.noProxy, ['localhost']);
    const bad = await admin('/providers', 'POST', { ...baseProvider, id: 'grok2', baseUrl: 'http://127.0.0.1:9/v1', proxyUrl: 'socks5://192.168.2.2:7890' });
    assert.equal(bad.status, 400);
  } finally { await close(server); fs.rmSync(dir, { recursive: true, force: true }); }
});
