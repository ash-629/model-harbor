import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { toChat, fromChat, bridgeStream, sseEvents } from '../src/protocol.js';
import {
  cachedReasoning,
  clearReasoningCacheForTests,
  createChatReasoningTracker,
  reasoningTextFromItem,
  rememberChatReasoning,
  rememberReasoning,
  restoreCachedReasoning
} from '../src/reasoning.js';

beforeEach(() => clearReasoningCacheForTests());

test('reasoning text is extracted from portable Responses parts', () => {
  assert.equal(reasoningTextFromItem({
    type: 'reasoning',
    reasoning_content: 'direct',
    summary: [{ type: 'summary_text', text: 'summary' }],
    content: [{ type: 'reasoning_text', text: 'content' }]
  }), 'direct\nsummary\ncontent');
  assert.equal(reasoningTextFromItem({ type: 'message', reasoning_content: 'ignored' }), '');
});

test('Responses reasoning history becomes Chat reasoning_content for the adjacent tool call', () => {
  const request = toChat({ model: 'm', input: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'need a tool' }] },
    { type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
  ] });
  assert.equal(request.messages[0].role, 'assistant');
  assert.equal(request.messages[0].reasoning_content, 'need a tool');
  assert.equal(request.messages[0].tool_calls[0].id, 'call_1');
  assert.equal(request.messages[1].role, 'tool');
});

test('non-stream Chat reasoning is exposed and cached for a follow-up without the reasoning item', () => {
  const response = fromChat({ choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null, reasoning_content: 'private chain', tool_calls: [
      { id: 'call_2', type: 'function', function: { name: 'echo', arguments: '{}' } }
    ]
  } }] }, 'm', undefined, 'ocgo');
  assert.equal(response.output[0].type, 'reasoning');
  assert.equal(response.output[0].summary[0].text, 'private chain');
  assert.equal(response.output[1].type, 'function_call');
  assert.equal(cachedReasoning('ocgo', 'call_2'), 'private chain');

  const request = toChat({ model: 'm', input: [
    { type: 'function_call', call_id: 'call_2', name: 'echo', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_2', output: 'ok' }
  ] }, undefined, 'ocgo');
  assert.equal(request.messages[0].reasoning_content, 'private chain');
  assert.equal(cachedReasoning('other', 'call_2'), '');
});

test('native Chat histories receive cached reasoning without overwriting client values', () => {
  rememberReasoning('ocgo', 'call_3', 'cached chain');
  const restored = restoreCachedReasoning({ messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_3' }] },
    { role: 'assistant', content: null, reasoning_content: 'client chain', tool_calls: [{ id: 'call_3' }] }
  ] }, 'ocgo');
  assert.equal(restored.messages[0].reasoning_content, 'cached chain');
  assert.equal(restored.messages[1].reasoning_content, 'client chain');
});

test('streamed Chat reasoning emits Responses events and remains available by call ID', async () => {
  const chunks = [
    { choices: [{ delta: { reasoning_content: 'think ' } }] },
    { choices: [{ delta: { reasoning_content: 'first', tool_calls: [{ index: 0, id: 'call_4', function: { name: 'echo', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ];
  const upstream = new Response(chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n');
  let output = '';
  const res = new Writable({ write(chunk, encoding, callback) { output += chunk; callback(); } });
  res.writeHead = () => {};
  res.flushHeaders = () => {};
  await bridgeStream(upstream.body, res, 'm', undefined, undefined, 'ocgo');

  const events = [];
  for await (const event of sseEvents(new Response(output).body)) events.push(JSON.parse(event.data));
  assert.equal(events.filter(event => event.type === 'response.reasoning_summary_text.delta').map(event => event.delta).join(''), 'think first');
  assert.equal(events.some(event => event.type === 'response.reasoning_summary_text.done'), true);
  assert.equal(cachedReasoning('ocgo', 'call_4'), 'think first');

  const request = toChat({ model: 'm', input: [
    { type: 'function_call', call_id: 'call_4', name: 'echo', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_4', output: 'ok' }
  ] }, undefined, 'ocgo');
  assert.equal(request.messages[0].reasoning_content, 'think first');
});

test('native non-stream Chat completions cache reasoning by every tool call ID', () => {
  const remembered = rememberChatReasoning({ choices: [{ message: {
    reasoning_content: 'native stream chain',
    tool_calls: [{ id: 'call_5' }, { id: 'call_6' }]
  } }] }, 'ocgo');
  assert.equal(remembered, true);
  assert.equal(cachedReasoning('ocgo', 'call_5'), 'native stream chain');
  assert.equal(cachedReasoning('ocgo', 'call_6'), 'native stream chain');
});

test('native stream Chat chunks cache reasoning after fragmented tool call IDs arrive', () => {
  const tracker = createChatReasoningTracker('ocgo');
  tracker.push({ choices: [{ delta: { reasoning_content: 'stream ' } }] });
  tracker.push({ choices: [{ delta: { reasoning_content: 'chain', tool_calls: [{ index: 0, id: 'call_7', function: { name: 'echo' } }] } }] });
  tracker.push({ choices: [{ delta: { function: { arguments: '{}' } }, finish_reason: 'tool_calls' }] });
  tracker.flush();
  assert.equal(cachedReasoning('ocgo', 'call_7'), 'stream chain');
});

test('missing cached reasoning can be filled with an explicit empty value for thinking-mode tool turns', () => {
  const request = { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_empty' }] }] };
  const filled = restoreCachedReasoning(request, 'ocgo', { fillEmpty: true });
  assert.equal(filled.messages[0].reasoning_content, '');
  const untouched = restoreCachedReasoning(request, 'ocgo');
  assert.equal('reasoning_content' in untouched.messages[0], false);
  rememberReasoning('ocgo', 'call_empty', 'cached chain');
  const cached = restoreCachedReasoning(request, 'ocgo', { fillEmpty: true });
  assert.equal(cached.messages[0].reasoning_content, 'cached chain');
});

test('client reasoning fields are copied and empty fill reaches Responses tool history', () => {
  const restored = restoreCachedReasoning({ messages: [
    { role: 'assistant', content: null, reasoning: 'client chain', tool_calls: [{ id: 'call_reasoning' }] }
  ] }, 'ocgo', { fillEmpty: true });
  assert.equal(restored.messages[0].reasoning_content, 'client chain');

  const request = toChat({ model: 'm', input: [
    { type: 'function_call', call_id: 'call_fill', name: 'echo', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_fill', output: 'ok' }
  ] }, undefined, 'ocgo', { fillReasoning: true });
  assert.equal(request.messages[0].reasoning_content, '');
});
