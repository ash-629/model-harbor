import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeAccount } from './helpers/fake-account.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeUsage } from '../src/codex-usage.js';
import { NasAgentBridge } from '../src/nas-agent.js';
import { createGateway } from '../src/server.js';

const snapshot = { rateLimits: { limitId:'legacy', primary:{usedPercent:99, windowDurationMins:300} },
  rateLimitsByLimitId: { codex:{ limitId:'codex', planType:'plus', primary:{usedPercent:36, windowDurationMins:300, resetsAt:1792225465}, secondary:{usedPercent:6, windowDurationMins:10080, resetsAt:1792812265} }, other:{limitName:'Other', primary:{usedPercent:null, windowDurationMins:60}} },
  rateLimitResetCredits:{availableCount:2, credits:[{id:'private-reset-id', status:'available'}]}, email:'private@example.test', accessToken:'secret-token' };
const provider = { id:'remote', type:'nas-codex', sshHost:'host', sshUser:'user', sshKeyPath:'/key', container:'codex-linux', models:['model'] };
const fakeUsage = options => fakeAccount(snapshot, options);
test('usage normalization prefers multiple buckets and keeps missing values distinct from zero', () => {
  const value=normalizeUsage(snapshot);
  assert.deepEqual(value.buckets.map(b=>b.id),['codex','other']);
  assert.equal(value.buckets[0].windows[0].remainingPercent,64);
  assert.equal(value.buckets[0].windows[1].durationMins,10080);
  assert.equal(value.buckets[1].windows[0].usedPercent,null);
  assert.equal(value.resetCredits,2,'authoritative count differs from detail length');
  assert.equal(/private|secret-token|email|accessToken/.test(JSON.stringify(value)),false);
  assert.equal(normalizeUsage({rateLimitsByLimitId:{}, rateLimits:snapshot.rateLimits}).buckets[0].id,'legacy');
  assert.equal(normalizeUsage({rateLimitResetCredits:{availableCount:0}}).resetCredits,0);
  assert.equal(normalizeUsage({}).resetCredits,null);
  assert.equal(normalizeUsage({rateLimitResetCredits:{availableCount:-1}}).resetCredits,null);
});
test('usage queries only initialize/read, cache briefly, invalidate on config changes and clean up readers', async () => {
  const fake=fakeUsage(), bridge=new NasAgentBridge({launch:fake.launch});
  try {
    const value=await bridge.usage(provider); assert.equal(value.resetCredits,2);
    value.resetCredits=100;
    assert.equal((await bridge.usage(provider)).resetCredits,2);
    assert.equal(fake.children.length,1);
    await bridge.usage({...provider, execution:'ssh'}); assert.equal(fake.children.length,2);
    assert.equal(fake.children.every(c=>c.killed),true);
    assert.deepEqual(fake.calls.map(c=>c.method),['initialize','initialized','account/rateLimits/read','initialize','initialized','account/rateLimits/read']);
    assert.equal(bridge.sessions.size,0); assert.equal(bridge.usageReaders.size,0);
    await assert.rejects(bridge.usage({...provider,type:'openai'}),e=>e.status===400);
  } finally {bridge.close();}
});
test('usage errors and cancellation are bounded, release processes and hide backend details', async () => {
  const failed=fakeUsage({fail:true}), bridge=new NasAgentBridge({launch:failed.launch});
  await assert.rejects(bridge.usage(provider),e=>e.status===502 && !e.message.includes('private'));
  assert.equal(failed.children[0].killed,true); bridge.close();
  const fake=fakeUsage({hang:true}), hanging=new NasAgentBridge({launch:fake.launch}), controller=new AbortController();
  const pending=hanging.usage(provider,controller.signal); controller.abort();
  await assert.rejects(pending,e=>e.status===499);
  assert.equal(fake.children[0].killed,true); assert.equal(hanging.usageReaders.size,0); hanging.close();
});
test('usage management endpoint requires admin session and does not expose raw account data', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harbor-usage-')), fake=fakeUsage(), bridge=new NasAgentBridge({launch:fake.launch});
  const gateway=createGateway({dataDir:dir,adminPassword:'test-password',nasAgent:bridge}); gateway.store.upsert(provider);
  await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve)); const base=`http://127.0.0.1:${gateway.server.address().port}`;
  try {
    assert.equal((await fetch(base+'/api/providers/remote/usage')).status,401);
    const authorization='Basic '+Buffer.from('admin:test-password').toString('base64');
    assert.equal((await fetch(base+'/api/providers/remote/usage',{headers:{authorization}})).status,401);
    const session=await fetch(base+'/api/session',{headers:{authorization}}), cookie=session.headers.get('set-cookie').split(';')[0];
    const response=await fetch(base+'/api/providers/remote/usage',{headers:{authorization,cookie}});
    assert.equal(response.status,200); const value=await response.json();
    assert.equal(value.resetCredits,2); assert.equal(JSON.stringify(value).includes('private'),false);
    assert.equal((await fetch(base+'/api/providers/missing/usage',{headers:{authorization,cookie}})).status,404);
  } finally { bridge.close(); gateway.server.closeAllConnections(); await new Promise(resolve=>gateway.server.close(resolve)); fs.rmSync(dir,{recursive:true,force:true}); }
});

