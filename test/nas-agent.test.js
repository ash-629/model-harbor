import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NasAgentBridge, historyItems, toolSpecs, fitToolSpecs, deferToolSpecs, agentInput, validateAgent, agentCommand, outputBudget } from '../src/nas-agent.js';
import { sseEvents } from '../src/protocol.js';
import { createGateway } from '../src/server.js';

const p = { id: 'nas', type: 'nas-codex', sshHost: 'host', sshUser: 'user', container: 'codex-linux', sshKeyPath: '/keys/key', timeout: 10 };
const patch = '*** Begin Patch\n*** Add File: result.txt\n+OK\n*** End Patch';
const tools = [{ type: 'namespace', name: 'functions', tools: [
  { type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/s' } },
  { type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
] }];
function fakeLaunch({ hang = false, malformed = false, webSearch = false, echoInput = false, streamText = false, errorEvent = null, unknownTool = false } = {}) {
  const children = [], exchanges = []; let counter = 0;
  const launch = () => {
    const child = new EventEmitter(), serial = ++counter; let specs, step = 0;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    const emit = value => queueMicrotask(() => child.stdout.write(JSON.stringify(value) + '\n'));
    const completed = text => {
      const id = 'msg_' + serial;
      if (streamText) {
        emit({ method: 'item/started', params: { item: { type: 'agentMessage', id, text: '', phase: 'final_answer' } } });
        for (const delta of String(text).match(/.{1,4}/g) || []) emit({ method: 'item/agentMessage/delta', params: { itemId: id, delta } });
      }
      emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id, text, phase: 'final_answer' } } });
      emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    };
    const flatten = value => (value || []).flatMap(spec => spec.type === 'namespace' ? spec.tools.map(tool => ({ ...tool, namespace: spec.name })) : [{ ...spec, namespace: null }]);
    const call = () => {
      const tool = flatten(specs)[step];
      if (!tool) return completed('CLIENT_RESULT_OK');
      emit({ id: 'rpc-' + serial + '-' + step, method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'call-' + serial + '-' + step, tool: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: step ? { path: 'result.txt' } : { input: patch } } });
    };
    child.stdin = new Writable({ write(chunk, encoding, done) {
      for (const line of chunk.toString().trim().split('\n')) {
        const request = JSON.parse(line); exchanges.push(request);
        if (hang) continue;
        if (malformed) { queueMicrotask(() => child.stdout.write('invalid-json\n')); continue; }
        if (request.method === 'initialize') emit({ id: request.id, result: {} });
        else if (request.method === 'thread/start') { specs = request.params.dynamicTools; emit({ id: request.id, result: { thread: { id: 'thread' } } }); }
        else if (request.method === 'thread/inject_items') emit({ id: request.id, result: {} });
        else if (request.method === 'model/list') emit({ id: request.id, result: { data: [{ id: 'model', hidden: false }, { id: 'hidden-model', hidden: true }], nextCursor: null } });
        else if (request.method === 'turn/start') { if (echoInput) emit({ method: 'item/started', params: { item: { type: 'userMessage', content: request.params.input } } }); emit({ id: request.id, result: { turn: { id: 'turn' } } }); if (errorEvent) { emit({ method: 'error', params: { message: errorEvent, willRetry: false } }); continue; } if (unknownTool) { emit({ id: 'rpc-bad', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'bad', tool: 'client_missing_0', arguments: {} } }); continue; } if (webSearch) emit({method:'item/completed',params:{item:{type:'webSearch',id:'ws_test',query:'Python official',action:{type:'search',queries:['Python official'],query:'Python official'}}}}); call(); }
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

test('tool result after app-server loss reconstructs history instead of rejecting the continuation', async () => {
  const fake = fakeLaunch(), bridge = new NasAgentBridge({ launch: fake.launch });
  try {
    const body = { model: 'nas/model', input: [{ role: 'user', content: 'Create and read result.txt' }], tools };
    const first = await bridge.run(p, 'model', body, 'responses');
    const call = first.output.find(i => i.type === 'custom_tool_call');
    assert.ok(call);
    fake.children[0].kill();
    await new Promise(resolve => setImmediate(resolve));
    const continuation = { model: 'nas/model', tools, input: [...body.input, ...first.output, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'PATCH_OK' }] };
    const second = await bridge.run(p, 'model', continuation, 'responses');
    assert.equal(second.metadata.model_harbor_session, 'reconstructed_after_tool_result');
    assert.equal(fake.children.length, 2);
    const injected = fake.exchanges.filter(e => e.method === 'thread/inject_items').flatMap(e => e.params.items);
    assert.ok(injected.some(i => i.type === 'custom_tool_call' && i.call_id === call.call_id));
    assert.ok(injected.some(i => i.type === 'custom_tool_call_output' && i.call_id === call.call_id));
    const turn = fake.exchanges.filter(e => e.method === 'turn/start').at(-1);
    assert.match(turn.params.input[0].text, /tool result above/i);
  } finally { bridge.close(); }
});

test('changed client tool catalog reconstructs a pending tool continuation', async () => {
  const fake = fakeLaunch(), bridge = new NasAgentBridge({ launch: fake.launch });
  try {
    const body = { model: 'nas/model', input: [{ role: 'user', content: 'Create and read result.txt' }], tools };
    const first = await bridge.run(p, 'model', body, 'responses');
    const call = first.output.find(i => i.type === 'custom_tool_call');
    const extra = { type: 'function', name: 'extra_tool', parameters: { type: 'object', properties: { x: { type: 'string' } } } };
    const continuation = { model: 'nas/model', tools: [...tools, extra], input: [...body.input, ...first.output, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'PATCH_OK' }] };
    const second = await bridge.run(p, 'model', continuation, 'responses');
    assert.equal(second.metadata.model_harbor_session, 'reconstructed_after_tool_result');
    assert.equal(fake.children.length, 2);
    assert.equal(fake.children[0].killed, true);
  } finally { bridge.close(); }
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
  assert.match(command.args.at(-1), /model_provider="openai-mh"/);
  assert.match(command.args.at(-1), /stream_idle_timeout_ms=180000/);
  assert.match(command.args.at(-1), /7200s/);
  assert.equal(command.args.at(-1).includes('input'), false, 'no user content is interpolated into the shell');
});

test('tool spec compaction fits the app-server budget and preserves property names', () => {
 const specs = toolSpecs([{ type: 'namespace', name: 'functions', tools: [{
   type: 'function', name: 'probe', parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' } }, required: ['title'] }
 }] }]).specs;
 specs[0].description = 'x'.repeat(2000000);
 const fitted = fitToolSpecs(specs, 900 * 1024);
 assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 900 * 1024);
 assert.equal(fitted[0].inputSchema.properties.title.type, 'string');
 assert.equal(fitted[0].inputSchema.properties.description.type, 'string');
});

