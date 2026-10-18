// AG-01..AG-05: native Codex app-server dynamic tools, executed by the API client.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { HttpError } from './store.js';
import { responseBase, openSSE, writeSSE, uid } from './protocol.js';
import { runtimePrefix, codexExecutable, sshCommand } from './remote-codex.js';
import { normalizeUsage } from './codex-usage.js';
import { isWebSearch, nativeSearch, searchItem } from './native-search.js';

const bad = message => { throw new HttpError(400, message, 'unsupported_parameter'); };
// Native userMessage events echo serialized history; allow JSON escaping
// overhead above the default 64 MiB HTTP request limit.
const RPC_MESSAGE_LIMIT = 128 * 1024 * 1024;
const rpcTooLarge = () => new HttpError(502, 'Remote Codex RPC message exceeds 128 MiB; compact history or reduce attachments', 'remote_message_too_large');
const failed = () => new HttpError(502, '远程 Codex 工具桥接失败，请检查登录、模型权限和 app-server 版本');
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
export const agentTail = ['timeout', '--signal=TERM', '--kill-after=5s', '1200s', 'codex', 'app-server', '--listen', 'stdio://',
  '-c', 'features.shell_tool=false', '-c', 'features.apply_patch_freeform=false', '-c', 'features.multi_agent=false',
  '-c', 'features.image_generation=false', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'web_search="disabled"'];
export function agentCommand(p) {
  const tail = [...agentTail]; tail[4] = codexExecutable(p);
  const command = [...runtimePrefix(p), ...tail];
  return sshCommand(p, command);
}

export function toolSpecs(tools = [], choice = 'auto') {
  if (!Array.isArray(tools) || tools.length > 256) bad('远程工具列表无效（最多 256 项）');
  const webSearch = nativeSearch(tools, choice);
  const specs = [], mappings = new Map(), names = new Set();
  const add = (tool, namespace) => {
    if (tool?.type === 'function' && tool.function) tool = { ...tool.function, type: 'function' };
    if (!tool || !['function', 'custom'].includes(tool.type) || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name || '')) bad('远程工具定义不兼容: type=' + String(tool?.type).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) + ', name=' + String(tool?.name || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 128));
    const key = (namespace ? namespace + '.' : '') + tool.name;
    if (names.has(key)) bad('远程工具名称重复'); names.add(key);
    const name = 'client_' + tool.name.slice(0, 45) + '_' + specs.length;
    const custom = tool.type === 'custom';
    const inputSchema = custom ? { type: 'object', properties: { input: { type: 'string', description: 'Exact raw tool input, without JSON wrapping or markdown fences.' } }, required: ['input'], additionalProperties: false } : tool.parameters || { type: 'object', properties: {} };
    let description = `Client tool ${key}. ${tool.description || ''}`;
    if (custom && tool.format) description += '\nThe input string MUST follow this format: ' + JSON.stringify(tool.format);
    specs.push({ type: 'function', name, description, inputSchema });
    mappings.set(name, { ...tool, namespace });
  };
  for (const tool of tools) {
    if (isWebSearch(tool)) continue;
    // Discovery/control declarations are not callable function tools. All supplied
    // schemas are eagerly registered, so hosted discovery needs no separate call.
    if (tool?.type === 'tool_search') {
      if (!tool.execution || tool.execution === 'server') continue;
      if (tool.execution !== 'client') bad('无效的 tool_search execution');
      add({ type: 'function', name: 'tool_search', description: tool.description || 'Discover client tools before using them.', parameters: tool.parameters || { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } });
      const name = specs.at(-1).name; mappings.set(name, { ...tool, name: 'tool_search', type: 'tool_search' });
      continue;
    }
    if (tool?.type === 'programmatic_tool_calling' && tool.enabled === false) continue;
    if (tool?.type === 'namespace') {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(tool.name || '') || !Array.isArray(tool.tools)) bad('远程 namespace 工具格式无效');
      for (const t of tool.tools) add(t, tool.name);
    } else add(tool);
  }
  if (specs.length > 256) bad('远程工具列表无效（最多 256 项）');
  if (choice === 'none' || isWebSearch(choice)) return { specs: [], mappings: new Map(), webSearch };
  if (typeof choice === 'object') {
    if (!['function', 'custom'].includes(choice?.type)) bad('远程暂不支持此 tool_choice');
    const entry = [...mappings].find(([, t]) => t.name === choice.name && t.type === choice.type && (!choice.namespace || t.namespace === choice.namespace));
    if (!entry) bad('tool_choice 指定的工具不存在');
    return { specs: specs.filter(s => s.name === entry[0]), mappings: new Map([entry]), webSearch };
  }
  if (!['auto', 'required'].includes(choice)) bad('远程暂不支持此 tool_choice');
  if (choice === 'required' && !specs.length && webSearch.mode === 'disabled') bad('tool_choice=required 需要工具');
  return { specs, mappings, webSearch };
}

