import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toChat, normalizeChatToolMessages } from '../src/protocol.js';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('Responses tool text arrays become a string Chat tool message', () => {
  const request = toChat({ model: 'm', input: [
    { type: 'function_call', call_id: 'call_text', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_text', output: [
      { type: 'input_text', text: 'first line' },
      { type: 'output_text', text: 'second line' }
    ] }
  ] });
  const tool = request.messages.find(message => message.role === 'tool');
  assert.deepEqual(tool, { role: 'tool', tool_call_id: 'call_text', content: 'first line\nsecond line' });
});

test('multimodal tool output uses string tool content and a follow-up user image message', () => {
  const request = toChat({ model: 'm', input: [
    { type: 'function_call', call_id: 'call_image', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_image', output: [
      { type: 'input_text', text: 'captured screen' },
      { type: 'input_image', image_url: image, detail: 'high' }
    ] }
  ] });
  const tool = request.messages.find(message => message.role === 'tool');
  assert.equal(typeof tool.content, 'string');
  assert.match(tool.content, /captured screen/);
  assert.match(tool.content, /1 image/);
  const followUp = request.messages.at(-1);
  assert.equal(followUp.role, 'user');
  assert.equal(followUp.content[1].type, 'image_url');
  assert.equal(followUp.content[1].image_url.url, image);
  assert.equal(followUp.content[1].image_url.detail, 'high');
});

test('native Chat history normalizes every tool message content to a string', () => {
  const original = { model: 'm', messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'plain result' }] },
    { role: 'tool', tool_call_id: 'c2', content: [{ type: 'image_url', image_url: { url: image } }] }
  ] };
  const normalized = normalizeChatToolMessages(original);
  assert.equal(original.messages[1].content[0].text, 'plain result');
  assert.equal(normalized.messages[1].content, 'plain result');
  assert.equal(typeof normalized.messages[2].content, 'string');
  assert.match(normalized.messages[2].content, /1 image/);
  assert.equal(normalized.messages[3].role, 'user');
  assert.equal(normalized.messages[3].content[1].type, 'image_url');
});

test('parallel image tool outputs keep tool messages contiguous before the bridged user image', () => {
  const request = toChat({ model: 'm', input: [
    { type: 'function_call', call_id: 'call_a', name: 'view_a', arguments: '{}' },
    { type: 'function_call', call_id: 'call_b', name: 'view_b', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_a', output: [{ type: 'input_image', image_url: image }] },
    { type: 'function_call_output', call_id: 'call_b', output: [{ type: 'input_image', image_url: image }] }
  ] });
  assert.deepEqual(request.messages.map(message => message.role), ['assistant', 'tool', 'tool', 'user']);
  assert.equal(request.messages[1].tool_call_id, 'call_a');
  assert.equal(request.messages[2].tool_call_id, 'call_b');
  assert.match(request.messages[3].content[0].text, /call_a, call_b/);
  assert.equal(request.messages[3].content.length, 3);
});
