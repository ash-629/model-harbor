import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NasAgentBridge, toolSpecs, agentInput, validateAgent, agentCommand, outputBudget } from '../src/nas-agent.js';
import { sseEvents } from '../src/protocol.js';
import { createGateway } from '../src/server.js';

const p = { id: 'nas', type: 'nas-codex', sshHost: 'host', sshUser: 'user', container: 'codex-linux', sshKeyPath: '/keys/key', timeout: 10 };
const patch = '*** Begin Patch\n*** Add File: result.txt\n+OK\n*** End Patch';
const tools = [{ type: 'namespace', name: 'functions', tools: [
  { type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/s' } },
  { type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
] }];
function fakeLaunch({ hang = false, malformed = false, webSearch = false, echoInput = false } = {}) {
  const children = [], exchanges = []; let counter = 0;
  const launch = () => {
    const child = new EventEmitter(), serial = ++counter; let specs, step = 0;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    const emit = value => queueMicrotask(() => child.stdout.write(JSON.stringify(value) + '\n'));
    const completed = text => { emit({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } }); emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } }); };
    const call = () => {
      const tool = specs[step];
      if (!tool) return completed('CLIENT_RESULT_OK');
      emit({ id: 'rpc-' + serial + '-' + step, method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'call-' + serial + '-' + step, tool: tool.name, arguments: step ? { path: 'result.txt' } : { input: patch } } });
    };
    child.stdin = new Writable({ write(chunk, encoding, done) {
      for (const line of chunk.toString().trim().split('\n')) {
        const request = JSON.parse(line); exchanges.push(request);
        if (hang) continue;
        if (malformed) { queueMicrotask(() => child.stdout.write('invalid-json\n')); continue; }
        if (request.method === 'initialize') emit({ id: request.id, result: {} });
        else if (request.method === 'thread/start') { specs = request.params.dynamicTools; emit({ id: request.id, result: { thread: { id: 'thread' } } }); }
        else if (request.method === 'turn/start') { if (echoInput) emit({ method: 'item/started', params: { item: { type: 'userMessage', content: request.params.input } } }); emit({ id: request.id, result: { turn: { id: 'turn' } } }); if (webSearch) emit({method:'item/completed',params:{item:{type:'webSearch',id:'ws_test',query:'Python official',action:{type:'search',queries:['Python official'],query:'Python official'}}}}); call(); }
        else if (request.result) { assert.equal(request.result.contentItems[0].text, step ? 'READ_OK' : 'PATCH_OK'); step++; call(); }
      }
      done();
    } });
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', 0)); };
    children.push(child); return child;
  };
  return { launch, children, exchanges };
}

