import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from '../src/server.js';

const mb=1024*1024;
test('API body limit configuration stays bounded',()=>{
  for(const apiBodyLimitMb of [0,257,1.5,NaN,'64']) assert.throws(()=>createGateway({apiBodyLimitMb}),/GATEWAY_API_BODY_LIMIT_MB/);
});
async function fixture(options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harbor-size-'));
  const seen=[];
  const gateway=createGateway({dataDir:dir,...options,nasAgent:{close(){},async run(p,m,body){seen.push(body);return {id:'resp_test',object:'response',status:'completed',output:[]};}}});
  gateway.store.upsert({id:'remote',type:'nas-codex',sshHost:'host',sshUser:'user',sshKeyPath:'/unused',container:'container',models:['model']});
  await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
  return {...gateway,seen,base:`http://127.0.0.1:${gateway.server.address().port}`,async close(){gateway.server.closeAllConnections();await new Promise(resolve=>gateway.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}};
}
test('default API accepts histories above the old 4 MiB cap without truncation; admin keeps its own cap',async()=>{
  const app=await fixture();
  try {
    const content='x'.repeat(5*mb),headers={authorization:'Bearer '+app.store.gatewayKey(),'content-type':'application/json'};
    for(const endpoint of ['responses','chat/completions']) {
      const body=endpoint==='responses'?{model:'remote/model',input:content}:{model:'remote/model',messages:[{role:'user',content}]};
      const r=await fetch(app.base+'/v1/'+endpoint,{method:'POST',headers,body:JSON.stringify(body)});
      assert.equal(r.status,200);await r.text();assert.deepEqual(app.seen.at(-1),body);
    }
    const session=await fetch(app.base+'/api/session'),{csrf}=await session.json(),cookie=session.headers.get('set-cookie').split(';')[0];
    const admin=await fetch(app.base+'/api/providers',{method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({padding:content})});
    assert.equal(admin.status,413);assert.equal((await admin.json()).error.code,'request_too_large');
  }finally{await app.close();}
});
test('configured API cap accepts exact boundary and rejects oversized fixed/chunked bodies before inference',async()=>{
  const app=await fixture({apiBodyLimitMb:1});
  try {
    const headers={authorization:'Bearer '+app.store.gatewayKey(),'content-type':'application/json'};
    const skeleton=JSON.stringify({model:'remote/model',input:''}),exact=skeleton.replace('"input":""','"input":"'+'x'.repeat(mb-Buffer.byteLength(skeleton))+'"');
    assert.equal(Buffer.byteLength(exact),mb);
    const ok=await fetch(app.base+'/v1/responses',{method:'POST',headers,body:exact});assert.equal(ok.status,200);await ok.text();
    const rejected=await fetch(app.base+'/v1/responses',{method:'POST',headers,body:exact+' '});assert.equal(rejected.status,413);assert.match((await rejected.json()).error.message,/1 MiB/);
    const chunked=await new Promise((resolve,reject)=>{
      const req=http.request(app.base+'/v1/responses',{method:'POST',headers},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,text}));});
      req.on('error',reject);req.write(exact.slice(0,mb/2));req.end(exact.slice(mb/2)+' ');
    });
    assert.equal(chunked.status,413);assert.equal(JSON.parse(chunked.text).error.code,'request_too_large');assert.equal(app.seen.length,1);
  }finally{await app.close();}
});
