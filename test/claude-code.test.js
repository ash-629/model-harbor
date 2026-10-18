import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { ClaudeCodeBridge,claudeModels,claudeToolCommand } from '../src/claude-code.js';
import { claudeContext,claudeSchema,claudePrompt,claudeResult } from '../src/claude-tools.js';
import { matchesSchema } from '../src/tool-schema.js';
import { createGateway } from '../src/server.js';
import { sseEvents } from '../src/protocol.js';

const provider={id:'claude',name:'Claude',type:'claude-code',execution:'ssh-docker',sshHost:'192.0.2.10',sshUser:'example-user',sshKeyPath:'/keys/key',container:'claude-linux',claudePath:'claude',models:['sonnet'],timeout:10};
const fn={type:'function',name:'run_command',parameters:{type:'object',properties:{cmd:{type:'string',minLength:1}},required:['cmd'],additionalProperties:false}};
const custom={type:'custom',name:'apply_patch',format:{type:'grammar',syntax:'lark',definition:'start: /.+/s'}};
const tools=[{type:'namespace',name:'functions',tools:[fn,custom]}];
const body={model:'claude/sonnet',input:'Do the task',tools,store:false};
const ok=value=>({type:'result',subtype:'success',is_error:false,structured_output:value,usage:{input_tokens:3,cache_read_input_tokens:5,cache_creation_input_tokens:7,output_tokens:11}});
const call=(alias,args)=>({kind:'tool_calls',text:'',calls:[{tool:alias,arguments:args}]});
const final=text=>({kind:'final',text,calls:[]});