for (const execution of ['ssh-docker', 'ssh']) test(`Remote ${execution} Responses HTTP: custom + namespace, native pending tool round trips, SSE, retry and cleanup`, async () => {
  const fake = fakeLaunch(), bridge = new NasAgentBridge({ launch: fake.launch });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-agent-'));
  const gateway = createGateway({ dataDir: dir, nasAgent: bridge });
  gateway.store.upsert({ ...p, execution, name: 'Remote', models: ['model'] });
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const api = body => fetch(base + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer ' + gateway.store.gatewayKey(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const input = [{ role: 'user', content: 'Create and read result.txt' }, { type: 'additional_tools', role: 'developer', tools }];
  try {
    const initial = await api({ model: 'nas/model', input, stream: true }); assert.equal(initial.status, 200);
    const events = []; for await (const e of sseEvents(initial.body)) events.push(JSON.parse(e.data));
    assert.ok(events.some(e => e.type === 'response.custom_tool_call_input.delta' && e.delta === patch));
    assert.ok(events.some(e => e.type === 'response.custom_tool_call_input.done' && e.input === patch));
    assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
    const first = events.at(-1).response, custom = first.output[0];
    assert.equal(custom.type, 'custom_tool_call'); assert.equal(custom.namespace, 'functions'); assert.equal(custom.name, 'apply_patch'); assert.equal(custom.input, patch);
    assert.equal(fake.children.length, 1); assert.equal(fake.children[0].killed, false);
    const secondBody = { model: 'nas/model', input: [...input, ...first.output, { type: 'custom_tool_call_output', call_id: custom.call_id, output: 'PATCH_OK' }] };
    const second = await (await api(secondBody)).json(), fn = second.output[0];
    assert.equal(fn.type, 'function_call'); assert.equal(fn.name, 'read_file'); assert.equal(fn.arguments, '{"path":"result.txt"}');
    const duplicate = await (await api(secondBody)).json(); assert.deepEqual(duplicate, second); assert.equal(fake.children.length, 1);
    const finalBody = { model: 'nas/model', input: [...secondBody.input, ...second.output, { type: 'function_call_output', call_id: fn.call_id, output: 'READ_OK' }], stream: true };
    const finalEvents = []; for await (const e of sseEvents((await api(finalBody)).body)) finalEvents.push(JSON.parse(e.data));
    const last = finalEvents.at(-1).response;
    assert.equal(last.output[0].content[0].text, 'CLIENT_RESULT_OK'); assert.equal(last.model, 'nas/model'); assert.equal(last.status, 'completed');
    assert.equal(fake.children.length, 1, 'both tool results resume the SAME native turn'); assert.equal(fake.children[0].killed, true);
    assert.equal(bridge.sessions.size, 0); assert.equal(bridge.calls.size, 0);
    assert.equal(fake.exchanges.filter(e => e.method === 'thread/start').length, 1);
    const start = fake.exchanges.find(e => e.method === 'thread/start'); assert.equal(start.params.sandbox, 'read-only'); assert.equal(start.params.ephemeral, true);
    assert.equal((await api({ model: 'nas/model', input: 'hello', tools: [{ type: 'not_supported' }] })).status, 400);
    assert.equal((await api({ model: 'nas/model', input: 'hello', previous_response_id: first.id })).status, 400);
  } finally { bridge.close(); gateway.server.closeAllConnections(); await new Promise(resolve => gateway.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native web search plus local custom tools: SSE records and replay preserve the client tool round trip', async () => {
  const fake=fakeLaunch({webSearch:true}), bridge=new NasAgentBridge({launch:fake.launch});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harbor-search-')), gateway=createGateway({dataDir:dir,nasAgent:bridge});
  gateway.store.upsert({...p,models:['model']}); await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${gateway.server.address().port}`;
  const api=body=>fetch(base+'/v1/responses',{method:'POST',headers:{authorization:'Bearer '+gateway.store.gatewayKey(),'content-type':'application/json'},body:JSON.stringify(body)});
  const body={model:'nas/model',input:[{role:'user',content:'Search and patch locally'}],tools:[{type:'web_search'},...tools],stream:true};
  try {
    const response=await api(body); assert.equal(response.status,200);
    const events=[];for await(const e of sseEvents(response.body))events.push(JSON.parse(e.data));
    const first=events.at(-1).response;assert.equal(first.output[0].type,'web_search_call');assert.equal(first.output[1].type,'custom_tool_call');
    assert.ok(events.some(e=>e.type==='response.web_search_call.completed'));
    assert.equal(events.some(e=>e.type==='response.function_call_arguments.delta' && e.item_id==='ws_test'),false);
    assert.equal(fake.exchanges.find(e=>e.method==='thread/start').params.config.web_search,'live');
    const next=await api({...body,stream:false,input:[...body.input,...first.output,{type:'custom_tool_call_output',call_id:first.output[1].call_id,output:'PATCH_OK'}]});
    assert.equal(next.status,200);assert.equal((await next.json()).output[0].type,'function_call');assert.equal(fake.children.length,1);
    const local=fake.exchanges.find(e=>e.method==='thread/start').params;assert.equal(local.config['features.shell_tool'],false);assert.equal(local.config['features.apply_patch_freeform'],false);
  } finally {bridge.close();gateway.server.closeAllConnections();await new Promise(resolve=>gateway.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});

test('native search policies respect none/forced choice and explicit search options', () => {
  const config=toolSpecs([{type:'web_search',external_web_access:false,search_context_size:'low',filters:{allowed_domains:['python.org']},user_location:{type:'approximate',country:'US'}}]).webSearch;
  assert.equal(config.mode,'cached');assert.equal(config.options.context_size,'low');assert.deepEqual(config.options.allowed_domains,['python.org']);assert.deepEqual(config.options.location,{country:'US'});
  assert.equal(toolSpecs([{type:'web_search'}],'none').webSearch.mode,'disabled');
  const forced=toolSpecs([{type:'web_search'},...tools],{type:'web_search'});assert.equal(forced.specs.length,0);assert.equal(forced.webSearch.mode,'live');
  assert.doesNotThrow(()=>toolSpecs([{type:'web_search'}],'required'));
  assert.equal(toolSpecs([{type:'web_search_preview',external_web_access:false}]).webSearch.mode,'live');
  assert.throws(()=>toolSpecs([{type:'web_search',unmapped:true}]),/unmapped/);
});

test('text search content declarations map to native text search without inventing config options', () => {
  for (const type of ['web_search','web_search_preview','web_search_preview_2025_03_11']) {
    const defaultSearch=toolSpecs([{type}]).webSearch;
    for (const search_content_types of [null,[],['text'],['text','text']]) assert.deepEqual(toolSpecs([{type,search_content_types}]).webSearch,defaultSearch);
    assert.equal(toolSpecs([{type,search_content_types:['image']}]).webSearch.mode,'disabled');
    const mixed=toolSpecs([{type,search_content_types:['text','image']}]).webSearch;
    assert.equal(mixed.mode,'live');assert.deepEqual(mixed.unsupportedContentTypes,['image']);
    assert.throws(()=>toolSpecs([{type,search_content_types:['image']}],{type}),/图片搜索/);
    assert.throws(()=>toolSpecs([{type,search_content_types:'text'}]),/text\/image/);
    assert.throws(()=>toolSpecs([{type,search_content_types:['video']}]),/text\/image/);
  }
  assert.doesNotThrow(()=>toolSpecs([{type:'web_search',search_content_types:['text'],user_location:{type:'approximate',country:null,city:null}}]));
});

test('default GUI content types do not block chat and disclose the unsupported image capability', async () => {
  for (const search_content_types of [['text'],['text','image'],['image']]) {
    const fake=fakeLaunch(),bridge=new NasAgentBridge({launch:fake.launch});
    try {
      const response=await bridge.run(p,'model',{model:'nas/model',input:'hello',tools:[{type:'web_search',search_content_types}]},'responses');
      assert.equal(response.status,'completed');
      const start=fake.exchanges.find(e=>e.method==='thread/start');
      assert.equal(start.params.config.web_search,search_content_types.length===1 && search_content_types[0]==='image'?'disabled':'live');
      assert.equal(start.params.config['tools.web_search']?.search_content_types,undefined,'no unsupported config field is invented');
      if(search_content_types.includes('image')) {assert.equal(response.metadata.model_harbor_unsupported_search_content_types,'image');assert.match(start.params.baseInstructions,/Native image search is unavailable/);}
    } finally {bridge.close();}
  }
});

test('NAS tool spec validation, Chat shape, restricted command and disabled tools', () => {
  const mapped = toolSpecs(tools); assert.equal(mapped.specs.length, 2); assert.equal(mapped.specs[0].inputSchema.properties.input.type, 'string');
  assert.match(mapped.specs[0].description, /grammar/);
  assert.equal(toolSpecs(tools, 'none').specs.length, 0);
  assert.equal(toolSpecs(tools, { type: 'custom', name: 'apply_patch', namespace: 'functions' }).specs.length, 1);
  assert.throws(() => toolSpecs([{ type: 'function', name: 'x' }, { type: 'function', name: 'x' }]), /重复/);
  assert.throws(() => toolSpecs(tools, { type: 'function', name: 'absent' }), /不存在/);
  assert.throws(() => validateAgent({ input: 'hi', temperature: 1 }), /temperature/);
  const body = agentInput({ messages: [{ role: 'tool', tool_call_id: 'id', content: 'ok' }], tools: [{ type: 'function', function: { name: 'read_file' } }] }, 'chat/completions');
  assert.equal(body.input[0].call_id, 'id'); assert.equal(body.tools[0].name, 'read_file');
  const command = agentCommand(p); assert.equal(command.command, 'ssh'); assert.match(command.args.at(-1), /'app-server'/); assert.match(command.args.at(-1), /'features.shell_tool=false'/);
  assert.equal(command.args.at(-1).includes('input'), false, 'no user content is interpolated into the shell');
});

test('NAS Chat HTTP returns function calls, accepts client tool results and streams the final answer', async () => {
  const fake = fakeLaunch(), bridge = new NasAgentBridge({ launch: fake.launch });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-agent-chat-')), gateway = createGateway({ dataDir: dir, nasAgent: bridge });
  gateway.store.upsert({ ...p, name: 'NAS', models: ['model'] });
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  const api = body => fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer ' + gateway.store.gatewayKey(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const body = { model: 'nas/model', max_tokens: 4096, messages: [{ role: 'user', content: 'write file' }], tools: [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object', properties: { input: { type: 'string' } } } } }] };
    const first = await (await api(body)).json();
    assert.equal(first.metadata.model_harbor_output_limit, 'hint'); assert.equal(first.choices[0].finish_reason, 'tool_calls'); assert.equal(first.choices[0].message.tool_calls[0].function.name, 'write_file');
    const result = await api({ ...body, messages: [...body.messages, first.choices[0].message, { role: 'tool', tool_call_id: first.choices[0].message.tool_calls[0].id, content: 'PATCH_OK' }], stream: true });
    const events = []; for await (const e of sseEvents(result.body)) events.push(e.data === '[DONE]' ? '[DONE]' : JSON.parse(e.data));
    assert.equal(events[0].choices[0].delta.content, 'CLIENT_RESULT_OK'); assert.equal(events.at(-1), '[DONE]'); assert.equal(fake.children.length, 1); assert.equal(bridge.sessions.size, 0);
    const plain=await (await api({model:'nas/model',messages:[{role:'user',content:'hello'}],max_tokens:1024})).json();assert.equal(plain.choices[0].message.content,'CLIENT_RESULT_OK');assert.equal(plain.metadata.model_harbor_requested_output_tokens,'1024');
  } finally { bridge.close(); gateway.server.closeAllConnections(); await new Promise(resolve => gateway.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('NAS sessions enforce capacity, release idle workers, timeout and cancellation', async () => {
  const fake = fakeLaunch(), bridge = new NasAgentBridge({ launch: fake.launch, idleMs: 25, maxSessions: 1 });
  const body = { model: 'nas/model', input: 'tool', tools };
  await bridge.run(p, 'model', body, 'responses');
  await assert.rejects(bridge.run(p, 'model', body, 'responses'), e => e.status === 429);
  await new Promise(resolve => setTimeout(resolve, 45)); assert.equal(fake.children[0].killed, true); assert.equal(bridge.sessions.size, 0);
  bridge.close();
  for (const useAbort of [false, true]) {
    const stalled = fakeLaunch({ hang: true }), b = new NasAgentBridge({ launch: stalled.launch }), controller = new AbortController();
    const promise = b.run({ ...p, timeout: 0.03 }, 'model', body, 'responses', controller.signal);
    if (useAbort) controller.abort();
    await assert.rejects(promise); assert.equal(stalled.children[0].killed, true); assert.equal(b.sessions.size, 0); b.close();
  }
  const malformed = fakeLaunch({ malformed: true }), b = new NasAgentBridge({ launch: malformed.launch });
  await assert.rejects(b.run(p, 'model', body, 'responses'), e => e.status === 502); assert.equal(b.sessions.size, 0); b.close();
});


test('desktop GUI discovery declarations, long MCP names and discovered tool schemas are compatible', () => {
  const longName='mcp__codex_apps__codex_document_control_get_document_tool_schemas';
  assert.ok(longName.length>64 && longName.length<=128);
  const mapped=toolSpecs([{type:'tool_search',execution:'server'},{type:'programmatic_tool_calling',enabled:false},{type:'namespace',name:'plugins',tools:[{type:'function',name:longName,parameters:{type:'object',properties:{}}}]}]);
  assert.equal(mapped.specs.length,1); assert.equal([...mapped.mappings.values()][0].name,longName);
  assert.ok(mapped.specs[0].name.length<=64,'internal aliases remain valid for NAS Codex');
  const legacy=toolSpecs([{type:'function',function:{name:'legacy',parameters:{type:'object'}}}]);assert.equal(legacy.specs.length,1);
  const clientSearch=toolSpecs([{type:'tool_search',execution:'client',parameters:{type:'object',properties:{query:{type:'string'}}}}]);
  assert.equal([...clientSearch.mappings.values()][0].type,'tool_search');
  const normalized=agentInput({input:[{role:'user',content:'hi'},{type:'additional_tools',role:'developer',tools},{type:'tool_search_call',execution:'client',call_id:'search1',arguments:{query:'files'}},{type:'tool_search_output',execution:'client',call_id:'search1',tools:[{type:'namespace',name:'functions',tools:[{type:'function',name:'new_tool',parameters:{type:'object'}}]}]}]},'responses');
  assert.equal(toolSpecs(normalized.tools).specs.length,3);assert.equal(validateAgent(normalized).outputs[0].call_id,'search1');
  assert.throws(()=>toolSpecs([{type:'unknown',name:'test'}]), /type=unknown, name=test/);
});

test('GUI hosted discovery declaration no longer rejects real HTTP tool calls', async () => {
  const fake=fakeLaunch(),bridge=new NasAgentBridge({launch:fake.launch});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harbor-gui-')),gateway=createGateway({dataDir:dir,nasAgent:bridge});gateway.store.upsert({...p,name:'NAS',models:['model']});
  await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer '+gateway.store.gatewayKey(),'content-type':'application/json'},body:JSON.stringify({model:'nas/model',max_tokens:8192,max_output_tokens:4096,input:[{role:'user',content:'write file'},{type:'additional_tools',role:'developer',tools}],tools:[{type:'tool_search',execution:'server'},{type:'programmatic_tool_calling',enabled:false}],stream:true})});
    assert.equal(response.status,200);const events=[];for await(const e of sseEvents(response.body))events.push(JSON.parse(e.data));
    assert.equal(events[0].response.max_output_tokens,4096);assert.equal(events.at(-1).response.metadata.model_harbor_output_limit,'hint');assert.equal(events.at(-1).response.output[0].type,'custom_tool_call');assert.equal(events.at(-1).response.output[0].input,patch);
  } finally {bridge.close();gateway.server.closeAllConnections();await new Promise(resolve=>gateway.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});


test('GUI max_tokens aliases are validated, disclosed and sent as a generation budget hint', async () => {
  assert.equal(outputBudget({max_tokens:4096}),4096);
  assert.equal(outputBudget({max_tokens:8192,max_output_tokens:4096,max_completion_tokens:6000}),4096);
  assert.equal(outputBudget({max_tokens:null}),undefined);
  for(const value of [0,-1,1.5,'4096',true,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>validateAgent({input:'hi',max_tokens:value}),/正整数/);
  for(const field of ['max_tokens','max_completion_tokens','max_output_tokens']) {
    const fake=fakeLaunch(),bridge=new NasAgentBridge({launch:fake.launch});
    try {
      const body={model:'nas/model',input:'hello',[field]:4096};
      const response=await bridge.run(p,'model',body,'responses');
      assert.equal(response.status,'completed');assert.equal(response.max_output_tokens,4096);assert.equal(response.metadata.model_harbor_output_limit,'hint');
      const start=fake.exchanges.find(e=>e.method==='thread/start');assert.match(start.params.baseInstructions,/output budget of 4096 tokens/);
      assert.equal(start.params.config.max_tokens,undefined);assert.equal(start.params.config.model_max_output_tokens,undefined,'do not invent an unsupported native setting');
    } finally {bridge.close();}
  }
});


test('model switch rejects oversized history before launching remote inference', async () => {
  const fake = fakeLaunch(), bridge = new NasAgentBridge({ launch: fake.launch });
  try {
    await assert.rejects(bridge.run(p, 'model', {model:'nas/model',input:'x'.repeat(1048576)}, 'responses'), e => e.code === 'remote_input_too_large');
    assert.equal(fake.children.length, 0);
  } finally { bridge.close(); }
});
