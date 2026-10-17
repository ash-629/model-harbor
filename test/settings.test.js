import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/server.js';
test('login setting persists, invalidates sessions, preserves CSRF and API authentication', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mh-settings-'));
 const auth={authorization:'Basic '+Buffer.from('admin:test-password').toString('base64')};
 let gateway,base;
 const start=async()=>{gateway=createGateway({dataDir:dir,adminPassword:'test-password'});await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+gateway.server.address().port;};
 const stop=async()=>{gateway.server.closeAllConnections();await new Promise(r=>gateway.server.close(r));};
 const session=async(headers={})=>{const r=await fetch(base+'/api/session',{headers});return {...headers,cookie:r.headers.get('set-cookie').split(';')[0],'x-csrf-token':(await r.json()).csrf,'content-type':'application/json'};};
 const put=(headers,value)=>fetch(base+'/api/settings',{method:'PUT',headers,body:JSON.stringify({loginEnabled:value})});
 try {
  await start();
  assert.equal((await fetch(base+'/')).status,401);
  let h=await session(auth);
  assert.equal((await (await fetch(base+'/api/settings',{headers:h})).json()).loginEnabled,true);
  assert.equal((await put({...h,'x-csrf-token':'wrong'},false)).status,403);
  assert.equal((await put(h,'false')).status,400);
  assert.equal((await put(h,false)).status,200);
  assert.equal((await fetch(base+'/')).status,200);
  assert.equal((await fetch(base+'/api/settings',{headers:h})).status,401);
  assert.equal((await fetch(base+'/v1/models')).status,401);
  assert.equal((await fetch(base+'/v1/models',{headers:{authorization:'Bearer '+gateway.store.gatewayKey()}})).status,200);
  await stop(); await start();
  assert.equal((await fetch(base+'/')).status,200);
  h=await session();
  assert.equal((await put(h,true)).status,200);
  assert.equal((await fetch(base+'/')).status,401);
  assert.equal((await fetch(base+'/',{headers:auth})).status,200);
 } finally {await stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('credentials change persists without plaintext, revokes old auth, and supports username-only changes', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mh-credentials-'));
 let gateway,base;
 const auth=(user,password)=>({authorization:'Basic '+Buffer.from(user+':'+password).toString('base64')});
 const start=async(bootstrap)=>{gateway=createGateway({dataDir:dir,adminPassword:bootstrap,publicUrl:"http://192.0.2.10:8317"});await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+gateway.server.address().port;};
 const stop=async()=>{gateway.server.closeAllConnections();await new Promise(r=>gateway.server.close(r));};
 const session=async(headers)=>{const r=await fetch(base+'/api/session',{headers});assert.equal(r.status,200);return {...headers,cookie:r.headers.get('set-cookie').split(';')[0],'x-csrf-token':(await r.json()).csrf,'content-type':'application/json'};};
 const put=(headers,body)=>fetch(base+'/api/settings',{method:'PUT',headers,body:JSON.stringify(body)});
 try {
  await start('test-password');let h=await session(auth('admin','test-password'));
  for (const input of [{username:'bad:name',password:''},{username:'owner',password:'short'},{username:'owner',password:123}]) assert.equal((await put(h,{loginEnabled:true,...input})).status,400);
  assert.equal((await put({...h,'x-csrf-token':'wrong'},{loginEnabled:true,username:'owner',password:'test-pass-2222'})).status,403);
  let response=await put(h,{loginEnabled:true,username:'owner',password:'test-pass-2222'});assert.equal(response.status,200);
  assert.equal((await response.json()).credentialsChanged,true);
  assert.equal(fs.readFileSync(path.join(dir,'config.json'),'utf8').includes('test-pass-2222'),false);
  assert.equal((await fetch(base+'/',{headers:auth('admin','test-password')})).status,401);
  assert.equal((await fetch(base+'/api/settings',{headers:{...auth('owner','test-pass-2222'),cookie:h.cookie}})).status,401);
  h=await session(auth('owner','test-pass-2222'));
  const settings=await (await fetch(base+'/api/settings',{headers:h})).json();assert.equal(settings.username,'owner');assert.equal('passwordHash' in settings,false);
  assert.equal((await put(h,{loginEnabled:true,username:'new-owner',password:''})).status,200);
  assert.equal((await fetch(base+'/',{headers:auth('owner','test-pass-2222')})).status,401);
  await stop();await start();
  assert.equal((await fetch(base+'/',{headers:auth('new-owner','test-pass-2222')})).status,200);
  assert.equal((await fetch(base+'/',{headers:auth('admin','test-password')})).status,401);
  assert.equal((await fetch(base+'/v1/models')).status,401);
 } finally {await stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('local setup can create credentials before enabling login and failed persistence rolls back', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mh-local-credentials-'));
 const {AdminAuth}=await import('../src/admin-auth.js');
 const {Store}=await import('../src/store.js');
 const store=new Store(dir), auth=new AdminAuth(store);
 try {
  await assert.rejects(auth.update({loginEnabled:true,username:'owner',password:''}), /请先/);
  assert.equal(auth.enabled,false);
  await auth.update({loginEnabled:true,username:'owner',password:'fixture-local-passphrase'});
  assert.equal(auth.enabled,true);
  const header='Basic '+Buffer.from('owner:fixture-local-passphrase').toString('base64');assert.equal(await auth.accepts(header),true);
  store.save=()=>{throw Error('simulated write failure');};
  await assert.rejects(auth.update({loginEnabled:false,username:'replacement',password:''}), /write failure/);
  assert.equal(auth.username,'owner');assert.equal(auth.enabled,true);assert.equal(await auth.accepts(header),true);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