// Convert client Responses items into the app-server's native history shape.
// This keeps the full structured transcript out of turn/start's text input.
export function historyContent(content) {
  if (typeof content === 'string') return content ? [{ type: 'input_text', text: content }] : [];
  if (!Array.isArray(content)) bad('远程消息内容格式无效');
  return content.map(part => {
    if (typeof part === 'string') return { type: 'input_text', text: part };
    if (['input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string') return { type: part.type, text: part.text };
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'input_text', text: part.text };
    if (part?.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (!url) bad('远程图片输入缺少 image_url');
      return { type: 'input_image', image_url: url, ...(part.detail ? { detail: part.detail } : {}) };
    }
    if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (!url) bad('远程图片输入缺少 image_url');
      return { type: 'input_image', image_url: url, ...(part.detail ? { detail: part.detail } : {}) };
    }
    bad('远程消息包含不支持的内容类型: ' + String(part?.type || '').slice(0, 60));
  });
}
function historyOutput(output) {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) bad('远程工具结果格式无效');
  return output.map(part => {
    if (part?.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (!url) bad('远程工具图片结果缺少 image_url');
      return { type: 'input_image', image_url: url, ...(part.detail ? { detail: part.detail } : {}) };
    }
    if (['input_text', 'text'].includes(part?.type) && typeof part.text === 'string') return { type: 'input_text', text: part.text };
    bad('远程工具结果仅支持文本和图片');
  });
}
export function historyItem(item) {
  if (!item || typeof item !== 'object') bad('远程历史项格式无效');
  if (!item.type && item.role) item = { ...item, type: 'message' };
  if (item.type === 'message') {
    if (!['user', 'assistant', 'system', 'developer'].includes(item.role)) bad('远程历史消息角色无效');
    return { type: 'message', role: item.role === 'system' ? 'developer' : item.role, content: historyContent(item.content) };
  }
  if (item.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.filter(x => typeof x?.text === 'string').map(x => ({ type: 'summary_text', text: x.text })) : [];
    const content = Array.isArray(item.content) ? item.content.filter(x => typeof x?.text === 'string').map(x => ({ type: x.type === 'reasoning_text' ? 'reasoning_text' : 'text', text: x.text })) : [];
    if (!summary.length && !content.length && !item.encrypted_content) return null;
    return { type: 'reasoning', summary, ...(content.length ? { content } : {}), ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}) };
  }
  if (item.type === 'function_call') {
    if (typeof item.call_id !== 'string' || typeof item.name !== 'string') bad('远程函数调用历史格式无效');
    return { type: 'function_call', call_id: item.call_id, name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}), ...(item.namespace ? { namespace: item.namespace } : {}) };
  }
  if (item.type === 'function_call_output') {
    if (typeof item.call_id !== 'string') bad('远程函数结果历史格式无效');
    return { type: 'function_call_output', call_id: item.call_id, output: historyOutput(item.output), ...(item.name ? { name: item.name } : {}), ...(item.namespace ? { namespace: item.namespace } : {}) };
  }
  if (item.type === 'custom_tool_call') {
    if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.input !== 'string') bad('远程 custom 调用历史格式无效');
    return { type: 'custom_tool_call', call_id: item.call_id, name: item.name, input: item.input };
  }
  if (item.type === 'custom_tool_call_output') {
    if (typeof item.call_id !== 'string') bad('远程 custom 结果历史格式无效');
    return { type: 'custom_tool_call_output', call_id: item.call_id, output: historyOutput(item.output), ...(item.name ? { name: item.name } : {}) };
  }
  if (item.type === 'tool_search_call') {
    return { type: 'tool_search_call', execution: item.execution || 'client', arguments: item.arguments ?? {}, ...(item.call_id ? { call_id: item.call_id } : {}), ...(item.status ? { status: item.status } : {}) };
  }
  if (item.type === 'tool_search_output') {
    if (!Array.isArray(item.tools)) bad('远程 tool search 历史格式无效');
    return { type: 'tool_search_output', execution: item.execution || 'client', status: 'completed', tools: item.tools, ...(item.call_id ? { call_id: item.call_id } : {}) };
  }
  if (item.type === 'web_search_call') return { type: 'web_search_call', ...(item.status ? { status: item.status } : {}), ...(item.action ? { action: item.action } : {}), ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}) };
  if (item.type === 'image_generation_call') return { type: 'image_generation_call', result: item.result || '', status: item.status || 'completed' };
  bad('远程历史不支持此输入项: ' + String(item.type || item.role).slice(0, 80));
}
export function historyItems(input) { return input.map(historyItem).filter(Boolean); }
export function currentTurnInput(input) {
  const item = input.at(-1);
  if (!item || (item.type && item.type !== 'message') || item.role !== 'user') throw bad('远程请求最后一项必须是当前用户消息；工具结果续接需要保留同一会话');
  const parts = historyContent(item.content), result = [];
  const text = parts.filter(p => ['input_text', 'output_text', 'text'].includes(p.type)).map(p => p.text).join('\n');
  if (text) result.push({ type: 'text', text });
  for (const part of parts) if (part.type === 'input_image') result.push({ type: 'image', url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) });
  if (!result.length) throw bad('当前用户消息不能为空');
  return result;
}
function historyChunks(items, maxChars = 256 * 1024, maxItems = 64) {
  const chunks = []; let current = [], size = 0;
  for (const item of items) {
    const itemSize = JSON.stringify(item).length;
    if (current.length && (size + itemSize > maxChars || current.length >= maxItems)) { chunks.push(current); current = []; size = 0; }
    current.push(item); size += itemSize;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function agentInput(body, endpoint) {
  if (endpoint === 'responses' && Array.isArray(body.input)) {
    const extras = body.input.filter(i => i.type === 'additional_tools' || i.type === 'tool_search_output');
    if (extras.some(i => !Array.isArray(i.tools))) bad('additional_tools 格式无效');
    const combined = [...(body.tools || []), ...extras.flatMap(i => i.tools)];
    // Tool search outputs can repeat a previously loaded definition. Latest wins.
    const catalog = new Map();
    for (const t of combined) {
      const key = t.type + ':' + (t.name || t.function?.name || '');
      if (t.type === 'namespace' && catalog.get(key)?.tools && Array.isArray(t.tools)) {
        const nested = new Map(catalog.get(key).tools.map(x => [x.name, x]));
        for (const x of t.tools) nested.set(x.name, x);
        catalog.set(key, { ...t, tools: [...nested.values()] });
      } else catalog.set(key, t);
    }
    return { ...body, tools: [...catalog.values()], input: body.input.filter(i => i.type !== 'additional_tools').map(i => i.type === 'tool_search_output' && typeof i.call_id === 'string' ? { type: 'function_call_output', call_id: i.call_id, output: JSON.stringify({ tools: i.tools }) } : i) };
  }
  if (endpoint === 'chat/completions') {
    if (!Array.isArray(body.messages) || !body.messages.length) bad('messages 必须为非空数组');
    const input = body.messages.flatMap(m => {
      if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content }];
      const message = { role: m.role, content: Array.isArray(m.content) ? m.content.map(c => c.type === 'image_url' ? { type: 'input_image', image_url: c.image_url?.url } : c) : m.content };
      if (m.role === 'assistant' && m.tool_calls?.length) return [...(m.content ? [message] : []), ...m.tool_calls.map(t => ({ type: 'function_call', call_id: t.id, name: t.function?.name, arguments: t.function?.arguments }))];
      return [message];
    });
    return { ...body, input,
      tools: (body.tools || []).map(t => t.type === 'function' ? { type: 'function', ...t.function } : t), tool_choice: typeof body.tool_choice === 'object' ? { type: body.tool_choice.type, ...body.tool_choice.function } : body.tool_choice };
  }
  return body;
}

