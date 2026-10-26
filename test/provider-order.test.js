import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createGateway } from '../src/server.js';
test('provider order persists, preserves data and group priority, rejects stale and invalid orders', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harbor-order-'));
 try {
  const s=new Store(dir);
  for(const id of ['a','b','c'])s.upsert({id,baseUrl:'https://example.com/v1',apiKey:'test-only-key',models:['test']});
  const original=structuredClone(s.data.providers);
  s.data.providerGroups=[{id:'group',members:['a','b']}];
  s.reorderProviders(['c','a','b']);
  assert.deepEqual(s.data.providers,[original[2],original[0],original[1]]);
  const reload=new Store(dir);
  assert.deepEqual(reload.list().map(p=>p.id),['c','a','b']);
  assert.deepEqual(reload.groups()[0].members,['a','b']);
  for(const ids of [null,['a','a','b'],[1,'a','b'],['a'],['a','b','unknown']]){
   assert.throws(()=>reload.reorderProviders(ids));assert.deepEqual(reload.list().map(p=>p.id),['c','a','b']);
  }
  reload.save=()=>{throw new Error('disk error')};
  assert.throws(()=>reload.reorderProviders(['a','b','c']),/disk error/);
  assert.deepEqual(reload.list().map(p=>p.id),['c','a','b']);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('order API enforces session and CSRF and returns persistent order',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harbor-order-api-'));
 const g=createGateway({dataDir:dir});await new Promise(r=>g.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+g.server.address().port;
 try{
  for(const id of ['a','b'])g.store.upsert({id,baseUrl:'https://example.com/v1'});
  const req=(ids,headers={})=>fetch(base+'/api/providers/order',{method:'PUT',headers:{'content-type':'application/json',...headers},body:JSON.stringify({ids})});
  assert.equal((await req(['b','a'])).status,401);
  const session=await fetch(base+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{csrf}=await session.json();
  assert.equal((await req(['b','a'],{cookie})).status,403);
  const headers={cookie,'x-csrf-token':csrf};
  assert.equal((await req(['a','a'],headers)).status,400);
  assert.equal((await req(['a'],headers)).status,409);
  const r=await req(['b','a'],headers);assert.equal(r.status,200);assert.deepEqual((await r.json()).providers.map(p=>p.id),['b','a']);
  assert.deepEqual((await (await fetch(base+'/api/config',{headers})).json()).providers.map(p=>p.id),['b','a']);
 }finally{await new Promise(r=>g.server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
});
