import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createGateway } from '../src/server.js';
import { Store } from '../src/store.js';
import { ImageProviders } from '../src/image-providers.js';
import { ImageJobs, imageInfo, fromBase64, codexCommand } from '../src/images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=', 'base64');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const until = async fn => { for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error('Task did not finish'); };

test('image API integration: providers, both protocols, downloads, auth, failures and durable history', async () => {
  const received = [], downloads = [];
  let upstreamURL;
  const upstream = http.createServer(async (req, res) => {
    if (req.url.startsWith('/download/')) {
      downloads.push(req.headers.authorization);
      if (req.url.endsWith('redirect')) { res.writeHead(302, { location: '/download/image.png' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png);
    }
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw); received.push({ path: req.url, body, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (body.prompt === 'reject') { res.writeHead(401); return res.end('{"error":"super-secret-key"}'); }
    if (body.prompt === 'bad-image') return res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }));
    if (body.prompt === 'private-url') return res.end(JSON.stringify({ data: [{ url: 'http://127.0.0.2/private.png' }] }));
    if (body.prompt === 'url') return res.end(JSON.stringify(req.url.endsWith('/image_generation') ? { data: { image_urls: [upstreamURL + '/download/redirect'] }, base_resp: { status_code: 0 } } : { data: [{ url: upstreamURL + '/download/redirect' }] }));
    res.end(JSON.stringify(req.url.endsWith('/image_generation') ? { data: { image_base64: [png.toString('base64')] }, base_resp: { status_code: 0 } } : { data: [{ b64_json: png.toString('base64') }] }));
  });
  upstreamURL = await listen(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-images-')), gateway = createGateway({ dataDir: dir });
  const base = await listen(gateway.server);
  const session = await fetch(base + '/api/session'), { csrf } = await session.json();
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const api = async (url, method = 'GET', body) => fetch(base + '/api/image' + url, { method, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const finish = id => until(() => { const job = gateway.imageJobs.get(id); return !['queued', 'running'].includes(job.status) && job; });
  try {
    assert.equal((await fetch(base + '/api/image/jobs')).status, 401);
    assert.equal((await fetch(base + '/api/image/providers', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    const saved = await (await api('/providers', 'POST', { id: 'openai', name: 'Images', type: 'openai', baseUrl: upstreamURL + '/v1', model: 'gpt-image-2', apiKey: 'super-secret-key' })).json();
    assert.equal(saved.hasApiKey, true); assert.equal(saved.apiKey, undefined);
    const mini = await (await api('/providers', 'POST', { id: 'mini', name: 'MiniMax', type: 'minimax', baseUrl: upstreamURL + '/v1', model: 'image-01', apiKey: 'mini-key' })).json();
    assert.equal(mini.id, 'mini');
    assert.equal(gateway.store.models().length, 0, 'image models must not enter the chat model list');
    assert.equal(fs.readFileSync(gateway.store.file, 'utf8').includes('super-secret-key'), false);
    await api('/providers/openai', 'PUT', { ...saved, baseUrl: upstreamURL + '/v1', apiKey: '' });
    assert.equal(gateway.store.unseal(gateway.imageProviders.get('openai').apiKey), 'super-secret-key');
    const created = await api('/jobs', 'POST', { providerId: 'openai', prompt: 'a lighthouse', aspect: '16:9' });
    assert.equal(created.status, 202); const job = await finish((await created.json()).id);
    assert.equal(job.status, 'completed'); assert.equal(job.width, 1);
    assert.deepEqual(received[0].body, { model: 'gpt-image-2', prompt: 'a lighthouse', size: '1536x864', n: 1 });
    assert.equal(received[0].auth, 'Bearer super-secret-key');
    const file = await api('/files/' + job.id); assert.equal(file.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
    assert.equal((await fetch(base + '/api/image/files/' + job.id)).status, 401);
    assert.match((await api('/files/' + job.id + '?download=1')).headers.get('content-disposition'), /^attachment;/);
    assert.match((await api('/runner')).headers.get('content-disposition'), /codex-image-runner.py/);
    const miniJob = await finish((await (await api('/jobs', 'POST', { providerId: 'mini', prompt: 'a cat', aspect: '2:3' })).json()).id);
    assert.equal(miniJob.status, 'completed'); assert.equal(received[1].path, '/v1/image_generation');
    assert.deepEqual(received[1].body, {model:'image-01',prompt:'a cat',aspect_ratio:'2:3',n:1,response_format:'base64',prompt_optimizer:false});
    assert.equal(received[1].auth, 'Bearer mini-key');
    assert.equal((await api('/jobs', 'POST', { providerId: 'mini', prompt: 'a'.repeat(1501) })).status, 400);
    assert.equal((await api('/jobs', 'POST', { providerId: 'openai', prompt: 'ok', aspect: '../../bad' })).status, 400);
    const urlJob = await finish((await (await api('/jobs', 'POST', { providerId: 'openai', prompt: 'url' })).json()).id);
    assert.equal(urlJob.status, 'completed'); assert.deepEqual(downloads, [undefined, undefined], 'never forward provider credentials to image downloads');
    const miniURLJob = await finish((await (await api('/jobs', 'POST', { providerId: 'mini', prompt: 'url' })).json()).id);
    assert.equal(miniURLJob.status, 'completed', 'MiniMax native image_urls responses must be downloaded and saved');
    assert.deepEqual(downloads, [undefined, undefined, undefined, undefined]);
    for (const prompt of ['reject', 'bad-image', 'private-url']) {
      const failed = await finish((await (await api('/jobs', 'POST', { providerId: 'openai', prompt })).json()).id);
      assert.equal(failed.status, 'failed'); assert.equal(failed.error.includes('super-secret-key'), false);
    }
    const reopened = new ImageJobs(gateway.store, gateway.imageProviders, dir);
    assert.equal(reopened.get(job.id).status, 'completed'); assert.deepEqual(fs.readFileSync(reopened.file(job.id).file), png);
    await api('/providers/openai', 'DELETE'); assert.equal((await api('/files/' + job.id)).status, 200, 'removing a provider keeps previous images');
    assert.equal((await api('/providers/openai/check', 'POST')).status, 404);
    for (const file of fs.readdirSync(path.join(dir, 'images')).filter(f => f.endsWith('.json'))) assert.equal(fs.readFileSync(path.join(dir, 'images', file), 'utf8').includes('super-secret-key'), false);
  } finally { await close(gateway.server); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('image queue is serial, reports errors, and recovers interrupted tasks without replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-image-queue-'));
  const store = new Store(dir), providers = new ImageProviders(store);
  providers.upsert({ id: 'p', name: 'Images', type: 'openai', baseUrl: 'https://example.com/v1', model: 'test' });
  let concurrent = 0, peak = 0, calls = 0;
  const queue = new ImageJobs(store, providers, dir, { execute: async () => { calls++; concurrent++; peak = Math.max(peak, concurrent); await new Promise(r => setTimeout(r, 20)); concurrent--; return png; } });
  try {
    const a = queue.create({ providerId: 'p', prompt: 'first' }), b = queue.create({ providerId: 'p', prompt: 'second' });
    await until(() => queue.get(b.id).status === 'completed'); assert.equal(peak, 1); assert.equal(calls, 2); assert.equal(queue.get(a.id).status, 'completed');
    const id = crypto.randomUUID(); fs.writeFileSync(path.join(dir, 'images', id + '.json'), JSON.stringify({ id, status: 'running', createdAt: new Date().toISOString() }));
    const restored = new ImageJobs(store, providers, dir, { execute: () => { throw new Error('must not replay'); } });
    assert.equal(restored.get(id).status, 'failed'); assert.match(restored.get(id).error, /restarted/);
    providers.get('p').enabled = false; assert.throws(() => queue.create({ providerId: 'p', prompt: 'disabled' }), /disabled/);
    assert.throws(() => fromBase64(Buffer.from('<svg/>').toString('base64')), /PNG/);
    assert.throws(() => imageInfo(Buffer.alloc(21 * 1024 * 1024)), /20 MB/);
  } finally { queue.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex provider validation and SSH command construction never interpolate a prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-image-provider-'));
  try {
    const providers = new ImageProviders(new Store(dir));
    const p = { id: 'nas', name: 'NAS', type: 'codex', execution: 'ssh-docker', sshHost: '192.0.2.10', sshUser: 'exampleuser', sshKeyPath: '/keys/key', runnerPath: '/workspace/model-harbor/codex-image-runner.py', container: 'codex-linux' };
    providers.upsert(p); const configured = providers.get('nas');
    const command = codexCommand(configured, 'generate', '12345678-1234-1234-1234-123456789012');
    assert.equal(command.command, 'ssh'); assert.match(command.args.at(-1), /'python3' '\/workspace\/model-harbor\/codex-image-runner.py' 'generate'/);
    assert.throws(() => providers.upsert({ ...p, id: 'bad', sshHost: 'host;whoami' }), /SSH/);
    assert.throws(() => providers.upsert({ ...p, id: 'bad', sshKeyPath: '../key' }), /absolute/);
    assert.throws(() => providers.upsert({ ...p, id: 'bad', runnerPath: '../runner.py' }), /absolute/);
    assert.throws(() => providers.upsert({ ...p, id: 'bad', timeout: Infinity }), /timeout/);
    assert.throws(() => providers.upsert({ ...p, id: 'bad', execution: 'local', sandbox: 'danger-full-access' }), /SSH \+ Docker/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('reference images: native multipart/MiniMax protocols, capability, limits and private history', async () => {
  const reference = 'data:image/png;base64,' + png.toString('base64'), calls = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url.endsWith('/images/edits')) {
      const form = await new Response(req, {headers: req.headers}).formData();
      calls.push({path:req.url, prompt:form.get('prompt'), images:await Promise.all(form.getAll('image[]').map(async f => ({mime:f.type,bytes:Buffer.from(await f.arrayBuffer())}))), auth:req.headers.authorization});
      res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
    } else {
      let raw=''; for await (const b of req) raw+=b;
      calls.push({path:req.url,body:JSON.parse(raw)});
      res.end(JSON.stringify({data:{image_base64:[png.toString('base64')]}}));
    }
  });
  const upstreamURL = await listen(upstream), dir=fs.mkdtempSync(path.join(os.tmpdir(),'harbor-refs-'));
  const gateway=createGateway({dataDir:dir}), base=await listen(gateway.server);
  const session=await fetch(base+'/api/session'), {csrf}=await session.json(), cookie=session.headers.get('set-cookie').split(';')[0];
  const api=(url,body)=>fetch(base+'/api/image'+url,{method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify(body)});
  try {
    for (const type of ['openai','minimax']) gateway.imageProviders.upsert({id:type,name:type,type,baseUrl:upstreamURL+'/v1',model:type==='minimax'?'image-01':'gpt-image-2',apiKey:'ref-key',supportsImageInput:true});
    const send=refs=>api('/jobs',{providerId:'openai',prompt:'use all images',references:refs});
    for (const refs of [[reference,reference,reference,reference], ['data:image/png;base64,AAAA'], ['http://example.com/x.png'], {}, ['data:image/jpeg;base64,'+png.toString('base64')], ['data:image/png;base64,'+Buffer.alloc(5*1024*1024+1).toString('base64')]]) assert.equal((await send(refs)).status,400);
    gateway.imageProviders.get('openai').supportsImageInput=false;
    assert.equal((await send([reference])).status,400);
    gateway.imageProviders.get('openai').supportsImageInput=true;
    assert.throws(()=>gateway.imageProviders.upsert({id:'bad',type:'openai',supportsImageInput:'yes'}), /capability/);
    for (const type of ['openai','minimax']) {
      const response=await api('/jobs',{providerId:type,prompt:'use all images',references:[reference,reference,reference]});
      assert.equal(response.status,202); const created=await response.json();
      assert.equal(created.references,undefined); assert.equal(created.referenceCount,3);
      await until(()=>gateway.imageJobs.get(created.id).status==='completed');
      const disk=JSON.parse(fs.readFileSync(path.join(dir,'images',created.id+'.json'),'utf8'));
      assert.equal(disk.references,undefined); assert.equal(disk.referenceCount,3);
      assert.equal(gateway.imageJobs.get(created.id).references,undefined);
    }
    assert.equal(calls[0].path,'/v1/images/edits'); assert.equal(calls[0].images.length,3); assert.equal(calls[0].auth,'Bearer ref-key');
    for (const image of calls[0].images) {assert.equal(image.mime,'image/png');assert.deepEqual(image.bytes,png);}
    assert.deepEqual(calls[1].body.subject_reference,Array.from({length:3},()=>({type:'character',image_file:reference})));
    // Larger than the old 4 MB JSON limit, with original bytes preserved end to end.
    const large=Buffer.alloc(4*1024*1024); png.copy(large);
    const response=await send(['data:image/png;base64,'+large.toString('base64')]); assert.equal(response.status,202);
    const job=await response.json(); await until(()=>gateway.imageJobs.get(job.id).status==='completed');
    assert.deepEqual(calls[2].images[0].bytes,large);
  } finally {gateway.imageJobs.close();await close(gateway.server);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});}
});

test('Codex runner attaches original references and removes temporary input files', () => {
  const result=spawnSync(process.platform === 'win32' ? 'python' : 'python3',['test/image-runner.test.py'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