// app-server has no per-turn max-token field. Preserve the request as a disclosed
// generation hint; never pretend an unsupported config key enforces a hard cap.
export function outputBudget(body) {
  const values = [];
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || value <= 0) bad(`${key} 必须为正整数`);
    values.push(value);
  }
  return values.length ? Math.min(...values) : undefined;
}
function budgetResponse(response, budget) {
  if (budget !== undefined) {
    response.max_output_tokens = budget;
    response.metadata = { model_harbor_output_limit: 'hint', model_harbor_requested_output_tokens: String(budget) };
  }
  return response;
}

export function validateAgent(body) {
  if (body.previous_response_id || body.conversation || body.background || body.store === true) bad('远程工具桥接需要 store=false 和完整对话历史，不支持服务端会话参数');
  if (body.n && body.n !== 1) bad('远程工具桥接只支持 n=1');
  for (const k of ['temperature', 'top_p']) if (body[k] !== undefined) bad(`远程工具桥接暂不支持参数 ${k}`);
  const budget = outputBudget(body);
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input) || !input.length) bad('Responses 请求必须提供 input');
  const outputs = [];
  for (const item of input) {
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      if (typeof item.call_id !== 'string' || !(typeof item.output === 'string' || Array.isArray(item.output))) bad('远程工具结果格式无效');
      outputs.push(item);
    } else if (['function_call', 'custom_tool_call', 'tool_search_call', 'tool_search_output', 'web_search_call', 'reasoning'].includes(item.type)) continue;
    else if ((!item.type || item.type === 'message') && ['user', 'assistant', 'system', 'developer'].includes(item.role)) {
      if (typeof item.content !== 'string' && (!Array.isArray(item.content) || item.content.some(p => !['input_text', 'output_text', 'text', 'input_image'].includes(p.type)))) bad('远程工具桥接不支持此消息内容');
    } else bad('远程工具桥接不支持此输入项: ' + String(item.type || item.role).slice(0, 80));
  }
  return { input, outputs, budget };
}

