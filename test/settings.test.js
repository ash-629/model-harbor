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
