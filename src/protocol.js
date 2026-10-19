// F-06, R-04: stateless Responses -> Chat bridge (text, images, function tools).
import crypto from 'node:crypto';
import { HttpError } from './store.js';
export const uid = prefix => prefix + crypto.randomBytes(12).toString('hex');
const unsupported = message => { throw new HttpError(400, message, 'unsupported_parameter'); };

function chatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) unsupported('content 必须是文本或内容数组');
  return content.map(p => {
    if (['input_text', 'output_text', 'text'].includes(p.type)) return { type: 'text', text: p.text };
    if (p.type === 'input_image') return { type: 'image_url', image_url: { url: p.image_url, detail: p.detail || 'auto' } };
    unsupported(`Responses 转换暂不支持内容类型 ${p.type}`);
  });
}
export function toChat(body) {
  for (const key of ['previous_response_id', 'conversation', 'background']) if (body[key]) unsupported(`Chat 上游不支持 ${key}，请发送完整历史或选择原生 Responses 上游`);
  if (body.store === true) unsupported('Chat 上游不支持 store=true；请使用无状态请求');
  if (body.truncation && body.truncation !== 'disabled') unsupported('Chat 上游不支持自动 truncation');
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input)) throw new HttpError(400, 'Responses 请求必须提供 input');
  for (const item of input) {
    if (item.type === 'function_call') {
      const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
      const last = messages.at(-1);
      if (last?.role === 'assistant' && last.tool_calls) last.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output') {
      if (typeof item.output !== 'string') unsupported('函数结果目前仅支持字符串 output');
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
    } else if (!item.type || item.type === 'message') {
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) unsupported('无效的消息角色');
      messages.push({ role: item.role, content: chatContent(item.content) });
    } else if (item.type !== 'reasoning') unsupported(`Chat 上游不支持输入项 ${item.type}`);
  }
  const result = { model: body.model, messages, stream: Boolean(body.stream) };
  for (const k of ['temperature', 'top_p', 'parallel_tool_calls', 'user', 'seed']) if (body[k] !== undefined) result[k] = body[k];
  if (body.max_output_tokens !== undefined) result.max_completion_tokens = body.max_output_tokens;
  if (body.reasoning?.effort) result.reasoning_effort = body.reasoning.effort;
  if (body.tools?.length) result.tools = body.tools.map(t => {
    if (t.type !== 'function') unsupported(`Chat 上游不支持 ${t.type} 工具；请选择原生 Responses 上游`);
    const { type, ...fn } = t; return { type, function: fn };
  });
  if (body.tool_choice) {
    if (typeof body.tool_choice !== 'string' && (body.tool_choice.type !== 'function' || typeof body.tool_choice.name !== 'string')) unsupported('Chat 上游仅支持 auto/none/required 或指定 function 的 tool_choice');
    result.tool_choice = typeof body.tool_choice === 'string' ? body.tool_choice : { type: 'function', function: { name: body.tool_choice.name } };
  }
  if (body.text?.format) {
    const { type, ...format } = body.text.format;
    result.response_format = type === 'json_schema' ? { type, json_schema: format } : { type };
  }
  if (body.stream) result.stream_options = { include_usage: true };
  return result;
}

export function responseUsage(usage) {
  if (!usage) return null;
  return { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 } };
}
export function responseBase(model, id = uid('resp_')) {
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress',
    model, output: [], error: null, incomplete_details: null, parallel_tool_calls: true,
    tool_choice: 'auto', tools: [], store: false, usage: null };
}
export function fromChat(chat, model) {
  const result = responseBase(model), choice = chat.choices?.[0];
  if (!choice?.message) throw new HttpError(502, '上游未返回有效的 Chat Completion');
  const msg = choice.message;
  if (msg.content || msg.refusal) result.output.push({ id: uid('msg_'), type: 'message', status: 'completed', role: 'assistant',
    content: msg.refusal ? [{ type: 'refusal', refusal: msg.refusal }] : [{ type: 'output_text', text: msg.content, annotations: [], logprobs: [] }] });
  for (const tool of msg.tool_calls || []) result.output.push({ id: uid('fc_'), type: 'function_call', status: 'completed', call_id: tool.id, name: tool.function.name, arguments: tool.function.arguments });
  result.status = choice.finish_reason === 'length' || choice.finish_reason === 'content_filter' ? 'incomplete' : 'completed';
  if (result.status === 'incomplete') result.incomplete_details = { reason: choice.finish_reason === 'length' ? 'max_output_tokens' : 'content_filter' };
  result.usage = responseUsage(chat.usage);
  return result;
}