test('Claude SSH/SSH+Docker providers advertise client tools and use a fixed runner',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-'));
 try{const store=new Store(dir);store.upsert(provider);assert.deepEqual(store.models()[0].capabilities,{tools:true,custom_tools:true,text:true,cli_bridge:true});assert.deepEqual(claudeModels(),['sonnet','opus','haiku']);
 assert.equal(claudeToolCommand(provider).at(-1),'claude');assert.equal(claudeToolCommand({...provider,execution:'ssh'})[0],'timeout');
 assert.throws(()=>store.upsert({...provider,id:'bad',claudePath:'../evil'}),/路径/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('namespace, custom grammar, long names, discovery and scoped JSON Schema survive mapping',()=>{
 const name='mcp__codex_apps__codex_document_control_get_document_tool_schemas';
 const c=claudeContext({...body,tools:[{type:'tool_search',execution:'server'},{type:'programmatic_tool_calling',enabled:false},...tools],input:[{role:'user',content:'hello'},{type:'additional_tools',tools:[{type:'function',name,parameters:{type:'object',$defs:{word:{type:'string'}},properties:{x:{$ref:'#/$defs/word'}}}}]}]},'responses');
 assert.equal(c.specs.length,3);assert.equal(c.mappings.get('t3').name,name);assert.equal(c.mappings.get('t1').namespace,'functions');assert.match(c.specs[1].description,/grammar/);
 const s=claudeSchema(c);assert.equal(s.$defs.t3.properties.x.$ref,'#/$defs/t3/$defs/word');assert.ok(matchesSchema({x:'ok'},c.specs[2].inputSchema));
 assert.match(claudePrompt(c),/REAL available capabilities/);
 const r=claudeResult(ok(call('t3',{x:'yes'})),c,body.model);assert.equal(r.output[0].name,name);assert.equal(r.usage.input_tokens,15);assert.equal(r.usage.total_tokens,26);
});

test('tool calls and results retain IDs, namespaces, multiline custom inputs and image blocks',()=>{
 const png='data:image/png;base64,iVBORw0KGgo=';
 const input=[{role:'user',content:'write and inspect'},{type:'custom_tool_call',call_id:'patch1',namespace:'functions',name:'apply_patch',input:'*** Begin Patch\n+ok\n*** End Patch'},{type:'custom_tool_call_output',call_id:'patch1',output:[{type:'input_text',text:'PATCH_OK'},{type:'input_image',image_url:png}]},{type:'function_call',call_id:'run1',name:'run_command',arguments:'{"cmd":"echo ok"}'},{type:'function_call_output',call_id:'run1',output:'{"exit_code":1,"error":"not found"}'}];
 const c=claudeContext({...body,input},'responses');assert.equal(c.transcript[1].input,input[1].input);assert.equal(c.transcript[2].call_id,'patch1');assert.match(c.transcript.at(-1).output,/exit_code/);assert.equal(c.images.length,1);assert.equal(c.images[0].source.media_type,'image/png');
 const r=claudeResult(ok(call('t2',{input:input[1].input})),c,body.model);assert.equal(r.output[0].type,'custom_tool_call');assert.equal(r.output[0].namespace,'functions');assert.equal(r.output[0].input,input[1].input);
});

test('invalid aliases, schemas, forced choice, parallel limits and malformed envelopes never emit actions',()=>{
 const c=claudeContext(body,'responses');
 for(const v of [call('missing',{}),call('t1',{}),call('t1',{cmd:7}),call('t1',{cmd:'ok',extra:1}),call('t2',{input:7}),{kind:'final',text:'done',calls:[{tool:'t1',arguments:{cmd:'x'}}]},{kind:'tool_calls',text:'',calls:[]},{...final('ok'),extra:1}])assert.throws(()=>claudeResult(ok(v),c,body.model),e=>e.status===502);
 const none=claudeContext({...body,tool_choice:'none'},'responses');assert.throws(()=>claudeResult(ok(call('t1',{cmd:'x'})),none,body.model));
 const forced=claudeContext({...body,tool_choice:{type:'function',namespace:'functions',name:'run_command'}},'responses');assert.equal(forced.specs.length,1);assert.throws(()=>claudeResult(ok(final('no')),forced,body.model));
 const serial=claudeContext({...body,parallel_tool_calls:false},'responses');assert.throws(()=>claudeResult(ok({kind:'tool_calls',text:'',calls:[{tool:'t1',arguments:{cmd:'x'}},{tool:'t1',arguments:{cmd:'y'}}]}),serial,body.model));
 for(const raw of [{...body,previous_response_id:'old'},{...body,store:true},{...body,tools:{}},{...body,input:[{type:'function_call_output',call_id:'missing',output:'ok'}]},{...body,input:[{role:'user',content:[{type:'input_image',image_url:'http://example.test/a.png'}]}]},{...body,input:[{role:'user',content:[{type:'input_file',file_id:'abc'}]}]}])assert.throws(()=>claudeContext(raw,'responses'),e=>e.status===400);
 assert.throws(()=>claudeResult({subtype:'success',result:'{"kind":"final"}'},c,body.model),e=>e.status===502,'never parse arbitrary prose as tool JSON');
});

test('local schema validation covers composition, constraints, arrays, refs and Unicode',()=>{
 assert.equal(matchesSchema({a:'x'},{type:'object',properties:{a:{$ref:'#/$defs/s'}},required:['a'],additionalProperties:false,$defs:{s:{type:'string',minLength:2}}}),false);
 assert.equal(matchesSchema(['x','x'],{type:'array',uniqueItems:true}),false);
 assert.equal(matchesSchema('💡',{type:'string',maxLength:1}),true);
 assert.equal(matchesSchema(3,{type:'integer',minimum:1,multipleOf:2}),false);
 assert.equal(matchesSchema({a:1},{anyOf:[{required:['a']},{required:['b']}]}),true);
 assert.equal(matchesSchema({a:1},{oneOf:[{required:['a']},{type:'object'}]}),false);
 assert.equal(matchesSchema({a:1},{dependentRequired:{a:['b']}}),false);
 assert.equal(matchesSchema([{a:2}],{items:{properties:{a:{const:1}}}}),false);
});

test('tool discovery results merge schemas and return client tool_search calls',()=>{
 const search={type:'tool_search',execution:'client',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}};
 const first=claudeContext({...body,tools:[search]},'responses');
 const r=claudeResult(ok(call('t1',{query:'browser'})),first,body.model);assert.equal(r.output[0].type,'tool_search_call');assert.equal(r.output[0].execution,'client');
 const next=claudeContext({...body,tools:[search],input:[{role:'user',content:'browse'},r.output[0],{type:'tool_search_output',call_id:r.output[0].call_id,tools:[fn]}]},'responses');assert.equal(next.specs.length,2);assert.match(next.transcript.at(-1).output,/run_command/);
});

test('hosted declarations are disclosed, forced hosted tools fail, tool budgets remain hints',()=>{
 const c=claudeContext({...body,tools:[{type:'web_search'},...tools],max_tokens:100,max_output_tokens:200},'responses');const r=claudeResult(ok(final('ok')),c,body.model);assert.equal(r.metadata.model_harbor_unsupported_hosted_tools,'web_search');assert.equal(r.metadata.model_harbor_requested_output_tokens,'100');
 assert.throws(()=>claudeContext({...body,tools:[{type:'web_search'}],tool_choice:{type:'web_search'}},'responses'),e=>e.status===400);
 assert.throws(()=>claudeSchema(claudeContext({...body,tools:[{...fn,parameters:{type:'object',description:'a'.repeat(120000)}}]},'responses')),/110000/);
});

for(const endpoint of ['responses','chat/completions','messages'])test(`Claude ${endpoint}: actual gateway protocol, sequential client actions, SSE and final result`,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-http-'));let turn=0;const requests=[];
 const bridge=new ClaudeCodeBridge({remote:async(p,command,stdin)=>{const r=JSON.parse(stdin);requests.push(r);assert.equal(command.includes('--tools'),false);assert.match(command.join(' '),/claude-tool-runner.py/);assert.equal(r.schema.type,'object');
 const value=turn++===0?call('t1',{cmd:'echo TOOL_OK'}):final('RESULT_OK');return JSON.stringify(ok(value));}});
 const gw=createGateway({dataDir:dir,claudeBridge:bridge});gw.store.upsert(provider);await new Promise(resolve=>gw.server.listen(0,'127.0.0.1',resolve));
 const api=async b=>{const r=await fetch(`http://127.0.0.1:${gw.server.address().port}/v1/${endpoint}`,{method:'POST',headers:{authorization:'Bearer '+gw.store.gatewayKey(),'content-type':'application/json'},body:JSON.stringify(b)});assert.equal(r.status,200);return r;};
 try{
  let request,output,callId;
  if(endpoint==='responses')request={...body,tools:[fn],stream:true};
  else if(endpoint==='chat/completions')request={model:body.model,messages:[{role:'user',content:'run the command'}],tools:[{type:'function',function:{...fn,type:undefined}}],stream:true};
  else request={model:body.model,max_tokens:2000,messages:[{role:'user',content:'run the command'}],tools:[{name:fn.name,input_schema:fn.parameters}],stream:true};
  const response=await api(request),events=[];for await(const e of sseEvents(response.body))events.push(e.data==='[DONE]'?'[DONE]':JSON.parse(e.data));
  if(endpoint==='responses'){
   assert.ok(events.some(e=>e.type==='response.function_call_arguments.delta'));assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i));output=events.at(-1).response.output;callId=output[0].call_id;request={...request,stream:false,input:[{role:'user',content:'run the command'},...output,{type:'function_call_output',call_id:callId,output:'TOOL_OK'}]};
  }else if(endpoint==='chat/completions'){
   const tc=events[0].choices[0].delta.tool_calls[0];callId=tc.id;assert.equal(events.at(-1),'[DONE]');assert.equal(events.at(-3).choices[0].finish_reason,'tool_calls');request={...request,stream:false,messages:[...request.messages,{role:'assistant',content:null,tool_calls:[tc]},{role:'tool',tool_call_id:callId,content:'TOOL_OK'}]};
  }else{
   const tc=events.find(e=>e.type==='content_block_start').content_block;callId=tc.id;assert.equal(events.at(-1).type,'message_stop');assert.equal(events.at(-2).delta.stop_reason,'tool_use');request={...request,stream:false,messages:[...request.messages,{role:'assistant',content:[{type:'tool_use',id:callId,name:fn.name,input:{cmd:'echo TOOL_OK'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:callId,content:'TOOL_OK'}]}]};
  }
  const result=await(await api(request)).json();assert.match(JSON.stringify(result),/RESULT_OK/);assert.match(requests[1].prompt,/TOOL_OK/);assert.match(requests[1].prompt,new RegExp(callId));assert.equal(bridge.active,0);
 }finally{gw.server.closeAllConnections();await new Promise(resolve=>gw.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});

test('custom SSE preserves raw patch and namespace, invalid CLI output has no completed event',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-custom-'));let broken=false;
 const patch='*** Begin Patch\n*** Add File: demo.txt\n+OK\n*** End Patch';
 const bridge=new ClaudeCodeBridge({remote:async()=>JSON.stringify(broken?{subtype:'success',result:'fake'}:ok(call('t2',{input:patch})))});
 const gw=createGateway({dataDir:dir,claudeBridge:bridge});gw.store.upsert(provider);await new Promise(resolve=>gw.server.listen(0,'127.0.0.1',resolve));
 try{const api=()=>fetch(`http://127.0.0.1:${gw.server.address().port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer '+gw.store.gatewayKey(),'content-type':'application/json'},body:JSON.stringify({...body,stream:true})});
 let events=[];for await(const e of sseEvents((await api()).body))events.push(JSON.parse(e.data));assert.equal(events.find(e=>e.type==='response.custom_tool_call_input.delta').delta,patch);assert.equal(events.at(-1).response.output[0].namespace,'functions');
 broken=true;events=[];for await(const e of sseEvents((await api()).body))events.push(JSON.parse(e.data));assert.equal(events.some(e=>e.type==='response.completed'),false);assert.ok(events.some(e=>e.type==='error'));
 }finally{gw.server.closeAllConnections();await new Promise(resolve=>gw.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});

test('bridge cancellation, failures and concurrency do not leak active slots',async()=>{
 let finish;const pending=new Promise(resolve=>finish=resolve);const bridge=new ClaudeCodeBridge({maxConcurrent:1,remote:()=>pending});
 const controller=new AbortController(),first=bridge.run(provider,'sonnet',body,'responses',controller.signal);await assert.rejects(bridge.run(provider,'sonnet',body,'responses'),e=>e.status===429);controller.abort();finish(JSON.stringify(ok(final('ok'))));await assert.rejects(first,e=>e.status===499);assert.equal(bridge.active,0);
 const fail=new ClaudeCodeBridge({remote:async()=>{throw new Error('network');}});await assert.rejects(fail.run(provider,'sonnet',body,'responses'));assert.equal(fail.active,0);
});

test('schema data keys and defaults are preserved while only schema pointers are rewritten',()=>{
 const parameters={type:'object',properties:{'$ref':{type:'string'},metadata:{const:{'$id':'literal-id','$ref':'literal-data'}},value:{type:'object',properties:{'$id':{type:'string'}}}},$defs:{s:{type:'string'}},default:{'$ref':'default-is-data'}};
 const c=claudeContext({...body,tools:[{...fn,parameters}],text:{format:{type:'text'}}},'responses'),s=claudeSchema(c).$defs.t1;
 assert.deepEqual(s.properties,parameters.properties);assert.deepEqual(s.default,parameters.default);
 assert.equal(matchesSchema('x',{if:false,else:{const:'y'}}),false);assert.equal(matchesSchema({a:1},{propertyNames:false}),false);assert.equal(matchesSchema([1],{contains:false}),false);assert.equal(matchesSchema('x',{not:false}),true);
});
