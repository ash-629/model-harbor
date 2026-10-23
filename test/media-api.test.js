import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/server.js';

test('LAN media API authenticates, isolates configuration and retrieves image/video bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-media-'));
  const g = createGateway({ dataDir: dir, adminPassword: 'media-test-password' });
  await new Promise(r => g.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + g.server.address().port;
  const headers = { authorization: 'Bearer ' + g.store.gatewayKey(), 'content-type': 'application/json' };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=', 'base64');
  const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
  try {
    g.imageProviders.upsert({ id: 'codex-test', name: 'Codex', type: 'codex', execution: 'local', supportsImageInput: true, timeout: 30 });
    g.videoProviders.upsert({ id: 'grok-test', name: 'Grok', type: 'grok', execution: 'local', timeout: 30 });
    g.imageJobs.execute = async (p, job) => { assert.equal(job.referenceCount, 1); return png; };
    g.videoJobs.execute = async () => ({ bytes: mp4, ext: 'mp4' });
    for (const kind of ['image', 'video']) {
      const route = '/v1/media/' + kind;
      assert.equal((await fetch(base + route + '/providers')).status, 401);
      assert.equal((await fetch(base + route + '/providers', { headers: { authorization: 'Bearer wrong' } })).status, 401);
      const providers = await (await fetch(base + route + '/providers', { headers })).json();
      assert.equal(providers.providers.length, 1);
      assert.equal(providers.providers[0].sshKeyPath, undefined);
      assert.equal(providers.providers[0].runnerPath, undefined);
      assert.equal((await fetch(base + route + '/providers', { method: 'POST', headers, body: '{}' })).status, 405);
      const created = await fetch(base + route + '/jobs', { method: 'POST', headers, body: JSON.stringify({ providerId: providers.providers[0].id, prompt: 'A boat', references: ['data:image/png;base64,' + png.toString('base64')] }) });
      assert.equal(created.status, 202);
      let job = await created.json();
      for (let n = 0; n < 100 && job.status !== 'completed'; n++) {
        await new Promise(r => setTimeout(r, 5));
        job = await (await fetch(base + route + '/jobs/' + job.id, { headers })).json();
      }
      assert.equal(job.status, 'completed');
      assert.equal(job.references, undefined);
      const fileUrl = job.imageUrl || job.videoUrl;
      assert.match(fileUrl, /^\/v1\/media\//);
      assert.equal((await fetch(base + fileUrl)).status, 401);
      assert.deepEqual(Buffer.from(await (await fetch(base + fileUrl, { headers })).arrayBuffer()), kind === 'image' ? png : mp4);
    }
    assert.equal((await fetch(base + '/api/image/providers', { headers })).status, 401);
    assert.equal((await fetch(base + '/v1/media/image/runner', { headers })).status, 404);
    const basic = { authorization: 'Basic ' + Buffer.from('admin:media-test-password').toString('base64') };
    const session = await fetch(base + '/api/session', { headers: basic });
    const cookie = session.headers.get('set-cookie').split(';')[0];
    for (const slug of ['codex-image', 'grok-image', 'grok-video']) {
      const endpoint = '/api/skills/model-harbor-' + slug + '.zip';
      assert.equal((await fetch(base + endpoint)).status, 401);
      const r = await fetch(base + endpoint, { headers: { ...basic, cookie } });
      assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/zip');
      assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 2).toString(), 'PK');
    }
  } finally {
    g.server.closeAllConnections(); await new Promise(r => g.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