export async function* sseEvents(body) {
  const decoder = new TextDecoder(); let buffer = '';
  function parse(block) {
    const lines = block.split('\n');
    return { event: lines.find(l => l.startsWith('event:'))?.slice(6).trim(),
      data: lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n') };
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
    if (buffer.length > 4 * 1024 * 1024) throw new HttpError(502, '上游 SSE 单条事件过大');
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) { const event = parse(buffer.slice(0, index)); buffer = buffer.slice(index + 2); if (event.data) yield event; }
  }
  buffer += decoder.decode(); if (buffer.trim()) { const event = parse(buffer); if (event.data) yield event; }
}
export function openSSE(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders();
}
export async function writeSSE(res, data, event) {
  if (res.destroyed) throw new Error('Client disconnected');
  const frame = (event ? `event: ${event}\n` : '') + `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  if (!res.write(frame)) await new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); }, close = () => { cleanup(); reject(new Error('Client disconnected')); };
    const cleanup = () => { res.off('drain', done); res.off('close', close); };
    res.once('drain', done); res.once('close', close);
  });
}
export async function bridgeStream(upstream, res, model, onCompleted) {
  const response = responseBase(model); let sequence = 0, message, messageIndex, refusal = false, finish, upstreamUsage;
  const tools = new Map();
  const emit = (type, fields = {}) => writeSSE(res, { type, sequence_number: sequence++, ...fields }, type);
  openSSE(res);
  await emit('response.created', { response: structuredClone(response) });
  await emit('response.in_progress', { response: structuredClone(response) });
  let terminal = false;
  for await (const event of sseEvents(upstream)) {
    if (event.data === '[DONE]') { terminal = true; break; }
    const part = JSON.parse(event.data);
    if (part.error) throw new HttpError(502, '上游流返回错误', 'upstream_error');
    if (part.usage) { upstreamUsage = part.usage; response.usage = responseUsage(part.usage); }
    const choice = part.choices?.[0]; if (!choice) continue;
    if (choice.finish_reason) { finish = choice.finish_reason; terminal = true; }
    const delta = choice.delta || {};
    const text = delta.content || delta.refusal;
    if (text) {
      if (!message) {
        refusal = Boolean(delta.refusal); messageIndex = response.output.length;
        message = { id: uid('msg_'), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
        response.output.push(message);
        await emit('response.output_item.added', { output_index: messageIndex, item: structuredClone(message) });
        message.content.push(refusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [], logprobs: [] });
        await emit('response.content_part.added', { item_id: message.id, output_index: messageIndex, content_index: 0, part: structuredClone(message.content[0]) });
      }
      message.content[0][refusal ? 'refusal' : 'text'] += text;
      await emit(refusal ? 'response.refusal.delta' : 'response.output_text.delta', { item_id: message.id, output_index: messageIndex, content_index: 0, delta: text, logprobs: [] });
    }
    for (const call of delta.tool_calls || []) {
      let state = tools.get(call.index);
      if (!state) {
        if (!call.id || !call.function?.name) throw new HttpError(502, '上游工具流缺少 id 或 name');
        const item = { id: uid('fc_'), type: 'function_call', status: 'in_progress', call_id: call.id, name: call.function.name, arguments: '' };
        state = { item, index: response.output.length }; tools.set(call.index, state); response.output.push(item);
        await emit('response.output_item.added', { output_index: state.index, item: structuredClone(item) });
      }
      if (call.function?.arguments) {
        state.item.arguments += call.function.arguments;
        await emit('response.function_call_arguments.delta', { item_id: state.item.id, output_index: state.index, delta: call.function.arguments });
      }
    }
  }
  if (!terminal) throw new HttpError(502, '上游流意外结束，未收到完成标记');
  if (message) {
    message.status = 'completed';
    await emit(refusal ? 'response.refusal.done' : 'response.output_text.done', { item_id: message.id, output_index: messageIndex, content_index: 0, [refusal ? 'refusal' : 'text']: message.content[0][refusal ? 'refusal' : 'text'], logprobs: [] });
    await emit('response.content_part.done', { item_id: message.id, output_index: messageIndex, content_index: 0, part: message.content[0] });
    await emit('response.output_item.done', { output_index: messageIndex, item: message });
  }
  for (const { item, index } of tools.values()) {
    item.status = 'completed';
    await emit('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments, name: item.name });
    await emit('response.output_item.done', { output_index: index, item });
  }
  response.status = ['length', 'content_filter'].includes(finish) ? 'incomplete' : 'completed';
  if (response.status === 'incomplete') response.incomplete_details = { reason: finish === 'length' ? 'max_output_tokens' : 'content_filter' };
  onCompleted?.(response, upstreamUsage);
  await emit(response.status === 'completed' ? 'response.completed' : 'response.incomplete', { response });
  res.end();
}
