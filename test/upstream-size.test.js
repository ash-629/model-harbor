import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {upstreamFetch} from '../src/upstream.js';
test('upstream 413 reports exact serialized UTF-8 bytes without leaking credentials or response content', async()=>{
 let received;
 const server=http.createServer(async(req,res)=>{const parts=[];for await(const c of req)parts.push(c);received=Buffer.concat(parts);res.writeHead(413,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'private upstream details'}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const body={model:'model',input:'中文'.repeat(1000)}, expected=Buffer.from(JSON.stringify(body));
 try {
  await assert.rejects(upstreamFetch({unseal:()=> 'private-api-key'}, {name:'DeepSeek',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'encrypted'},'responses',body),e=>{
   assert.equal(e.status,413);assert.equal(e.code,'upstream_request_too_large');assert.ok(e.message.includes(String(expected.length)));assert.equal(/private|密钥/.test(e.message),false);return true;
  });
  assert.deepEqual(received,expected,'the request is forwarded once without alteration or truncation');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