// One bounded JSON-RPC process per active conversation; no token or login export.
class RPC {
  constructor(child) {
    this.child = child; this.id = 0; this.pending = new Map(); this.events = []; this.waiter = null; this.closed = false;
    const decoder = new StringDecoder('utf8'); let buffer = '';
    child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
    child.stdout.on('data', bytes => {
      buffer += decoder.write(bytes);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        if (index > RPC_MESSAGE_LIMIT) return this.fail(rpcTooLarge());
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch { this.fail(failed()); return; }
        if (!event.method && this.pending.has(event.id)) {
          const p = this.pending.get(event.id); this.pending.delete(event.id);
          if (event.error) {
            const detail = String(event.error.message || '').replace(/\s+/g, ' ').slice(0, 240);
            const code = /unknown variant|unknown method/i.test(detail) ? 'codex_app_server_unsupported' : 'codex_app_server_error';
            const error = new HttpError(502, code === 'codex_app_server_unsupported' ? 'Remote Codex CLI does not support the required app-server method' : 'Remote Codex app-server rejected the request', code);
            error.rpcDetail = detail; p.reject(error);
          } else p.resolve(event.result);
        } else if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve(event); }
        else { this.events.push(event); if (this.events.length > 10000) return this.fail(failed()); }
      }
      if (buffer.length > RPC_MESSAGE_LIMIT) return this.fail(rpcTooLarge());
    });
    child.on('error', () => this.fail(failed())); child.on('close', () => this.fail(failed()));
  }
  send(value) { if (this.closed) throw failed(); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  call(method, params) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); try { this.send({ id, method, params }); } catch (e) { this.pending.delete(id); reject(e); } }); }
  next() { if (this.closed) return Promise.reject(failed()); if (this.events.length) return Promise.resolve(this.events.shift()); return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; }); }
  fail(error) {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) p.reject(error); this.pending.clear();
    this.waiter?.reject(error); this.waiter = null; this.events = [];
    this.child.stdin.end(); this.child.kill();
  }
  close() { this.fail(failed()); }
}