const resetInput={confirmed:true,idempotencyKey:'8ae96ff3-3425-4f4c-8772-b6fd61502868'};
test('reset simulation preserves idempotency, refreshes authoritative usage and never decrements locally', async () => {
  const fake=fakeUsage(), bridge=new NasAgentBridge({launch:fake.launch});
  try {
    await bridge.usage(provider);
    const result=await bridge.resetUsage(provider,resetInput);
    assert.equal(result.outcome,'reset'); assert.equal(result.usage.resetCredits,1);
    assert.equal(result.usage.buckets[0].windows[0].usedPercent,36,'usage comes from service, not invented zeros');
    assert.equal((await bridge.usage(provider)).resetCredits,1,'pre-reset cache was invalidated');
    const retry=await bridge.resetUsage(provider,resetInput);
    assert.equal(retry.outcome,'alreadyRedeemed'); assert.equal(fake.consumed(),1);
    assert.deepEqual(fake.calls.filter(c=>c.method.includes('/consume')).map(c=>c.params),[{idempotencyKey:resetInput.idempotencyKey},{idempotencyKey:resetInput.idempotencyKey}]);
    assert.equal(fake.children.every(c=>c.killed),true);
  } finally {bridge.close();}
});
test('reset simulation handles no credit, no eligible window, uncertain result and failed refresh', async () => {
  for (const outcome of ['noCredit','nothingToReset']) {
    const fake=fakeUsage({outcome}), bridge=new NasAgentBridge({launch:fake.launch});
    const result=await bridge.resetUsage(provider,resetInput);
    assert.equal(result.outcome,outcome); assert.equal(fake.consumed(),0); bridge.close();
  }
  const lost=fakeUsage({loseResultOnce:true}), bridge=new NasAgentBridge({launch:lost.launch});
  await assert.rejects(bridge.resetUsage(provider,resetInput),e=>e.status===502);
  assert.equal((await bridge.resetUsage(provider,resetInput)).outcome,'alreadyRedeemed'); assert.equal(lost.consumed(),1); bridge.close();
  const failed=fakeUsage({failRefresh:true}), second=new NasAgentBridge({launch:failed.launch});
  const result=await second.resetUsage(provider,resetInput);
  assert.deepEqual(result,{outcome:'reset',usage:null}); assert.equal(failed.consumed(),1); second.close();
});
test('reset endpoint requires POST, CSRF, explicit confirmation and operation ID before contacting service', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harbor-reset-')), fake=fakeUsage(), bridge=new NasAgentBridge({launch:fake.launch});
  const gateway=createGateway({dataDir:dir,nasAgent:bridge});gateway.store.upsert(provider);
  await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${gateway.server.address().port}`;
  try {
    const session=await fetch(base+'/api/session'), cookie=session.headers.get('set-cookie').split(';')[0], {csrf}=await session.json();
    const headers={cookie,'content-type':'application/json'};
    const post=input=>fetch(base+'/api/providers/remote/reset',{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal((await post(resetInput)).status,403);
    headers['x-csrf-token']=csrf;
    assert.equal((await post({...resetInput,confirmed:false})).status,400);
    assert.equal((await post({...resetInput,idempotencyKey:'bad'})).status,400);
    assert.equal((await fetch(base+'/api/providers/remote/reset',{headers})).status,404);
    assert.equal(fake.calls.length,0);
    const result=await post(resetInput);assert.equal(result.status,200);assert.equal((await result.json()).outcome,'reset');
    assert.equal(fake.consumed(),1);
  } finally {bridge.close();gateway.server.closeAllConnections();await new Promise(resolve=>gateway.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});
