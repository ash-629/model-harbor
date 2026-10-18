import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {nativeRequest,sendDirect,responsesCommand} from '../src/nas-responses.js';
import {sseEvents} from '../src/protocol.js';
const p={timeout:10,sshKeyPath:'/key',sshHost:'host',sshUser:'user',container:'codex-linux'};
function fixture(events, status=200) {
 let input,child;
 return {get input(){return input;},get child(){return child;},launch(){
 child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
 child.stdin=new Writable({write(b,e,done){input=JSON.parse(b);done();}});
 child.stdin.on('finish',()=>queueMicrotask(()=>{if (!child.killed) child.stdout.end(JSON.stringify({status,code:'codex_login_expired'})+'\n'+events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));}));
 child.kill=()=>{child.killed=true;child.stdout.end();};return child;
 }};
}
function responseSink(){
 const res=new PassThrough();res.headersSent=false;res.flushHeaders=()=>{};
 res.writeHead=(s,h)=>{res.status=s;res.headersSent=true;};
 return res;
}
test('native long model-switch history remains structured and byte-exact with images, custom tools and phases',()=>{
 const history='长历史😀'.repeat(300000);
 const image={type:'input_image',image_url:'data:image/png;base64,YWJj'};
 const raw={model:'nas/model',input:[{role:'system',content:'rules'},{role:'user',content:history},{type:'function_call',id:'foreign',call_id:'c1',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'c1',output:[image]},{role:'assistant',phase:'commentary',content:'done'}],tools:[{type:'custom',name:'exec',format:{type:'text'}}],max_tokens:100};
 const {body,budget}=nativeRequest(raw,'model','responses');
 assert.equal(body.input[1].content,history);assert.deepEqual(body.input[3].output,[image]);
 assert.equal(body.input[4].phase,'commentary');assert.deepEqual(body.tools,raw.tools);
 assert.equal(body.input[0].role,'developer');assert.equal(body.model,'model');assert.equal(budget,100);
 assert.equal(body.max_tokens,undefined);assert.equal(body.store,false);assert.equal(raw.input[2].id,'foreign');
 const reasoning={type:'reasoning',encrypted_content:'gAAAAencrypted',summary:[]};
 assert.deepEqual(nativeRequest({input:[reasoning]},'m','responses').body.input[0],reasoning);
});
test('native SSE forwards real deltas, namespaced custom tool calls, terminal event and public model',async()=>{
 const call={id:'ctc_1',type:'custom_tool_call',name:'exec',namespace:'functions',call_id:'c1',input:'raw input',status:'completed'};
 const events=[{type:'response.created',response:{model:'m',output:[]}},{type:'response.custom_tool_call_input.delta',delta:'raw input'},{type:'response.completed',response:{id:'resp_1',model:'m',output:[call],status:'completed'}}];
 const fake=fixture(events),res=responseSink(),data=[];res.on('data',b=>data.push(b));
 await sendDirect(p,'m',{model:'nas/m',input:'hello',stream:true},'responses',res,undefined,fake.launch);
 const received=[];for await(const e of sseEvents((async function*(){yield Buffer.concat(data);})()))received.push(JSON.parse(e.data));
 assert.equal(received[1].delta,'raw input');assert.deepEqual(received.at(-1).response.output[0],call);
 assert.equal(received.at(-1).response.model,'nas/m');assert.equal(fake.child.killed,true);
 const next=nativeRequest({input:[call,{type:'custom_tool_call_output',call_id:'c1',output:'RESULT'}]},'m','responses').body;
 assert.equal(next.input[1].output,'RESULT');assert.equal(next.input[0].call_id,'c1');
});
test('native nonstream uses completed response; premature EOF and login errors remain failures',async()=>{
 const end={type:'response.completed',response:{id:'r',model:'m',status:'completed',output:[]}};
 const fake=fixture([end]);assert.equal((await sendDirect(p,'m',{model:'nas/m',input:'hi'},'responses',responseSink(),undefined,fake.launch)).model,'nas/m');
 const empty=fixture([]);await assert.rejects(sendDirect(p,'m',{input:'hi'},'responses',responseSink(),undefined,empty.launch),e=>e.code==='upstream_stream_incomplete');
 const expired=fixture([],401);await assert.rejects(sendDirect(p,'m',{input:'hi'},'responses',responseSink(),undefined,expired.launch),e=>e.status===401);
});
test('native transport cancellation cleans up and SSH only launches fixed relay',async()=>{
 const fake=fixture([]),controller=new AbortController();controller.abort();
 await assert.rejects(sendDirect(p,'m',{input:'hi'},'responses',responseSink(),controller.signal,fake.launch),e=>e.status===499);
 assert.equal(fake.child.killed,true);assert.match(responsesCommand(p).args.at(-1),/codex-responses-runner.py/);
 assert.doesNotMatch(responsesCommand(p).args.at(-1),/auth.json|access_token|app-server/);
});


test('foreign provider reasoning signatures become plaintext history, OpenAI encrypted reasoning stays native', () => {
  const body=nativeRequest({input:[{type:'reasoning',id:'foreign',encrypted_content:'deepseek-private-signature',summary:[],content:[{type:'reasoning_text',text:'prior thought'}]}]},'m','responses').body;
  assert.equal(body.input[0].role,'assistant');
  assert.match(body.input[0].content[0].text,/prior thought/);
  assert.equal(body.input[0].encrypted_content,undefined);
});


test('native tool discovery outputs preserve their type and call ID', () => {
  const item={type:'tool_search_output',call_id:'discover_1',tools:[{type:'function',name:'read',parameters:{type:'object'}}]};
  const body=nativeRequest({input:[item]},'m','responses').body;
  assert.deepEqual(body.input[0],item);
  assert.equal(body.tools[0].name,'read');
});


test('response protection errors are identifiable before any SSE is opened', async () => {
  const stream=[{type:'error',error:{message:'response protection is unavailable'}}];
  const fake=fixture(stream);
  await assert.rejects(sendDirect(p,'m',{input:'hi',stream:true},'responses',responseSink(),undefined,fake.launch),e=>e.code==='codex_response_protection');
});