export class NasAgentBridge {
  constructor({ launch = (p) => { const c = agentCommand(p); return spawn(c.command, c.args, { windowsHide: true }); }, idleMs = 10 * 60 * 1000, maxSessions = 8 } = {}) {
    this.launch = launch; this.idleMs = idleMs; this.maxSessions = maxSessions; this.sessions = new Set(); this.calls = new Map(); this.completedCalls = new Map();
    this.usageReaders = new Set(); this.usageCache = new Map(); this.usageGeneration = 0;
  }
  dispose(s) { clearTimeout(s.idle); s.rpc.close(); this.sessions.delete(s); for (const [id, value] of this.calls) if (value === s) this.calls.delete(id); }
  close() { for (const s of [...this.sessions]) this.dispose(s); for (const rpc of this.usageReaders) rpc.close(); this.completedCalls.clear(); this.usageCache.clear(); }
  async models(p, signal) {
    if (p.type !== 'nas-codex') throw new HttpError(400, '仅 Codex 供应商支持模型发现');
    if (signal?.aborted) throw new HttpError(499, '请求已取消');
    if (this.usageReaders.size >= 4) throw new HttpError(429, '远程 Codex 检索引擎繁忙，请稍后重试');
    const rpc = new RPC(this.launch(p)); this.usageReaders.add(rpc);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; rpc.close(); }, 25000);
    const abort = () => rpc.close(); signal?.addEventListener('abort', abort, { once: true });
    try {
      await rpc.call('initialize', { clientInfo: { name: 'model_harbor', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized', params: {} });
      const ids = []; let cursor = null;
      do {
        const page = await rpc.call('model/list', { cursor, includeHidden: false, limit: 100 });
        if (!Array.isArray(page?.data)) throw new HttpError(502, 'Codex model/list 返回格式不正确', 'codex_model_list_invalid');
        for (const item of page.data) {
          const id = item?.id || item?.model;
          if (!item?.hidden && typeof id === 'string' && id) ids.push(id);
        }
        cursor = page.nextCursor || null;
      } while (cursor);
      if (!ids.length) throw new HttpError(502, 'Codex 没有返回可用模型，请检查账号权限和登录状态', 'codex_models_empty');
      return [...new Set(ids)];
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(signal?.aborted ? 499 : timedOut ? 504 : 502,
        signal?.aborted ? '请求已取消' : timedOut ? 'Codex 模型发现超时，请稍后重试' : '无法读取 Codex 模型列表，请检查目标环境的登录状态、网络和 CLI 版本',
        'codex_models_failed');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); rpc.close(); this.usageReaders.delete(rpc); }
  }
  async usage(p, signal) {
    if (p.type !== 'nas-codex') throw new HttpError(400, '仅 Codex 供应商支持账号用量查询');
    if (signal?.aborted) throw new HttpError(499, '请求已取消');
    const signature = JSON.stringify(p), cached = this.usageCache.get(p.id), generation = this.usageGeneration;
    if (cached?.signature === signature && Date.now() - cached.at < 30000) return structuredClone(cached.value);
    if (this.usageReaders.size >= 4) throw new HttpError(429, '用量查询繁忙，请稍后重试');
    const rpc = new RPC(this.launch(p)); this.usageReaders.add(rpc);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; rpc.close(); }, 15000);
    const abort = () => rpc.close(); signal?.addEventListener('abort', abort, { once: true });
    try {
      await rpc.call('initialize', { clientInfo: { name: 'model_harbor', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized', params: {} });
      const value = normalizeUsage(await rpc.call('account/rateLimits/read', {}));
      if (generation === this.usageGeneration) this.usageCache.set(p.id, { signature, value, at: Date.now() });
      if (this.usageCache.size > 64) this.usageCache.delete(this.usageCache.keys().next().value);
      return structuredClone(value);
    } catch {
      throw new HttpError(signal?.aborted ? 499 : timedOut ? 504 : 502, signal?.aborted ? '请求已取消' : timedOut ? '用量查询超时，请稍后重试' : '无法读取 Codex 用量，请检查目标环境的登录状态、网络和 Codex 版本');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); rpc.close(); this.usageReaders.delete(rpc); }
  }
  async resetUsage(p, input, signal) {
    if (p.type !== 'nas-codex') throw new HttpError(400, '仅 Codex 供应商支持账号用量查询');
    if (input.confirmed !== true || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.idempotencyKey || '')) throw new HttpError(400, '请确认重置操作并提供有效的操作标识');
    if (signal?.aborted) throw new HttpError(499, '请求已取消');
    if (this.resetInFlight) throw new HttpError(409, '重置操作正在处理中，请稍后重试');
    if (this.usageReaders.size >= 4) throw new HttpError(429, '用量查询繁忙，请稍后重试');
    const rpc = new RPC(this.launch(p)); this.usageReaders.add(rpc); this.resetInFlight = true;
    // An interrupted response does not prove that no credit was consumed. The caller
    // retains the same idempotency key until an authoritative outcome is received.
    const timer = setTimeout(() => rpc.close(), 15000), abort = () => rpc.close();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await rpc.call('initialize', { clientInfo: { name: 'model_harbor', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized', params: {} });
      this.usageGeneration++; this.usageCache.clear();
      const { outcome } = await rpc.call('account/rateLimitResetCredit/consume', { idempotencyKey: input.idempotencyKey });
      if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(outcome)) throw failed();
      this.usageGeneration++; this.usageCache.clear();
      try {
        const usage = normalizeUsage(await rpc.call('account/rateLimits/read', {}));
        this.usageCache.set(p.id, { signature: JSON.stringify(p), value: usage, at: Date.now() });
        return { outcome, usage };
      } catch { return { outcome, usage: null }; }
    } catch {
      throw new HttpError(502, '重置结果尚未确认；请使用同一次操作重试，避免重复消耗次数。');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); rpc.close(); this.usageReaders.delete(rpc); this.resetInFlight = false; }
  }
  async run(p, model, rawBody, endpoint, signal, onEvent) {
    const body = agentInput(rawBody, endpoint), { input, outputs, budget } = validateAgent(body), { specs, mappings, webSearch } = toolSpecs(body.tools, body.tool_choice);
    const signature = JSON.stringify([p, model, specs, budget, webSearch]);
    for (const output of outputs.slice(-1)) {
      const previous = this.completedCalls.get(output.call_id);
      if (input.filter(i => i.type !== 'reasoning').at(-1) === output && previous && previous.signature === signature && previous.output === JSON.stringify(output) && Date.now() - previous.at < this.idleMs) return structuredClone(previous.response);
    }
    const matches = outputs.filter(o => this.calls.has(o.call_id));
    let s = matches.length ? this.calls.get(matches.at(-1).call_id) : null;
    if (s && s.signature !== signature) { this.dispose(s); s = null; }
    if (s?.busy) throw new HttpError(409, '同一工具结果正在处理中，请勿重复提交');
    if (!s) {
      if (this.sessions.size >= this.maxSessions) throw new HttpError(429, '远程工具会话已满，请稍后重试');
      s = { rpc: new RPC(this.launch(p)), signature, mappings, busy: false }; this.sessions.add(s);
    }
    clearTimeout(s.idle); s.busy = true; let resumed;
    const finish = response => {
      if (resumed) {
        this.completedCalls.set(resumed.call_id, { signature, output: JSON.stringify(resumed), response: structuredClone(response), at: Date.now() });
        if (this.completedCalls.size > 100) this.completedCalls.delete(this.completedCalls.keys().next().value);
      }
      return response;
    };
    const abort = () => this.dispose(s);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, (p.timeout || 600) * 1000);
    try {
      if (signal?.aborted) throw new HttpError(408, '请求已取消');
      const response = budgetResponse(responseBase(rawBody.model), budget); response.tools = body.tools || []; response.tool_choice = body.tool_choice || 'auto'; response.parallel_tool_calls = false;
      if (webSearch.unsupportedContentTypes) response.metadata = {...response.metadata, model_harbor_unsupported_search_content_types: webSearch.unsupportedContentTypes.join(',')};
      if (s.waiting) {
        const output = outputs.find(o => o.call_id === s.waiting.callId);
        if (!output) bad('缺少待执行工具的返回结果');
        const contentItems = typeof output.output === 'string' ? [{ type: 'inputText', text: output.output }] : output.output.map(c => {
          if (c.type === 'input_text' || c.type === 'text') return { type: 'inputText', text: c.text };
          if (c.type === 'input_image' && typeof c.image_url === 'string') return { type: 'inputImage', imageUrl: c.image_url };
          bad('远程工具返回内容仅支持文本或图片');
        });
        resumed = output;
        s.rpc.send({ id: s.waiting.id, result: { contentItems, success: true } }); s.waiting = null;
      } else {
        await s.rpc.call('initialize', { clientInfo: { name: 'model_harbor', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        s.rpc.send({ method: 'initialized', params: {} });
        const searchInstructions = webSearch.mode === 'disabled' ? '' : ' The client explicitly enabled the upstream native web_search tool. You may use that native search tool for internet research; this is the sole exception to client-only tools. A required web_search choice MUST perform an actual native search before answering. Never simulate search with a client function or claim to search without doing so.';
        const instructions = 'You are the reasoning engine for an external coding client. Only use the supplied dynamic client tools. All filesystem, shell and patch operations MUST be requested using those tools and executed by the client. Never use server-side tools, skills, MCP, shell or filesystem access. IMPORTANT: the proxy server read-only sandbox applies only to this remote process. It does NOT forbid REQUESTING an operation through a client_* tool; the external client enforces its own permissions. When the user names a tool such as apply_patch, ALWAYS call its client_* counterpart, never the remote built-in tool. Do not claim a client operation failed before requesting its client_* tool and receiving its result. Paths in client tools belong to the CLIENT workspace in the conversation history, never this remote proxy cwd /tmp. Preserve client-relative paths; never resolve them against /tmp. The native thread history contains the conversation and client tool results; follow its role hierarchy. Continue the last user task. Custom tools receive their exact raw text through the input field. Tool names are mapped in their descriptions.\n' + (body.instructions || '') + '\nTool choice: ' + JSON.stringify(body.tool_choice || 'auto');
        const budgetHint = budget === undefined ? '' : `\nThe client requests an output budget of ${budget} tokens for each model response, including reasoning and tool arguments. Aim to stay within this budget; be concise. This is a generation hint, not a server-enforced hard token cap. Do not truncate tool inputs or output malformed arguments to fit it.`;
        const thread = await s.rpc.call('thread/start', { model, cwd: '/tmp', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: instructions + searchInstructions + (webSearch.unsupportedContentTypes ? '\nNative image search is unavailable on this upstream. The client may advertise image alongside text search by default; that does not require an image search for ordinary chat. For actual image search, use an appropriate supplied client tool if available; otherwise explain the limitation. Never claim to have searched images using the native text search tool.' : '') + budgetHint, dynamicTools: specs,
          config: { 'features.shell_tool': false, 'features.apply_patch_freeform': false, 'features.multi_agent': false, 'features.image_generation': false, 'features.apps': false, 'features.plugins': false, web_search: webSearch.mode, 'tools.web_search': webSearch.mode === 'disabled' ? false : webSearch.options || {}, mcp_servers: {} } });
        s.threadId = thread.thread.id;
        const history = historyItems(input.slice(0, -1));
        const current = currentTurnInput(input);
        if (history.length) {
          try {
            for (const chunk of historyChunks(history)) await s.rpc.call('thread/inject_items', { threadId: s.threadId, items: chunk });
          } catch (e) {
            // Older app-server builds do not expose native history injection.
            // Keep the official CLI path for short histories, but never
            // silently truncate or fall back to credential-level HTTP.
            if (e?.code !== 'codex_app_server_unsupported') throw e;
            const transcript = input.map(i => Array.isArray(i.content) ? { ...i, content: i.content.map(c => c.type === 'input_image' ? { type: 'text', text: '[attached image]' } : c) } : i);
            if (JSON.stringify(transcript).length > 1048576) throw new HttpError(413, '目标 Codex CLI 不支持长历史原生注入；请升级 CLI，或压缩会话后再试', 'remote_input_too_large');
            s.legacyTranscript = transcript;
          }
        }
        const turnInput = s.legacyTranscript ? [{ type: 'text', text: JSON.stringify(s.legacyTranscript) }, ...current.filter(item => item.type === 'image')] : current;
        await s.rpc.call('turn/start', { threadId: s.threadId, input: turnInput, ...(body.reasoning?.effort || body.reasoning_effort ? { effort: body.reasoning?.effort || body.reasoning_effort } : {}) });
      }
      while (true) {
        const event = await s.rpc.next(), params = event.params || {};
        if (event.method === 'item/started' && params.item?.type === 'agentMessage') {
          if (onEvent) await onEvent({ type: 'message_started', item: params.item });
        } else if (event.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          if (onEvent) await onEvent({ type: 'text_delta', itemId: params.itemId, delta: params.delta });
        } else if (event.method === 'item/completed' && params.item?.type === 'agentMessage') {
          const text = params.item.text;
          const item = text ? { id: params.item.id || uid('msg_'), type: 'message', role: 'assistant', status: 'completed', ...(params.item.phase ? { phase: params.item.phase } : {}), content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] } : null;
          if (item) response.output.push(item);
          if (onEvent) await onEvent({ type: 'message_done', item });
        } else if (event.method === 'item/completed' && params.item?.type === 'webSearch') {
          if (webSearch.mode === 'disabled') throw failed();
          response.output.push(searchItem(params.item));
        } else if (event.method === 'item/tool/call' && event.id !== undefined) {
          const tool = s.mappings.get(params.tool); if (!tool) throw failed();
          const item = { id: uid(tool.type === 'custom' ? 'ctc_' : 'fc_'), type: tool.type === 'tool_search' ? 'tool_search_call' : tool.type === 'custom' ? 'custom_tool_call' : 'function_call', status: 'completed', call_id: params.callId, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) };
          if (tool.type === 'tool_search') { delete item.name; item.execution = 'client'; item.arguments = params.arguments; }
          else if (tool.type === 'custom') { if (typeof params.arguments?.input !== 'string') throw failed(); item.input = params.arguments.input; }
          else item.arguments = JSON.stringify(params.arguments);
          response.output.push(item); response.status = 'completed';
          s.waiting = { id: event.id, callId: params.callId }; this.calls.set(params.callId, s);
          s.idle = setTimeout(() => this.dispose(s), this.idleMs); s.idle.unref(); return finish(response);
        } else if (event.method === 'turn/completed' || event.method === 'turn/failed') {
          const status = params.turn?.status || (event.method === 'turn/failed' ? 'failed' : '');
          if (status !== 'completed') {
            const detail = String(params.turn?.error?.message || params.error?.message || '').slice(0, 400);
            if (/context window|contextWindow|too many tokens|token limit/i.test(detail)) throw new HttpError(413, '远程 Codex 上下文已超出模型窗口；请压缩历史或减少附件', 'remote_context_window_exceeded');
            throw new HttpError(502, detail ? '远程 Codex 回合失败：' + detail : '远程 Codex 回合失败，请检查登录、模型权限和 CLI 日志', 'codex_turn_failed');
          }
          if ((body.tool_choice === 'required' || (body.tool_choice && typeof body.tool_choice === 'object')) && !response.output.some(i => i.type === 'web_search_call')) throw new HttpError(502, '远程模型未按 tool_choice 调用工具');
          response.status = 'completed'; this.dispose(s); return finish(response);
        } else if (event.method === 'thread/tokenUsage/updated') {
          const u = params.tokenUsage?.last;
          if (u) response.usage = { input_tokens: u.inputTokens || 0, output_tokens: u.outputTokens || 0, total_tokens: u.totalTokens || 0, input_tokens_details: { cached_tokens: u.cachedInputTokens || 0 }, output_tokens_details: { reasoning_tokens: u.reasoningOutputTokens || 0 } };
        } else if (event.method === 'error' && !params.willRetry) throw failed();
        else if (event.id !== undefined && event.method) {
          // Unexpected approval/local tool requests are refused, never auto-approved.
          s.rpc.send({ id: event.id, error: { code: -32601, message: 'Only client dynamic tools are supported' } }); throw failed();
        }
      }
    } catch (e) { this.dispose(s); throw e; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); s.busy = false; if (resumed && this.calls.get(resumed.call_id) === s) this.calls.delete(resumed.call_id); }
  }
}

