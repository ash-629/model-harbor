// F-06, R-04: stateless Responses -> Chat bridge (text, images, function tools).
import crypto from 'node:crypto';
import { HttpError } from './store.js';
import { chatToolPlan, restoreChatTool } from './chat-tools.js';
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
export function toChat(body, plan = chatToolPlan(body)) {
  for (const key of ['previous_response_id', 'conversation', 'background']) if (body[key]) unsupported(`Chat 上游不支持 ${key}，请发送完整历史或选择原生 Responses 上游`);
  if (body.store === true) unsupported('Chat 上游不支持 store=true；请使用无状态请求');
  if (body.truncation && body.truncation !== 'disabled') unsupported('Chat 上游不支持自动 truncation');
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  if (plan.unsupported?.length) messages.push({ role: 'system', content: 'This Chat upstream cannot execute these hosted tools: ' + plan.unsupported.join(', ') + '. Do not claim to have used them. Use available client tools if appropriate, or explain the limitation.' });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input)) throw new HttpError(400, 'Responses 请求必须提供 input');
  for (const item of input) {
    if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(item.type)) {
      const call = { id: item.call_id, type: 'function', function: { name: plan.historyName(item), arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) } };
      const last = messages.at(-1);
      if (last?.role === 'assistant' && last.tool_calls) last.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(item.type)) {
      if (item.type === 'tool_search_output') { messages.push({ role: 'tool', tool_call_id: item.call_id, content: JSON.stringify({ tools: item.tools || [] }) }); continue; }
      if (typeof item.output !== 'string' && !Array.isArray(item.output)) unsupported('工具结果必须是字符串或内容数组');
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : chatContent(item.output) });
    } else if (!item.type || item.type === 'message') {
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) unsupported('无效的消息角色');
      // OpenCode's gRPC Chat router accepts system but rejects developer.
      // Responses developer messages carry the same authority, so normalize
      // them without changing the conversation's instructions.
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: chatContent(item.content) });
    } else if (item.type !== 'reasoning') unsupported(`Chat 上游不支持输入项 ${item.type}`);
  }
  const result = { model: body.model, messages, stream: Boolean(body.stream) };
  for (const k of ['temperature', 'top_p', 'parallel_tool_calls', 'user', 'seed']) if (body[k] !== undefined) result[k] = body[k];
  if (body.max_output_tokens !== undefined) result.max_completion_tokens = body.max_output_tokens;
  if (body.reasoning?.effort) result.reasoning_effort = body.reasoning.effort;
  if (plan.definitions.length) result.tools = plan.definitions;
  if (body.tool_choice) {
    result.tool_choice = plan.choice;
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
export function fromChat(chat, model, plan) {
  const result = responseBase(model), choice = chat.choices?.[0];
  if (!choice?.message) throw new HttpError(502, '上游未返回有效的 Chat Completion');
  const msg = choice.message;
  if (msg.content || msg.refusal) result.output.push({ id: uid('msg_'), type: 'message', status: 'completed', role: 'assistant',
    content: msg.refusal ? [{ type: 'refusal', refusal: msg.refusal }] : [{ type: 'output_text', text: msg.content, annotations: [], logprobs: [] }] });
  for (const tool of msg.tool_calls || []) result.output.push(restoreChatTool({ id: uid('fc_'), type: 'function_call', status: 'completed', call_id: tool.id, name: tool.function.name, arguments: tool.function.arguments }, plan));
  result.status = choice.finish_reason === 'length' || choice.finish_reason === 'content_filter' ? 'incomplete' : 'completed';
  if (result.status === 'incomplete') result.incomplete_details = { reason: choice.finish_reason === 'length' ? 'max_output_tokens' : 'content_filter' };
  result.usage = responseUsage(chat.usage);
  return result;
}


// A single merged Go provider may receive either public endpoint. When the
// requested endpoint differs from the model's native family, translate the
// request and response in both directions so callers do not need to care.
export function contentToResponses(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) unsupported('内容必须是文本或内容数组');
  return content.map(part => {
    if (part?.type === 'text') return { type: 'input_text', text: part.text || '' };
    if (part?.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url ?? part.image_url, detail: part.image_url?.detail || 'auto' };
    unsupported(`Chat 转 Responses 暂不支持内容类型 ${part?.type}`);
  });
}
export function chatToResponses(body) {
  const input = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message?.role)) unsupported('Chat 消息角色无效');
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (message.content != null && message.content !== '') input.push({ role: 'assistant', content: contentToResponses(message.content) });
      for (const call of message.tool_calls) input.push({ type: 'function_call', call_id: call.id, name: call.function?.name, arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments || {}) });
      continue;
    }
    input.push({ role: message.role, content: contentToResponses(message.content) });
  }
  const result = { model: body.model, input, stream: Boolean(body.stream), store: false };
  for (const k of ['temperature', 'top_p', 'parallel_tool_calls', 'user', 'seed']) if (body[k] !== undefined) result[k] = body[k];
  if (body.max_completion_tokens !== undefined) result.max_output_tokens = body.max_completion_tokens;
  if (body.max_tokens !== undefined) result.max_output_tokens = body.max_tokens;
  if (body.reasoning_effort) result.reasoning = { effort: body.reasoning_effort };
  if (Array.isArray(body.tools)) result.tools = body.tools.map(tool => {
    if (tool?.type !== 'function' || !tool.function) unsupported('Chat 转 Responses 仅支持 function 工具');
    return { type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters || { type: 'object', properties: {} } };
  });
  if (body.tool_choice !== undefined) result.tool_choice = typeof body.tool_choice === 'string' ? body.tool_choice : { type: 'function', name: body.tool_choice?.function?.name };
  if (body.response_format?.type === 'json_schema') result.text = { format: { type: 'json_schema', ...body.response_format.json_schema } };
  else if (body.response_format?.type && body.response_format.type !== 'text') result.text = { format: { type: body.response_format.type } };
  return result;
}
export function responsesToChat(response, model) {
  const toolCalls = [], text = [];
  for (const item of response.output || []) {
    if (item.type === 'message') {
      for (const part of item.content || []) if (part.type === 'output_text') text.push(part.text || '');
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } });
    } else if (item.type === 'reasoning') continue;
    else unsupported(`Responses 转 Chat 暂不支持输出项 ${item.type}`);
  }
  return { id: response.id, object: 'chat.completion', created: response.created_at || Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: text.length ? text.join('') : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : response.status === 'incomplete' ? 'length' : 'stop' }],
    usage: response.usage ? { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens, total_tokens: response.usage.total_tokens } : undefined };
}
export async function responsesStreamToChat(upstream, res, model) {
  openSSE(res); const call = { id: '', name: '', arguments: '' }; let sent = false;
  const emit = data => writeSSE(res, data);
  for await (const event of sseEvents(upstream)) {
    if (event.data === '[DONE]') break;
    let data; try { data = JSON.parse(event.data); } catch { throw new HttpError(502, 'Responses 上游 SSE 包含无效 JSON'); }
    if (data.type === 'response.output_text.delta') { sent = true; await emit({ model, choices: [{ index: 0, delta: { content: data.delta } }] }); }
    else if (data.type === 'response.output_item.added' && data.item?.type === 'function_call') Object.assign(call, { id: data.item.call_id || '', name: data.item.name || '' });
    else if (data.type === 'response.function_call_arguments.delta' && call.id) { call.arguments += data.delta || ''; await emit({ model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: data.delta } }] } }] }); }
    else if (data.type === 'response.completed' || data.type === 'response.incomplete') {
      // Some Responses servers only send the final response instead of deltas.
      if (data.response && !sent) {
        const converted = responsesToChat(data.response, model);
        const choice = converted.choices[0];
        const delta = { role: 'assistant', ...(choice.message.content ? { content: choice.message.content } : {}), ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((t, i) => ({ index: i, ...t })) } : {}) };
        await emit({ model, choices: [{ index: 0, delta }] });
      }
      const finish = call.id || data.response?.output?.some(i => i.type === 'function_call') ? 'tool_calls' : data.type === 'response.incomplete' ? 'length' : 'stop';
      await emit({ model, choices: [{ index: 0, delta: {}, finish_reason: finish }] }); sent = true;
    } else if (data.type === 'response.failed') throw new HttpError(502, 'Responses 上游返回失败');
  }
  if (!sent) throw new HttpError(502, 'Responses 上游未返回可转换内容');
  await writeSSE(res, '[DONE]'); res.end();
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
export async function bridgeStream(upstream, res, model, onCompleted, plan) {
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
        const mapping = plan?.mappings.get(item.name);
        state = { item, index: response.output.length, buffered: mapping && mapping.type !== 'function' }; tools.set(call.index, state); response.output.push(item);
        if (!state.buffered) await emit('response.output_item.added', { output_index: state.index, item: { ...structuredClone(item), ...(mapping ? { name: mapping.name, ...(mapping.namespace ? { namespace: mapping.namespace } : {}) } : {}) } });
      }
      if (call.function?.arguments) {
        state.item.arguments += call.function.arguments;
        if (!state.buffered) await emit('response.function_call_arguments.delta', { item_id: state.item.id, output_index: state.index, delta: call.function.arguments });
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
  for (const { item: rawItem, index, buffered } of tools.values()) {
    const item = restoreChatTool(rawItem, plan); response.output[index] = item;
    item.status = 'completed';
    if (buffered) {
      await emit('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', ...(item.type === 'custom_tool_call' ? { input: '' } : {}) } });
      if (item.type === 'custom_tool_call') {
        await emit('response.custom_tool_call_input.delta', { item_id: item.id, output_index: index, delta: item.input });
        await emit('response.custom_tool_call_input.done', { item_id: item.id, output_index: index, input: item.input });
      }
    } else await emit('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments, name: item.name });
    await emit('response.output_item.done', { output_index: index, item });
  }
  response.status = ['length', 'content_filter'].includes(finish) ? 'incomplete' : 'completed';
  if (response.status === 'incomplete') response.incomplete_details = { reason: finish === 'length' ? 'max_output_tokens' : 'content_filter' };
  onCompleted?.(response, upstreamUsage);
  await emit(response.status === 'completed' ? 'response.completed' : 'response.incomplete', { response });
  res.end();
}
