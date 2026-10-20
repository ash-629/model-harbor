import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responsesToolPlan, restoreResponsesResponse, responsesEventRewriter } from '../src/responses-tools.js';

const raw = '*** Begin Patch\n*** Add File: a.txt\n+literal `value` $HOME\n*** End Patch';
const body = {
  model: 'grok-4.7', input: [
    { type: 'custom_tool_call', call_id: 'old', name: 'apply_patch', input: raw },
    { type: 'custom_tool_call_output', call_id: 'old', output: 'Success' },
    { role: 'user', content: 'Continue' }
  ],
  tools: [{ type: 'custom', name: 'apply_patch', description: 'Edit files', format: { type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/' } }],
  tool_choice: { type: 'custom', name: 'apply_patch' }
};

test('Grok Responses custom tools become string functions and history round trips', () => {
  const plan = responsesToolPlan(body), payload = plan.request;
  assert.equal(plan.transformed, true);
  assert.equal(payload.tools[0].type, 'function');
  assert.deepEqual(payload.tools[0].parameters.required, ['input']);
  assert.match(payload.tools[0].description, /grammar/);
  assert.equal(JSON.parse(payload.input[0].arguments).input, raw);
  assert.equal(payload.input[0].type, 'function_call');
  assert.equal(payload.input[1].type, 'function_call_output');
  assert.deepEqual(payload.tool_choice, { type: 'function', name: 'apply_patch' });
  const response = restoreResponsesResponse({ output: [{ id: 'c', type: 'function_call', status: 'completed', call_id: 'new', name: 'apply_patch', arguments: JSON.stringify({ input: raw }) }] }, plan);
  assert.equal(response.output[0].type, 'custom_tool_call'); assert.equal(response.output[0].input, raw);
  assert.equal(response.output[0].arguments, undefined);
});

test('Grok native namespace and long names get stable aliases without collisions', () => {
  const plan = responsesToolPlan({ input: [], tools: [
    { type: 'namespace', name: 'a', tools: [{ type: 'custom', name: 'x'.repeat(100) }] },
    { type: 'namespace', name: 'b', tools: [{ type: 'custom', name: 'x'.repeat(100) }] }
  ] });
  assert.notEqual(plan.request.tools[0].name, plan.request.tools[1].name);
  assert.ok(plan.request.tools.every(t => t.name.length <= 64));
  const item = restoreResponsesResponse({ output: [{ type: 'function_call', name: plan.request.tools[1].name, call_id: 'c', arguments: '{"input":"ok"}' }] }, plan).output[0];
  assert.equal(item.namespace, 'b'); assert.equal(item.input, 'ok');
});

test('Grok SSE rewrites custom argument wrapper into raw input events', () => {
  const plan = responsesToolPlan(body), rewrite = responsesEventRewriter(plan);
  const args = JSON.stringify({ input: raw });
  const added = rewrite({ type: 'response.output_item.added', item: { id: 'fc1', type: 'function_call', name: 'apply_patch', arguments: '' } });
  assert.equal(added[0].item.type, 'custom_tool_call');
  assert.deepEqual(rewrite({ type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: args }), []);
  const done = rewrite({ type: 'response.function_call_arguments.done', item_id: 'fc1', arguments: args, item: { id: 'fc1', type: 'function_call', name: 'apply_patch' } });
  assert.equal(done.find(e => e.type === 'response.custom_tool_call_input.done').input, raw);
  assert.equal(done.find(e => e.type === 'response.output_item.done').item.input, raw);
  assert.throws(() => rewrite({ type: 'response.function_call_arguments.done', item_id: 'fc1', arguments: '{"wrong":1}' }), { status: 502 });
});

test('hosted tools and ordinary functions stay untouched by default', () => {
  const request = { input: 'hi', tools: [{ type: 'web_search' }, { type: 'function', name: 'read', parameters: { type: 'object' } }] };
  const plan = responsesToolPlan(request);
  assert.equal(plan.transformed, false);
  assert.equal(plan.request, request);
});

test('Grok drops unsupported hosted declarations, keeps web_search and explains the limitation', () => {
  const request = { input: 'hi', instructions: 'base', tools: [
    { type: 'web_search_preview' }, { type: 'web_search' }, { type: 'file_search', vector_store_ids: ['x'] },
    { type: 'tool_search' }, { type: 'function', name: 'read', parameters: { type: 'object' } }
  ] };
  const plan = responsesToolPlan(request, { dropHosted: true });
  assert.deepEqual(plan.request.tools.map(t => t.type), ['web_search', 'file_search', 'function']);
  assert.deepEqual(plan.droppedHosted.sort(), ['tool_search', 'web_search_preview']);
  assert.match(plan.request.instructions, /web_search_preview/);
  assert.match(plan.request.instructions, /Do not claim/);
  assert.equal(request.tools.length, 5);
  assert.throws(() => responsesToolPlan({ input: 'x', tools: [{ type: 'web_search_preview' }], tool_choice: { type: 'web_search_preview' } }, { dropHosted: true }), { status: 400 });
});

test('Grok client tool_search becomes a normal discoverable function', () => {
  const plan = responsesToolPlan({ input: [], tools: [{ type: 'tool_search', execution: 'client', description: 'Find tools' }] }, { dropHosted: true });
  assert.equal(plan.request.tools[0].type, 'function');
  assert.equal(plan.request.tools[0].name, 'tool_search');
  assert.equal(plan.transformed, true);
});


test('Grok rebuilds requests that contain namespaces or programmatic control flags', () => {
  const fn = { type: 'function', name: 'read', parameters: { type: 'object' } };
  const ns = { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'write', parameters: { type: 'object' } }] };
  for (const extra of [{ type: 'programmatic_tool_calling', enabled: false }, { type: 'programmatic_tool_calling', enabled: true }, ns]) {
    const plan = responsesToolPlan({ input: 'hi', tools: [fn, extra] }, { dropHosted: true });
    assert.equal(plan.transformed, true);
    assert.equal(plan.request.tools.some(t => ['namespace', 'programmatic_tool_calling'].includes(t.type)), false);
  }
});


test('Grok strips unsupported web_search options and keeps supported ones', () => {
  const request = { input: 'search', tools: [{
    type: 'web_search', external_web_access: false, search_context_size: 'low',
    filters: { allowed_domains: ['example.com'] },
    user_location: { type: 'approximate', country: 'US' },
    search_content_types: ['text']
  }] };
  const plan = responsesToolPlan(request, { dropHosted: true });
  assert.equal(plan.transformed, true);
  assert.deepEqual(plan.droppedArguments.sort(), ['external_web_access', 'search_context_size']);
  assert.equal(plan.request.tools[0].type, 'web_search');
  assert.equal('external_web_access' in plan.request.tools[0], false);
  assert.equal('search_context_size' in plan.request.tools[0], false);
  assert.deepEqual(plan.request.tools[0].filters.allowed_domains, ['example.com']);
  assert.equal(plan.request.tools[0].user_location.country, 'US');
  assert.deepEqual(plan.request.tools[0].search_content_types, ['text']);
  assert.equal(request.tools[0].external_web_access, false);
});

test('supported web_search without unsupported options keeps the original request', () => {
  const request = { input: 'search', tools: [{ type: 'web_search', filters: { allowed_domains: ['example.com'] } }] };
  const plan = responsesToolPlan(request, { dropHosted: true });
  assert.equal(plan.transformed, false);
  assert.equal(plan.request, request);
});


test('Grok tool roots always become object schemas while preserving object branches', () => {
  const union = { type: 'function', name: 'mixed', parameters: { anyOf: [
    { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    { type: 'string' }
  ] } };
  const onlyObjects = { type: 'function', name: 'objects', parameters: { oneOf: [
    { type: 'object', properties: { a: { type: 'string' } } },
    { type: 'object', properties: { b: { type: 'number' } } }
  ] } };
  const nullable = { type: 'function', name: 'nullable', parameters: { type: ['object', 'null'], properties: { a: { type: 'string' } } } };
  const invalid = { type: 'function', name: 'invalid', parameters: { type: 'string' } };
  const plan = responsesToolPlan({ input: 'hi', tools: [union, onlyObjects, nullable, invalid] }, { dropHosted: true });
  assert.equal(plan.transformed, true);
  const [a, b, c, d] = plan.request.tools;
  assert.equal(a.parameters.type, 'object'); assert.equal(a.parameters.anyOf, undefined); assert.deepEqual(a.parameters.required, ['a']);
  assert.equal(b.parameters.type, 'object'); assert.equal(b.parameters.anyOf.length, 2); assert.ok(b.parameters.anyOf.every(x => x.type === 'object'));
  assert.equal(c.parameters.type, 'object');
  assert.equal(d.parameters.type, 'object'); assert.equal(d.parameters.additionalProperties, true);
  for (const tool of plan.request.tools) assert.equal(typeof tool.parameters === 'object' && tool.parameters.type, 'object');
});

test('already object-rooted Grok tools keep the same schema instance', () => {
  const parameters = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const plan = responsesToolPlan({ input: 'hi', tools: [{ type: 'function', name: 'ok', parameters }] }, { dropHosted: true });
  assert.equal(plan.transformed, false);
  assert.equal(plan.request.tools[0].parameters, parameters);
});
