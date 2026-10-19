import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {toResponses,fromResponses} from '../src/anthropic.js';
import {createGateway} from '../src/server.js';import {sseEvents,responseBase} from '../src/protocol.js';
test('Anthropic preserves ordered text, images, tool calls/results and tool choice',()=>{
 const source={type:'base64',media_type:'image/png',data:'YWJj'};
 const result=toResponses({model:'remote/m',max_tokens:64,system:[{type:'text',text:'rules'}],messages:[{role:'user',content:[{type:'text',text:'first'},{type:'image',source}]},{role:'assistant',content:[{type:'text',text:'calling'},{type:'tool_use',id:'t1',name:'read',input:{file:'a'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'t1',is_error:true,content:[{type:'text',text:'failed'},{type:'image',source}]},{type:'text',text:'next'}]}],tools:[{name:'read',input_schema:{type:'object',properties:{file:{type:'string'}}}}],tool_choice:{type:'tool',name:'read',disable_parallel_tool_use:true}});
 assert.equal(result.instructions,'rules');assert.equal(result.input[0].content[1].image_url,'data:image/png;base64,YWJj');
 assert.equal(result.input[2].type,'function_call');assert.equal(result.input[2].arguments,'{"file":"a"}');
 assert.equal(result.input[3].call_id,'t1');assert.equal(result.input[3].output[0].text,'[Tool error]');
 assert.equal(result.input[4].content[0].text,'next');assert.deepEqual(result.tool_choice,{type:'function',name:'read'});assert.equal(result.parallel_tool_calls,false);
});
test('Anthropic returns real tools, max_tokens stop and separates cached input usage',()=>{
 const response={id:'r',status:'completed',output:[{type:'function_call',call_id:'t1',name:'read',arguments:'{"a":1}'}],usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:60}}};
 const a=fromResponses(response,'remote/m');assert.equal(a.stop_reason,'tool_use');assert.deepEqual(a.content[0],{type:'tool_use',id:'t1',name:'read',input:{a:1}});assert.equal(a.usage.input_tokens,40);assert.equal(a.usage.cache_read_input_tokens,60);
 assert.equal(fromResponses({...response,output:[],status:'incomplete',incomplete_details:{reason:'max_output_tokens'}},'m').stop_reason,'max_tokens');
});
test('Anthropic thinking accepts enabled/adaptive/disabled, omits historical thinking from answer text, and removes sampling for Codex',()=>{
 const b={model:'m',max_tokens:10,messages:[{role:'user',content:'hi'}]};
 for(const patch of [{max_tokens:0},{stream:'yes'},{thinking:{type:'bogus'}},{stop_sequences:['stop']},{top_k:5},{messages:[{role:'user',content:[{type:'document'}]}]}])assert.throws(()=>toResponses({...b,...patch}),e=>e.status===400);
 for(const thinking of [{type:'disabled'},{type:'enabled',budget_tokens:1024},{type:'adaptive'}])assert.doesNotThrow(()=>toResponses({...b,thinking,temperature:1,top_p:.9}));
 const mapped=toResponses({...b,thinking:{type:'enabled',budget_tokens:32000},context_management:{edits:[{type:'clear_tool_uses_20250919'}]},container:'c'});assert.equal(mapped.reasoning.effort,'high');
 const history=toResponses({...b,messages:[{role:'assistant',content:[{type:'thinking',thinking:'prior thought',signature:'sig'},{type:'redacted_thinking',data:'opaque'},{type:'text',text:'answer'}]}]});assert.deepEqual(history.input[0].content.map(x=>x.text),['answer']);
 assert.equal(toResponses({...b,messages:[{role:'user',content:'one'},{role:'system',content:[{type:'text',text:'mid-conversation rule'}]}]}).input[1].role,'developer');
});
test('Messages HTTP authenticates SDK headers and Bearer, emits Anthropic SSE, resumes tools, and reports errors',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harbor-anthropic-'));const requests=[];
 const bridge={close(){},async run(p,model,b){
  requests.push(b);if(b.input.some(i=>i.role==='user'&&i.content?.[0]?.text==='FAIL')){await new Promise(resolve=>setTimeout(resolve,10));throw new Error('private upstream error');}
  const r=responseBase(b.model);r.status='completed';r.usage={input_tokens:25,output_tokens:3,total_tokens:28};
  r.output=b.tools.length&&!b.input.some(i=>i.type==='function_call_output')?[{type:'function_call',id:'fc_1',call_id:'tool1',name:'read',arguments:'{"path":"a"}',status:'completed'}]:[{id:'msg_1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'MESSAGES_OK',annotations:[],logprobs:[]}]}];return r;
 }};
 const g=createGateway({dataDir:dir,nasAgent:bridge});g.store.upsert({id:'remote',name:'Remote',type:'nas-codex',models:['m'],sshHost:'host',sshUser:'user',container:'codex-linux',sshKeyPath:'/key'});
 await new Promise(resolve=>g.server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${g.server.address().port}/v1/messages`,key=g.store.gatewayKey();
 const call=(b,headers={'x-api-key':key,'anthropic-version':'2023-06-01'})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(b)});
 const base={model:'remote/m',max_tokens:64,messages:[{role:'user',content:'hello'}]};
 try{
  const denied=await call(base,{});assert.equal(denied.status,401);const error=await denied.json();assert.equal(error.type,'error');assert.equal(error.error.type,'authentication_error');
  const first=await call(base);assert.equal(first.status,200);const answer=await first.json();assert.equal(answer.type,'message');assert.equal(answer.content[0].text,'MESSAGES_OK');assert.equal(answer.model,'remote/m');
  const stream=await call({...base,stream:true},{authorization:'Bearer '+key});const events=[];for await(const e of sseEvents(stream.body))events.push(JSON.parse(e.data));
  assert.deepEqual(events.map(e=>e.type),['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);assert.equal(events[2].delta.text,'MESSAGES_OK');assert.equal(events.at(-2).usage.output_tokens,3);
  const tools=[{name:'read',input_schema:{type:'object',properties:{path:{type:'string'}}}}];
  const toolStream=await call({...base,tools,stream:true});const toolEvents=[];for await(const e of sseEvents(toolStream.body))toolEvents.push(JSON.parse(e.data));
  assert.equal(toolEvents[1].content_block.type,'tool_use');assert.equal(toolEvents[2].delta.type,'input_json_delta');assert.equal(toolEvents.at(-2).delta.stop_reason,'tool_use');
  const resumed=await call({...base,tools,messages:[...base.messages,{role:'assistant',content:[{type:'tool_use',id:'tool1',name:'read',input:{path:'a'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'tool1',content:'file contents'}]}]});assert.equal((await resumed.json()).content[0].text,'MESSAGES_OK');assert.ok(requests.at(-1).input.some(i=>i.type==='function_call_output'&&i.output==='file contents'));
  assert.equal((await call(base,{'x-api-key':key,'anthropic-version':'invalid'})).status,400);
  assert.equal((await call({...base,max_tokens:0})).status,400);
  const failure=await call({...base,messages:[{role:'user',content:'FAIL'}],stream:true});const failures=[];for await(const e of sseEvents(failure.body))failures.push(JSON.parse(e.data));assert.equal(failures.at(-1).type,'error');assert.equal(failures.at(-1).error.type,'api_error');assert.equal(failures.some(e=>e.type==='message_stop'),false);assert.equal(JSON.stringify(failures).includes('private upstream error'),false);
 }finally{g.server.closeAllConnections();await new Promise(resolve=>g.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});