test('deferToolSpecs keeps core tools eager and namespaces the long tail', () => {
 const raw = [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/s' } }];
 for (let i = 0; i < 40; i++) raw.push({ type: 'function', name: 'tool_' + i, parameters: { type: 'object', properties: { x: { type: 'string' } } } });
 const mapped = toolSpecs(raw);
 const result = deferToolSpecs(mapped.specs, mapped.mappings, { mode: 'auto', minTools: 24, minBytes: 1, groupSize: 12, maxEager: 10, minEager: 4 });
 assert.ok(result.stats.deferred > 0);
 assert.ok(result.stats.namespaces >= 1);
 assert.equal(result.stats.eager + result.stats.deferred, mapped.specs.length);
 const eager = result.specs.filter(s => s.type === 'function');
 assert.ok(eager.some(s => mapped.mappings.get(s.name)?.name === 'apply_patch'));
 const namespaces = result.specs.filter(s => s.type === 'namespace');
 assert.ok(namespaces.every(n => n.tools.every(t => t.type === 'function' && t.deferLoading === true)));
});

test('deferToolSpecs leaves small tool sets unchanged and can be forced', () => {
 const mapped = toolSpecs([{ type: 'function', name: 'read_file', parameters: { type: 'object' } }, { type: 'function', name: 'other', parameters: { type: 'object' } }]);
 const auto = deferToolSpecs(mapped.specs, mapped.mappings, { mode: 'auto', minTools: 24, minBytes: 48 * 1024 });
 assert.equal(auto.stats.deferred, 0);
 assert.deepEqual(auto.specs, mapped.specs);
 const forced = deferToolSpecs(mapped.specs, mapped.mappings, { mode: 'always', minEager: 1, groupSize: 10 });
 assert.ok(forced.stats.deferred >= 1);
 assert.ok(forced.specs.some(s => s.type === 'namespace'));
});

test('deferToolSpecs caps eager schema bytes and moves large non-core tools to namespaces', () => {
 const raw = Array.from({ length: 7 }, (_, i) => ({ type: 'function', name: 'tool_' + i, description: 'd'.repeat(20000), parameters: { type: 'object', properties: { x: { type: 'string' } } } }));
 const mapped = toolSpecs(raw);
 const result = deferToolSpecs(mapped.specs, mapped.mappings, { mode: 'always', groupSize: 12, minEager: 4, maxEagerBytes: 32 * 1024 });
 const eagerBytes = result.specs.filter(s => s.type === 'function').reduce((n, s) => n + Buffer.byteLength(JSON.stringify(s)), 0);
 assert.ok(eagerBytes <= 32 * 1024);
 assert.ok(result.stats.deferred > 0);
 assert.ok(result.specs.some(s => s.type === 'namespace'));
});

test('fitToolSpecs preserves deferred namespaces and deferLoading flags', () => {
 const raw = Array.from({ length: 30 }, (_, i) => ({ type: 'function', name: 'tool_' + i, description: 'd'.repeat(2000), parameters: { type: 'object', properties: { ['p' + i]: { type: 'string', description: 'x'.repeat(2000) } } } }));
 const mapped = toolSpecs(raw);
 const result = deferToolSpecs(mapped.specs, mapped.mappings, { mode: 'always', groupSize: 10, minEager: 2 });
 const fitted = fitToolSpecs(result.specs, 900 * 1024);
 const namespaces = fitted.filter(s => s.type === 'namespace');
 assert.ok(namespaces.length >= 1);
 assert.ok(namespaces.every(n => n.tools.every(t => t.deferLoading === true && t.inputSchema)));
 assert.ok(fitted.filter(s => s.type === 'function').every(s => s.deferLoading === undefined));
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
  const fake = fakeLaunch(), bridge = new NasAgentBridge({ launch: fake.launch, idleMs: 25, toolWaitMs: 25, maxSessions: 1 });
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


test('Responses SSE forwards app-server text deltas once and keeps a complete final response', async () => {
  const fake = fakeLaunch({ streamText: true }), bridge = new NasAgentBridge({ launch: fake.launch });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-live-stream-')), gateway = createGateway({ dataDir: dir, nasAgent: bridge });
  gateway.store.upsert({ ...p, name: 'Remote', models: ['model'] });
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer ' + gateway.store.gatewayKey(), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'nas/model', input: 'hello', stream: true }) });
    const events = []; for await (const event of sseEvents(response.body)) events.push(JSON.parse(event.data));
    assert.equal(events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''), 'CLIENT_RESULT_OK');
    assert.equal(events.filter(e => e.type === 'response.output_text.done').length, 1);
    assert.equal(events.filter(e => e.type === 'response.output_item.done').length, 1);
    assert.equal(events.at(-1).type, 'response.completed');
    assert.equal(events.at(-1).response.output[0].content[0].text, 'CLIENT_RESULT_OK');
  } finally { bridge.close(); gateway.server.closeAllConnections(); await new Promise(resolve => gateway.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
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


test('long history is injected natively and only the current user turn is sent to turn/start', async () => {
  const fake = fakeLaunch(), bridge = new NasAgentBridge({ launch: fake.launch });
  try {
    const longHistory = { role: 'user', content: 'H'.repeat(1100000) };
    const response = await bridge.run(p, 'model', { model: 'nas/model', input: [longHistory, { role: 'assistant', content: 'ack' }, { role: 'user', content: 'continue' }] }, 'responses');
    assert.equal(response.status, 'completed');
    const injected = fake.exchanges.filter(e => e.method === 'thread/inject_items').flatMap(e => e.params.items);
    assert.ok(injected.length, 'native history injection was called');
    assert.equal(injected.length, 2);
    const turn = fake.exchanges.find(e => e.method === 'turn/start');
    assert.deepEqual(turn.params.input, [{ type: 'text', text: 'continue' }]);
  } finally { bridge.close(); }
});

test('model discovery uses the official app-server model/list endpoint', async () => {
  const fake = fakeLaunch(), bridge = new NasAgentBridge({ launch: fake.launch });
  try {
    assert.deepEqual(await bridge.models({ ...p, type: 'nas-codex' }), ['model']);
    assert.ok(fake.exchanges.some(e => e.method === 'model/list'));
    assert.ok(!fake.exchanges.some(e => e.method === 'collect'));
  } finally { bridge.close(); }
});

test('tool specs always drop schema metadata and cap long descriptions, even under the size limit', () => {
 const specs = [{ type: 'function', name: 'probe', description: 'd'.repeat(5000), inputSchema: { type: 'object', title: 'T', examples: [1], properties: { a: { type: 'string', default: 'x', description: 'p'.repeat(5000) } } } }];
 const fitted = fitToolSpecs(specs, 900 * 1024);
 assert.equal(fitted[0].description.length, 800);
 assert.equal(fitted[0].inputSchema.title, undefined);
 assert.equal(fitted[0].inputSchema.properties.a.default, undefined);
 assert.equal(fitted[0].inputSchema.properties.a.description.length, 800);
 assert.equal(fitted[0].inputSchema.properties.a.type, 'string');
});

test('history injection drops earlier reasoning items but keeps messages', () => {
 const items = historyItems([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 's' }], encrypted_content: 'x' }, { type: 'message', role: 'user', content: 'hi' }]);
 assert.equal(items.length, 1);
 assert.equal(items[0].type, 'message');
});

test('history trimming replaces old images and clips old huge tool outputs but keeps recent turns intact', () => {
 const big = 'a'.repeat(40000), img = { type: 'input_image', image_url: 'data:image/png;base64,AAAA' };
 const input = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old' }, img] },
  { type: 'function_call', call_id: 'c1', name: 'x', arguments: '{}' },
  { type: 'function_call_output', call_id: 'c1', output: big },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'mid' }, img] },
  { type: 'function_call_output', call_id: 'c2', output: big },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new' }, img] }
 ];
 const items = historyItems(input);
 assert.equal(items[0].content[1].text, '[image omitted]');
 assert.ok(items[2].output.length < 20000 && items[2].output.includes('chars omitted'));
 assert.equal(items[3].content[1].type, 'input_image');
 assert.equal(items[4].output.length, 40000);
 assert.equal(items[5].content[1].type, 'input_image');
});

