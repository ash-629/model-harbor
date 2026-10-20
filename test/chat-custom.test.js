import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toChat, fromChat, bridgeStream, sseEvents, chatToResponses, responsesToChat, responsesStreamToChat } from '../src/protocol.js';
import { chatToolPlan } from '../src/chat-tools.js';
import { Writable } from 'node:stream';

const raw = '*** Begin Patch\n*** Add File: a.txt\n+literal `value` $HOME 中文\n*** End Patch';
test('GUI hosted declarations are disclosed, forced hosted calls fail, dotted client names restore', () => {
  const request = { input: 'hi', tools: [{ type: 'web_search', search_content_types: ['text', 'image'] }, { type: 'tool_search' }, { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'mcp.server.read', parameters: { type: 'object' } }] }] };
  const plan = chatToolPlan(request), chat = toChat(request, plan);
  assert.equal(chat.tools.length, 1);
  assert.match(chat.messages[0].content, /cannot execute.*web_search/);
  assert.match(chat.tools[0].function.name, /^[A-Za-z0-9_-]{1,64}$/);
  const item = fromChat({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: chat.tools[0].function.name, arguments: '{}' } }] } }] }, 'm', plan).output[0];
  assert.equal(item.name, 'mcp.server.read'); assert.equal(item.namespace, 'functions');
  assert.throws(() => chatToolPlan({ ...request, tool_choice: { type: 'web_search' } }), { status: 400 });
  assert.throws(() => chatToolPlan({ input: 'x', tools: [{ type: 'web_search' }], tool_choice: 'required' }), { status: 400 });
  assert.throws(() => chatToolPlan({ tools: [{ type: 'function', name: 'bad name' }] }), { status: 400 });
  const history = toChat({ input: [{ type: 'tool_search_call', call_id: 'search', arguments: { query: 'read' } }, { type: 'tool_search_output', call_id: 'search', tools: [] }, { role: 'user', content: 'continue' }] });
  assert.equal(history.messages[0].tool_calls[0].function.name, 'tool_search');
});
const body = { model: 'ocgo/deepseek-v4.1-flash', tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/' } }], input: [
  { type: 'custom_tool_call', call_id: 'call_old', name: 'apply_patch', input: raw },
  { type: 'custom_tool_call_output', call_id: 'call_old', output: 'Success' },
  { role: 'user', content: 'Continue' }
] };
test('switching to Chat preserves raw custom history and exposes a string wrapper', () => {
  const result = toChat(body);
  assert.equal(JSON.parse(result.messages[0].tool_calls[0].function.arguments).input, raw);
  assert.equal(result.messages[1].tool_call_id, 'call_old');
  assert.equal(result.messages[1].content, 'Success');
  assert.deepEqual(result.tools[0].function.parameters.required, ['input']);
  assert.match(result.tools[0].function.description, /grammar/);
});
test('custom calls are restored with exact input and malformed arguments cannot execute', () => {
  const plan = chatToolPlan(body), alias = plan.definitions[0].function.name;
  const completion = args => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_new', function: { name: alias, arguments: args } }] } }] });
  const item = fromChat(completion(JSON.stringify({ input: raw })), body.model, plan).output[0];
  assert.equal(item.type, 'custom_tool_call'); assert.equal(item.call_id, 'call_new'); assert.equal(item.input, raw);
  assert.equal(item.arguments, undefined);
  for (const invalid of ['invalid', '{}', '{"input":5}', '{"input":"x","extra":1}']) assert.throws(() => fromChat(completion(invalid), body.model, plan), { status: 502 });
});
test('namespace and long names round trip without collisions and forced custom choice resolves', () => {
  const request = { input: [], tools: ['one', 'two'].map(name => ({ type: 'namespace', name, tools: [{ type: 'custom', name: 'x'.repeat(100) }] })), tool_choice: { type: 'custom', namespace: 'two', name: 'x'.repeat(100) } };
  const plan = chatToolPlan(request), payload = toChat(request, plan);
  assert.notEqual(payload.tools[0].function.name, payload.tools[1].function.name);
  assert.ok(payload.tools.every(t => t.function.name.length <= 64));
  assert.equal(payload.tool_choice.function.name, payload.tools[1].function.name);
  const response = fromChat({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: payload.tools[1].function.name, arguments: '{"input":"ok"}' } }] } }] }, 'model', plan);
  assert.equal(response.output[0].namespace, 'two'); assert.equal(response.output[0].name.length, 100);
});
test('custom SSE emits raw input events and completed original call, never JSON wrapper deltas', async () => {
  const plan = chatToolPlan(body), alias = plan.definitions[0].function.name;
  const args = JSON.stringify({ input: raw });
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: alias, arguments: args.slice(0, 25) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(25) } }] }, finish_reason: 'tool_calls' }] }
  ];
  const upstream = new Response(chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n');
  let text = '';
  const res = new Writable({ write(chunk, encoding, cb) { text += chunk; cb(); } });
  res.writeHead = () => {}; res.flushHeaders = () => {};
  await bridgeStream(upstream.body, res, body.model, undefined, plan);
  const events = [];
  for await (const e of sseEvents(new Response(text).body)) events.push(JSON.parse(e.data));
  assert.equal(events.some(e => e.type === 'response.function_call_arguments.delta'), false);
  assert.equal(events.find(e => e.type === 'response.custom_tool_call_input.delta').delta, raw);
  const final = events.find(e => e.type === 'response.completed').response.output[0];
  assert.equal(final.type, 'custom_tool_call'); assert.equal(final.input, raw);
});


test('Chat content history maps to Responses and completed Responses output maps back', () => {
  const request = chatToResponses({ model: 'm', messages: [
    { role: 'system', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
    { role: 'assistant', content: 'calling', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"a":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' }
  ], max_tokens: 64, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], tool_choice: { type: 'function', function: { name: 'read' } } });
  assert.equal(request.store, false); assert.equal(request.max_output_tokens, 64);
  assert.deepEqual(request.input[1].content[1], { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'auto' });
  assert.deepEqual(request.input.filter(i => i.type === 'function_call').map(i => i.call_id), ['c1']);
  assert.deepEqual(request.input.at(-1), { type: 'function_call_output', call_id: 'c1', output: 'ok' });
  assert.deepEqual(request.tool_choice, { type: 'function', name: 'read' });
  const response = responsesToChat({ id: 'r', created_at: 1, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }, { type: 'function_call', call_id: 'c2', name: 'read', arguments: '{}' }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }, 'm');
  assert.equal(response.choices[0].message.content, 'answer'); assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.equal(response.choices[0].message.tool_calls[0].id, 'c2'); assert.equal(response.usage.total_tokens, 5);
});


test('Responses developer history is normalized to Chat system', () => {
  const request = toChat({
    model: 'm',
    input: [
      { role: 'developer', content: 'first rule' },
      { role: 'developer', content: [{ type: 'input_text', text: 'second rule' }] },
      { role: 'user', content: 'hello' }
    ]
  });
  assert.deepEqual(request.messages.map(m => m.role), ['system', 'system', 'user']);
  assert.deepEqual(request.messages.slice(0, 2).map(m => m.content), ['first rule', [{ type: 'text', text: 'second rule' }]]);
  assert.equal(JSON.stringify(request).includes('developer'), false);
});