export function agentChat(response) {
  const tools = response.output.filter(i => ['function_call', 'custom_tool_call'].includes(i.type));
  return { id: response.id, object: 'chat.completion', created: response.created_at, model: response.model,
    choices: [{ index: 0, message: { role: 'assistant', content: response.output.filter(i => i.type === 'message').flatMap(i => i.content).map(c => c.text).join('\n') || null,
      ...(tools.length ? { tool_calls: tools.map(i => ({ id: i.call_id, type: 'function', function: { name: i.name, arguments: i.arguments || JSON.stringify({ input: i.input }) } })) } : {}) }, finish_reason: tools.length ? 'tool_calls' : 'stop' }],
    ...(response.metadata ? { metadata: response.metadata } : {}),
    ...(response.usage ? { usage: { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens, total_tokens: response.usage.total_tokens } } : {}) };
}

export async function sendAgent(bridge, p, model, body, endpoint, res, signal) {
  if (!body.stream) { const response = await bridge.run(p, model, body, endpoint, signal); return endpoint === 'responses' ? response : agentChat(response); }
  const normalized = agentInput(body, endpoint); validateAgent(normalized); const toolPlan = toolSpecs(normalized.tools, normalized.tool_choice);
  openSSE(res); let seq = 0;
  const emit = (type, fields) => writeSSE(res, { type, sequence_number: seq++, ...fields }, type);
  const initial = budgetResponse(responseBase(body.model), outputBudget(normalized));
  if (endpoint === 'responses') { await emit('response.created', { response: initial }); await emit('response.in_progress', { response: initial }); }
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000); heartbeat.unref();
  const streamed = new Set(), live = new Map();
  const ensureMessage = async item => {
    if (!item?.id) return null;
    let state = live.get(item.id);
    if (!state) {
      state = { index: live.size, text: '', message: { id: item.id, type: 'message', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: '', annotations: [], logprobs: [] }] } };
      live.set(item.id, state); streamed.add(item.id);
      await emit('response.output_item.added', { output_index: state.index, item: structuredClone(state.message) });
      await emit('response.content_part.added', { item_id: item.id, output_index: state.index, content_index: 0, part: { ...state.message.content[0], text: '' } });
    }
    return state;
  };
  const onEvent = async event => {
    if (endpoint !== 'responses') return;
    if (event.type === 'message_started') { await ensureMessage(event.item); return; }
    if (event.type === 'text_delta') {
      const state = await ensureMessage({ id: event.itemId });
      if (!state) return;
      state.text += event.delta; state.message.content[0].text = state.text;
      await emit('response.output_text.delta', { item_id: event.itemId, output_index: state.index, content_index: 0, delta: event.delta, logprobs: [] });
      return;
    }
    if (event.type === 'message_done' && event.item) {
      const state = await ensureMessage({ id: event.item.id });
      if (!state) return;
      state.text = event.item.content?.[0]?.text ?? state.text;
      state.message.content[0].text = state.text; state.message.status = 'completed';
      if (event.item.phase) state.message.phase = event.item.phase;
      const meta = { output_index: state.index, item_id: event.item.id };
      await emit('response.output_text.done', { ...meta, content_index: 0, text: state.text, logprobs: [] });
      await emit('response.content_part.done', { ...meta, content_index: 0, part: state.message.content[0] });
      await emit('response.output_item.done', { output_index: state.index, item: state.message });
    }
  };
  // Native web search can emit a separate output item before the final message;
  // keep that path buffered so its output indices remain stable.
  const liveText = endpoint === 'responses' && toolPlan.webSearch.mode === 'disabled';
  let response; try { response = await bridge.run(p, model, body, endpoint, signal, liveText ? onEvent : undefined); } finally { clearInterval(heartbeat); }
  response.id = initial.id;
  if (endpoint === 'responses') {
    for (let index = 0; index < response.output.length; index++) {
      const item = response.output[index], meta = { output_index: index, item_id: item.id };
      if (item.type === 'message' && streamed.has(item.id)) continue;
      const tool = item.type !== 'message';
      await emit('response.output_item.added', { output_index: index, item: tool ? { ...item, status: 'in_progress', ...(item.type === 'custom_tool_call' ? { input: '' } : ['tool_search_call','web_search_call'].includes(item.type) ? {} : { arguments: '' }) } : { ...item, status: 'in_progress', content: [] } });
      if (item.type === 'web_search_call') {
        for (const status of ['in_progress','searching','completed']) await emit('response.web_search_call.' + status, meta);
      } else if (tool && item.type !== 'tool_search_call') {
        const custom = item.type === 'custom_tool_call', stem = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments', field = custom ? 'input' : 'arguments';
        await emit(stem + '.delta', { ...meta, delta: item[field] }); await emit(stem + '.done', { ...meta, [field]: item[field], name: item.name });
      } else if (!tool) {
        const part = item.content[0];
        await emit('response.content_part.added', { ...meta, content_index: 0, part: { ...part, text: '' } });
        await emit('response.output_text.delta', { ...meta, content_index: 0, delta: part.text, logprobs: [] });
        await emit('response.output_text.done', { ...meta, content_index: 0, text: part.text, logprobs: [] });
        await emit('response.content_part.done', { ...meta, content_index: 0, part });
      }
      await emit('response.output_item.done', { output_index: index, item });
    }
    await emit('response.completed', { response });
  } else {
    const chat = agentChat(response), { message, finish_reason } = chat.choices[0], base = { id: chat.id, object: 'chat.completion.chunk', created: chat.created, model: chat.model };
    await writeSSE(res, { ...base, choices: [{ index: 0, delta: { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((t, index) => ({ ...t, index })) } : {}) }, finish_reason: null }] });
    await writeSSE(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason }] });
    if (chat.usage) await writeSSE(res, { ...base, choices: [], usage: chat.usage });
    await writeSSE(res, '[DONE]');
  }
  res.end(); return null;
}