test('custom tool format hint survives description truncation', () => {
 const specs = toolSpecs([{ type: 'custom', name: 'apply_patch', description: 'D'.repeat(2000), format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' } }]).specs;
 const fitted = fitToolSpecs(specs, 900 * 1024);
 assert.ok(fitted[0].description.includes('MUST follow this format'));
 assert.ok(fitted[0].description.includes('start: begin_patch'));
 assert.equal(fitted[0].formatHint, undefined);
 assert.ok(fitted[0].description.startsWith('Client tool'));
});

test('app-server error events keep their upstream detail', async () => {
  const fake = fakeLaunch({ errorEvent: 'usage limit reached for this account' });
  const b = new NasAgentBridge({ launch: fake.launch });
  await assert.rejects(b.run(p, 'model', { model: 'm', input: [{ role: 'user', content: 'hi' }] }, 'responses'), e => e.status === 502 && /usage limit reached/.test(e.message));
  b.close();
});

test('unknown app-server tool calls report the requested name', async () => {
  const fake = fakeLaunch({ unknownTool: true });
  const b = new NasAgentBridge({ launch: fake.launch });
  await assert.rejects(b.run(p, 'model', { model: 'm', input: [{ role: 'user', content: 'hi' }] }, 'responses'), e => e.status === 502 && /unregistered tool: client_missing_0/.test(e.message));
  b.close();
});
