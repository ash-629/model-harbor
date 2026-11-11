// AG-01..AG-05: native Codex app-server dynamic tools, executed by the API client.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { retryBudget, retryDelay, markOutput, completeMetrics } from './request-runtime.js';
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
const rpcDetail = value => String(value || '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, '[redacted]').replace(/\s+/g, ' ').trim().slice(-500);
const failed = detail => new HttpError(502, detail ? `远程 Codex 工具桥接失败：${rpcDetail(detail)}` : '远程 Codex 工具桥接失败，请检查登录、模型权限和 app-server 版本');
// gpt-5.x on the ChatGPT backend reports capacity exhaustion as a plain error
// event. It is transient: retry the same turn before failing the client task.
const CAPACITY_PATTERN = /at capacity|overloaded|server is busy|capacity exceeded|模型.{0,8}(繁忙|满载|容量)/i;
export const isCapacityDetail = detail => CAPACITY_PATTERN.test(String(detail || ''));
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
// A coding turn can legitimately span many client tool rounds. Keep a hard
// outer bound for abandoned processes, but do not cap normal work at 20 min.
const agentMaxSeconds = Math.max(600, Math.floor(Number(process.env.MH_AGENT_MAX_SECONDS || 7200)) || 7200);
export const agentTail = ['timeout', '--signal=TERM', '--kill-after=5s', `${agentMaxSeconds}s`, 'codex', 'app-server', '--listen', 'stdio://',
  // Derive the built-in provider so the stream idle timeout can be raised above 30s.
  '-c', 'model_provider="openai-mh"',
  '-c', 'model_providers.openai-mh.name="OpenAI via Model Harbor"',
  '-c', 'model_providers.openai-mh.base_url="https://chatgpt.com/backend-api/codex"',
  '-c', 'model_providers.openai-mh.wire_api="responses"',
  '-c', 'model_providers.openai-mh.requires_openai_auth=true',
  '-c', 'model_providers.openai-mh.stream_idle_timeout_ms=180000',
  '-c', 'features.shell_tool=false', '-c', 'features.apply_patch_freeform=false', '-c', 'features.multi_agent=false',
  '-c', 'features.image_generation=false', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'web_search="disabled"'];
export function agentCommand(p) {
  const tail = [...agentTail]; tail[4] = codexExecutable(p);
  const command = [...runtimePrefix(p), ...tail];
  return sshCommand(p, command);
}

const SCHEMA_METADATA_KEYS = new Set(['$schema','$id','$comment','examples','default','title','deprecated','readOnly','writeOnly']);
const SCHEMA_MAPS = new Set(['properties','patternProperties','$defs','definitions','dependentSchemas','dependencies']);
function compactSchema(value, descriptionLimit) {
  if (Array.isArray(value)) return value.map(v => compactSchema(v, descriptionLimit));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (SCHEMA_MAPS.has(key) && inner && typeof inner === 'object' && !Array.isArray(inner)) {
      out[key] = Object.fromEntries(Object.entries(inner).map(([name, schema]) => [name, compactSchema(schema, descriptionLimit)]));
      continue;
    }
    if (SCHEMA_METADATA_KEYS.has(key)) continue;
    if (key === 'description' && typeof inner === 'string') {
      if (descriptionLimit > 0) out[key] = inner.slice(0, descriptionLimit);
      continue;
    }
    out[key] = compactSchema(inner, descriptionLimit);
  }
  return out;
}
function compactFunctionSpec(tool, descriptionLimit) {
  const hint = tool.formatHint || '', base = tool.descriptionBase ?? tool.description ?? '';
  const out = {
    type: 'function',
    name: tool.name,
    // description is required by DynamicToolSpec; keep an empty string at the smallest budget.
    description: descriptionLimit > 0 ? String(base).slice(0, descriptionLimit) + hint : hint.trim(),
    inputSchema: compactSchema(tool.inputSchema || { type: 'object', properties: {} }, descriptionLimit)
  };
  if (tool.deferLoading) out.deferLoading = true;
  return out;
}
function compactToolSpec(tool, descriptionLimit) {
  if (tool?.type !== 'namespace') return compactFunctionSpec(tool, descriptionLimit);
  return {
    type: 'namespace',
    name: tool.name,
    description: descriptionLimit > 0 ? String(tool.description || '').slice(0, descriptionLimit) : '',
    tools: (tool.tools || []).map(t => compactFunctionSpec(t, descriptionLimit))
  };
}
// app-server rejects a single thread/start JSON-RPC message above ~1 MiB.
// Keep callable tool names, but compact verbose schemas and descriptions to fit.
export function fitToolSpecs(specs, maxBytes = 900 * 1024) {
  const limit = Number.isFinite(maxBytes) ? Math.max(32 * 1024, maxBytes) : 900 * 1024;
  const originalBytes = Buffer.byteLength(JSON.stringify(specs));
  // Try the untouched spec first; only lose text when the RPC budget requires it.
  for (const descriptionLimit of [Infinity, 800, 400, 200, 100, 50, 0]) {
    const copy = specs.map(tool => compactToolSpec(tool, descriptionLimit));
    const bytes = Buffer.byteLength(JSON.stringify(copy));
    if (bytes <= limit) {
      if (originalBytes > limit) console.warn(`[model-harbor] compacted tool specs from ${originalBytes} to ${bytes} bytes`);
      return copy;
    }
  }
  return specs.map(tool => {
    if (tool?.type === 'namespace') {
      return {
        type: 'namespace',
        name: tool.name,
        description: String(tool.description || '').slice(0, 120),
        tools: (tool.tools || []).map(t => ({
          type: 'function', name: t.name, description: String(t.description || '').slice(0, 120),
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
          ...(t.deferLoading ? { deferLoading: true } : {})
        }))
      };
    }
    return {
      type: 'function', name: tool.name, description: String(tool.description || '').slice(0, 120),
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      ...(tool.deferLoading ? { deferLoading: true } : {})
    };
  });
}

const CORE_TOOL_NAME = /(apply_patch|read_file|write_file|list_dir|list_files|glob|grep|search|run_command|exec_command|exec|write_stdin|shell|terminal|bash|powershell|view_image|edit|view|create_file|delete_file|move_file|todo|plan)/i;
function toolMappingFor(mappings, spec) {
  return mappings?.get(spec.name) || { name: spec.name, type: 'function' };
}
function coreTool(mapping) {
  return mapping.type === 'custom' || mapping.type === 'tool_search' || CORE_TOOL_NAME.test(mapping.name || '');
}
// Deferred tools must live inside a namespace. Keep a small core surface eager,
// then group the long tail into namespaces with deferLoading so their schemas
// do not enter every request.
export function deferToolSpecs(specs, mappings, { mode = 'auto', minTools = 24, minBytes = 48 * 1024, groupSize = 12, maxEager = 10, maxEagerBytes = 64 * 1024, minEager = 4 } = {}) {
  const rawMode = String(mode ?? 'auto').trim().toLowerCase();
  const normalizedMode = ({ '0': 'off', '1': 'always' })[rawMode] || rawMode;
  const options = {
    mode: ['off', 'auto', 'always'].includes(normalizedMode) ? normalizedMode : 'auto',
    minTools: Number.isFinite(minTools) ? Math.max(2, Math.floor(minTools)) : 24,
    minBytes: Number.isFinite(minBytes) ? Math.max(0, Math.floor(minBytes)) : 48 * 1024,
    groupSize: Number.isFinite(groupSize) ? Math.max(1, Math.floor(groupSize)) : 12,
    maxEager: Number.isFinite(maxEager) ? Math.max(1, Math.floor(maxEager)) : 10,
    maxEagerBytes: Number.isFinite(maxEagerBytes) ? Math.max(0, Math.floor(maxEagerBytes)) : 64 * 1024,
    minEager: Number.isFinite(minEager) ? Math.max(0, Math.floor(minEager)) : 4
  };
  const bytes = Buffer.byteLength(JSON.stringify(specs));
  const stats = { mode: options.mode, eager: specs.length, deferred: 0, namespaces: 0, bytes };
  if (options.mode === 'off' || specs.length < 2 || specs.some(s => s.type === 'namespace')) return { specs, stats };
  if (options.mode === 'auto' && specs.length < options.minTools && bytes < options.minBytes) return { specs, stats };
  const entries = specs.map(spec => ({ spec, mapping: toolMappingFor(mappings, spec), bytes: Buffer.byteLength(JSON.stringify(spec)) }));
  const eager = new Set();
  for (const entry of entries) if (coreTool(entry.mapping) && eager.size < options.maxEager) eager.add(entry.spec.name);
  const minimum = Math.min(options.minEager, entries.length);
  // Prefer the smallest non-core tools for the eager floor so large MCP schemas move to the deferred namespace.
  for (const entry of entries.filter(entry => !eager.has(entry.spec.name)).sort((a, b) => a.bytes - b.bytes)) {
    if (eager.size >= minimum) break;
    eager.add(entry.spec.name);
  }
  // The byte budget is soft: it may shrink the eager surface, but never below
  // the configured minimum, otherwise a few large schemas silently push every
  // tool behind tool_search (observed: minEager=6 collapsed to 1 eager).
  let eagerBytes = entries.filter(entry => eager.has(entry.spec.name)).reduce((sum, entry) => sum + entry.bytes, 0);
  const eagerFloor = Math.min(minimum, eager.size);
  while (eagerBytes > options.maxEagerBytes && eager.size > eagerFloor) {
    const candidates = entries.filter(entry => eager.has(entry.spec.name) && !coreTool(entry.mapping)).sort((a, b) => b.bytes - a.bytes);
    if (!candidates.length) break;
    eager.delete(candidates[0].spec.name);
    eagerBytes -= candidates[0].bytes;
  }
  const deferred = entries.filter(entry => !eager.has(entry.spec.name));
  if (!deferred.length) return { specs, stats };
  const active = entries.filter(entry => eager.has(entry.spec.name)).map(entry => entry.spec);
  const used = new Set(active.map(spec => spec.name)), namespaces = [];
  for (let offset = 0, part = 0; offset < deferred.length; offset += options.groupSize) {
    let name;
    do { name = `mh_group_${++part}`; } while (used.has(name));
    used.add(name);
    const chunk = deferred.slice(offset, offset + options.groupSize);
    namespaces.push({
      type: 'namespace',
      name,
      description: `Deferred client tools (${chunk.length}). Their schemas load on demand; call them directly by name.`,
      tools: chunk.map(({ spec }) => ({
        type: 'function', name: spec.name, description: spec.description, inputSchema: spec.inputSchema, deferLoading: true,
        ...(spec.descriptionBase ? { descriptionBase: spec.descriptionBase } : {}),
        ...(spec.formatHint ? { formatHint: spec.formatHint } : {})
      }))
    });
  }
  stats.eager = active.length; stats.deferred = deferred.length; stats.namespaces = namespaces.length;
  return { specs: [...active, ...namespaces], stats };
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
    const description = `Client tool ${key}. ${tool.description || ''}`;
    // The format hint is the call contract, so it is excluded from truncation.
    const formatHint = custom && tool.format ? '\nThe input string MUST follow this format: ' + JSON.stringify(tool.format) : '';
    specs.push({ type: 'function', name, description: description + formatHint, inputSchema, ...(formatHint ? { descriptionBase: description, formatHint } : {}) });
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
// History trimming is a cost trade-off, not a correctness feature. The old
// fixed 16 KiB clip was silent and cut file contents, timestamps and logs that
// multi-step pipelines depend on. Every trim is now configurable and logged.
const DEFAULT_TOOL_CLIP = 512 * 1024;
const DEFAULT_IMAGE_TURNS = 0; // 0 = keep every image in history.
export function envNumber(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
}
export function historyTrimSettings(overrides = {}) {
  return {
    toolClip: overrides.toolClip ?? envNumber('MH_HISTORY_TOOL_CLIP', DEFAULT_TOOL_CLIP),
    imageTurns: overrides.imageTurns ?? envNumber('MH_HISTORY_IMAGE_TURNS', DEFAULT_IMAGE_TURNS),
    keepReasoning: overrides.keepReasoning ?? process.env.MH_HISTORY_KEEP_REASONING === '1'
  };
}
export const emptyTrimStats = () => ({ clipped: 0, omittedChars: 0, omittedImages: 0 });
const clipMiddle = (text, limit, stats) => {
  if (!limit || text.length <= limit) return text;
  const keep = Math.floor(limit / 2), omitted = text.length - keep * 2;
  stats.clipped++; stats.omittedChars += omitted;
  return text.slice(0, keep) + '\n[... ' + omitted + ' chars omitted by model-harbor history trim ...]\n' + text.slice(-keep);
};
const dropImages = (parts, stats) => parts.map(part => {
  if (part.type !== 'input_image') return part;
  stats.omittedImages++;
  return { type: 'input_text', text: '[image omitted by model-harbor history trim]' };
});
const isToolOutput = item => item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output';
export function historyItems(input, overrides = {}, stats = emptyTrimStats()) {
  const settings = historyTrimSettings(overrides);
  stats.clipped ??= 0; stats.omittedChars ??= 0; stats.omittedImages ??= 0;
  stats.toolClip = settings.toolClip; stats.imageTurns = settings.imageTurns;
  const users = []; input.forEach((i, n) => { if (i?.role === 'user' && (!i.type || i.type === 'message')) users.push(n); });
  // Tool outputs are clipped only before the last two user turns; images only
  // when the deployment opts in with MH_HISTORY_IMAGE_TURNS=N.
  const toolCutoff = users.length >= 2 ? users.at(-2) : 0;
  const imageCutoff = settings.imageTurns > 0 && users.length >= settings.imageTurns ? users.at(-settings.imageTurns) : 0;
  return input.flatMap((i, n) => {
    if (i?.type === 'reasoning') return settings.keepReasoning ? [historyItem(i)].filter(Boolean) : [];
    const h = historyItem(i);
    if (!h) return [];
    if (h.type === 'message') return [n < imageCutoff ? { ...h, content: dropImages(h.content, stats) } : h];
    if (isToolOutput(h) && n < toolCutoff) {
      const output = typeof h.output === 'string'
        ? clipMiddle(h.output, settings.toolClip, stats)
        : dropImages(h.output, stats).map(part => part.type === 'input_text' ? { ...part, text: clipMiddle(part.text, settings.toolClip, stats) } : part);
      return [{ ...h, output }];
    }
    return [h];
  });
}
const CONTINUE_AFTER_TOOL = 'The client has returned the tool result above. Continue the current task from that result. Do not repeat tool calls that already completed unless the result shows they failed.';
const continuationInput = () => [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: CONTINUE_AFTER_TOOL }] }];
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
    this.child = child; this.id = 0; this.pending = new Map(); this.events = []; this.waiter = null; this.closed = false; this.stderr = ''; this.lastError = null;
    const decoder = new StringDecoder('utf8'); let buffer = '';
    child.stdin.on('error', () => {}); child.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes.toString()).slice(-4096); });
    child.stdout.on('data', bytes => {
      buffer += decoder.write(bytes);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        if (index > RPC_MESSAGE_LIMIT) return this.fail(rpcTooLarge());
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch { this.fail(failed('app-server returned non-JSON output: ' + line)); return; }
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
    child.on('error', e => this.fail(failed('app-server process error: ' + e.message))); child.on('close', (code, signal) => this.fail(failed(`app-server exited (${code ?? signal ?? 'unknown'})${this.stderr ? ': ' + this.stderr : ''}`)));
  }
  send(value) { if (this.closed) throw this.lastError || failed(); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  call(method, params) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); try { this.send({ id, method, params }); } catch (e) { this.pending.delete(id); reject(e); } }); }
  next() { if (this.closed) return Promise.reject(this.lastError || failed()); if (this.events.length) return Promise.resolve(this.events.shift()); return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; }); }
  fail(error) {
    if (this.closed) return; this.closed = true; this.lastError = error;
    for (const p of this.pending.values()) p.reject(error); this.pending.clear();
    this.waiter?.reject(error); this.waiter = null; this.events = [];
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
  }
  close() { this.fail(failed()); }
}

export class NasAgentBridge {
  constructor({
    launch = (p) => { const c = agentCommand(p); return spawn(c.command, c.args, { windowsHide: true }); },
    idleMs = 10 * 60 * 1000,
    toolWaitMs = Number(process.env.MH_TOOL_WAIT_SECONDS || 1800) * 1000,
    maxSessions = 8,
    deferTools = process.env.MH_DEFER_TOOLS || 'auto',
    deferMinTools = Number(process.env.MH_DEFER_MIN_TOOLS || 24),
    deferMinBytes = Number(process.env.MH_DEFER_MIN_BYTES || 48 * 1024),
    deferGroupSize = Number(process.env.MH_DEFER_GROUP_SIZE || 12),
    deferMaxEager = Number(process.env.MH_DEFER_MAX_EAGER || 10),
    deferMaxEagerBytes = Number(process.env.MH_DEFER_MAX_EAGER_BYTES || 64 * 1024),
    deferMinEager = Number(process.env.MH_DEFER_MIN_EAGER || 4)
  } = {}) {
    this.launch = launch; this.idleMs = idleMs; this.maxSessions = maxSessions; this.sessions = new Set(); this.calls = new Map(); this.completedCalls = new Map();
    this.toolWaitMs = Number.isFinite(toolWaitMs) && toolWaitMs > 0 ? Math.max(idleMs, toolWaitMs) : Math.max(idleMs, 30 * 60 * 1000);
    this.deferTools = deferTools; this.deferMinTools = deferMinTools; this.deferMinBytes = deferMinBytes;
    this.deferGroupSize = deferGroupSize; this.deferMaxEager = deferMaxEager; this.deferMaxEagerBytes = deferMaxEagerBytes; this.deferMinEager = deferMinEager;
    this.capabilities = new Map(); this.usageReaders = new Set(); this.usageCache = new Map(); this.usageGeneration = 0;
  }
  dispose(s) { clearTimeout(s.idle); s.rpc.close(); this.sessions.delete(s); for (const [id, value] of this.calls) if (value === s) this.calls.delete(id); }
  close() { for (const s of [...this.sessions]) this.dispose(s); for (const rpc of this.usageReaders) rpc.close(); this.completedCalls.clear(); this.usageCache.clear(); }
  async models(p, signal, { probe = false } = {}) {
    if (p.type !== 'nas-codex') throw new HttpError(400, '仅 Codex 供应商支持模型发现');
    if (signal?.aborted) throw new HttpError(499, '请求已取消');
    if (this.usageReaders.size >= 4) throw new HttpError(429, '远程 Codex 检索引擎繁忙，请稍后重试');
    const rpc = new RPC(this.launch(p)); this.usageReaders.add(rpc);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; rpc.close(); }, 25000);
    const abort = () => rpc.close(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const initialized = await rpc.call('initialize', { clientInfo: { name: 'model_harbor', version: '0.1.0' }, capabilities: { experimentalApi: true } });
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
      const capability = { provider: p.id, cli: 'Codex', version: String(initialized?.userAgent || '').match(/\d+\.\d+\.\d+(?:[-.\w]*)?/)?.[0] || null, modelList: 'verified', historyInjection: this.capabilities.get(p.id)?.historyInjection || 'unknown', checkedAt: new Date().toISOString() };
      if (probe) {
        try {
          const thread = await rpc.call('thread/start', { model: ids[0], cwd: '/tmp', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', dynamicTools: [], config: { 'features.shell_tool': false, 'features.apply_patch_freeform': false, 'features.apps': false, 'features.plugins': false, 'features.image_generation': false, 'features.multi_agent': false, web_search: 'disabled', mcp_servers: {} } });
          await rpc.call('thread/inject_items', { threadId: thread.thread.id, items: historyItems([{ role: 'user', content: 'Model Harbor compatibility probe. No inference is requested.' }]) });
          capability.historyInjection = 'verified';
        } catch (e) { capability.historyInjection = e.code === 'codex_app_server_unsupported' ? 'unsupported' : 'failed'; }
      }
      this.capabilities.set(p.id, capability);
      return [...new Set(ids)];
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(signal?.aborted ? 499 : timedOut ? 504 : 502,
        signal?.aborted ? '请求已取消' : timedOut ? 'Codex 模型发现超时，请稍后重试' : '无法读取 Codex 模型列表，请检查目标环境的登录状态、网络和 CLI 版本',
        'codex_models_failed');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); rpc.close(); this.usageReaders.delete(rpc); }
  }
  async usage(p, signal, force = false) {
    if (p.type !== 'nas-codex') throw new HttpError(400, '仅 Codex 供应商支持账号用量查询');
    if (signal?.aborted) throw new HttpError(499, '请求已取消');
    const signature = JSON.stringify(p), cached = this.usageCache.get(p.id), generation = this.usageGeneration;
    if (!force && cached?.signature === signature && Date.now() - cached.at < 30000) return structuredClone(cached.value);
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
  async run(p, model, rawBody, endpoint, signal, onEvent, options = {}) {
    const body = agentInput(rawBody, endpoint), { input, outputs, budget } = validateAgent(body), { specs, mappings, webSearch } = toolSpecs(body.tools, body.tool_choice);
    // Tool schemas legitimately change between rounds (tool_search returns
    // deferred definitions), but the native thread is still valid. Rebuild only
    // when the tool name set changes; otherwise every tool search would discard
    // the session and re-inject trimmed history.
    const toolNames = specs.map(spec => spec.type === 'namespace'
      ? spec.name + '[' + (spec.tools || []).map(tool => tool.name).sort().join(',') + ']'
      : spec.name).sort().join('|');
    const signature = JSON.stringify([p, model, webSearch, toolNames]);
    for (const output of outputs.slice(-1)) {
      const previous = this.completedCalls.get(output.call_id);
      if (input.filter(i => i.type !== 'reasoning').at(-1) === output && previous && previous.signature === signature && previous.output === JSON.stringify(output) && Date.now() - previous.at < this.idleMs) return structuredClone(previous.response);
    }
    const lastItem = input.filter(i => i.type !== 'reasoning').at(-1);
    const matches = outputs.filter(o => this.calls.has(o.call_id));
    let s = matches.length ? this.calls.get(matches.at(-1).call_id) : null;
    if (s && (s.signature !== signature || s.rpc.closed)) {
      // The native process can disappear between a client tool call and its
      // result (idle cleanup, outer timeout, crash, or a changed tool catalog).
      // Rebuild the transcript below instead of rejecting the continuation.
      if (s.rpc.closed) console.warn('[model-harbor] app-server session ended before its tool result returned; reconstructing history');
      this.dispose(s); s = null;
    }
    if (s?.busy) throw new HttpError(409, '同一工具结果正在处理中，请勿重复提交');
    if (!s) {
      if (this.sessions.size >= this.maxSessions) throw new HttpError(429, '远程工具会话已满，请稍后重试');
      s = { rpc: new RPC(this.launch(p)), signature, mappings, busy: false, reconstructed: isToolOutput(lastItem) };
      this.sessions.add(s);
    } else s.mappings = mappings;
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
    let context = '';
    try {
      if (signal?.aborted) throw new HttpError(408, '请求已取消');
      let streamedText = false, turnParams = null, capacityRetries = 0;
      const sharedBudget = options.retryBudget || retryBudget();
      const maxCapacityRetries = sharedBudget.remaining;
      const capacityBackoffMs = envNumber('MH_CAPACITY_BACKOFF_MS', 2000);
      const retryTurn = async (detail, label) => {
        if (streamedText || !turnParams || capacityRetries >= maxCapacityRetries) return false;
        capacityRetries++;
        const delay = capacityBackoffMs * capacityRetries;
        console.warn(`[model-harbor] ${label}; retry ${capacityRetries}/${maxCapacityRetries} in ${delay}ms: ${rpcDetail(detail)}`);
        if (!await retryDelay(sharedBudget, capacityBackoffMs, signal)) return false;
        sharedBudget.attempts++;
        await s.rpc.call('turn/start', turnParams);
        return true;
      };
      const response = budgetResponse(responseBase(rawBody.model), budget); response.tools = body.tools || []; response.tool_choice = body.tool_choice || 'auto'; response.parallel_tool_calls = false;
      if (s.reconstructed) response.metadata = { ...(response.metadata || {}), model_harbor_session: 'reconstructed_after_tool_result' };
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
        const instructions = 'You are the reasoning engine for an external coding client. Use only the supplied dynamic client_* tools; all filesystem, shell and patch operations must be requested through them and are executed by the client. Never use server-side tools, skills, MCP, shell or filesystem. The remote read-only sandbox does not forbid REQUESTING a client_* tool; the client enforces its own permissions. If the user names a tool such as apply_patch, call its client_* counterpart. Do not claim a client operation failed before receiving its result. Paths belong to the CLIENT workspace, never the remote cwd /tmp; keep them as given. Follow the history role hierarchy and continue the last user task. Custom tools take their exact raw text in the input field. Tool names are mapped in their descriptions.\n' + (body.instructions || '') + '\nTool choice: ' + JSON.stringify(body.tool_choice || 'auto');
        const budgetHint = budget === undefined ? '' : `\nThe client requests an output budget of ${Math.ceil(budget / 4096) * 4096} tokens for each model response, including reasoning and tool arguments. Aim to stay within this budget; be concise. This is a generation hint, not a server-enforced hard token cap. Do not truncate tool inputs or output malformed arguments to fit it.`;
        const baseInstructions = instructions + searchInstructions + (webSearch.unsupportedContentTypes ? '\nNative image search is unavailable on this upstream. The client may advertise image alongside text search by default; that does not require an image search for ordinary chat. For actual image search, use an appropriate supplied client tool if available; otherwise explain the limitation. Never claim to have searched images using the native text search tool.' : '') + budgetHint;
        const maxToolBytes = 1000 * 1024 - Buffer.byteLength(baseInstructions) - 32 * 1024;
        const deferred = deferToolSpecs(specs, mappings, {
          mode: this.deferTools, minTools: this.deferMinTools, minBytes: this.deferMinBytes,
          groupSize: this.deferGroupSize, maxEager: this.deferMaxEager, maxEagerBytes: this.deferMaxEagerBytes, minEager: this.deferMinEager
        });
        const dynamicTools = fitToolSpecs(deferred.specs, maxToolBytes);
        const threadParams = { model, cwd: '/tmp', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions, dynamicTools,
          config: { 'features.shell_tool': false, 'features.apply_patch_freeform': false, 'features.multi_agent': false, 'features.image_generation': false, 'features.apps': false, 'features.plugins': false, web_search: webSearch.mode, 'tools.web_search': webSearch.mode === 'disabled' ? false : webSearch.options || {}, mcp_servers: {} } };
        let thread;
        try {
          thread = await s.rpc.call('thread/start', threadParams);
        } catch (e) {
          if (!deferred.stats.deferred || !/defer|namespace|unknown (field|variant)/i.test(`${e.rpcDetail || ''} ${e.message || ''}`)) throw e;
          console.warn('[model-harbor] app-server rejected deferred tools; retrying with eager tool specs');
          thread = await s.rpc.call('thread/start', { ...threadParams, dynamicTools: fitToolSpecs(specs, maxToolBytes) });
        }
        s.threadId = thread.thread.id;
        const trimStats = {};
        const history = historyItems(s.reconstructed ? input : input.slice(0, -1), {}, trimStats);
        const current = currentTurnInput(s.reconstructed ? continuationInput() : input);
        if (trimStats.clipped || trimStats.omittedImages) console.log(`[model-harbor] history trimmed: ${trimStats.clipped} tool output(s), ${trimStats.omittedChars} chars omitted, ${trimStats.omittedImages} image(s) dropped (clip=${trimStats.toolClip}, imageTurns=${trimStats.imageTurns})`);
        console.log(`[model-harbor] request model=${model} tools=${specs.length} eager=${deferred.stats.eager} deferred=${deferred.stats.deferred} history=${history.length} trimmed=${trimStats.clipped}/${trimStats.omittedChars}/${trimStats.omittedImages}${s.reconstructed ? ' reconstructed=true' : ''}`);
        context = `tools=${specs.length}, toolBytes=${Buffer.byteLength(JSON.stringify(specs))}, eager=${deferred.stats.eager}, deferred=${deferred.stats.deferred}, namespaces=${deferred.stats.namespaces}, history=${history.length}, trimmed=${trimStats.clipped}/${trimStats.omittedChars}/${trimStats.omittedImages}${s.reconstructed ? ', reconstructed=true' : ''}`;
        if (s.reconstructed) console.warn('[model-harbor] reconstructing native history: tool result arrived without a live app-server session');
        if (deferred.stats.deferred) console.log(`[model-harbor] deferLoading: ${deferred.stats.eager} eager, ${deferred.stats.deferred} deferred in ${deferred.stats.namespaces} namespaces`);
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
            s.legacyTranscript = s.reconstructed ? [...transcript, ...continuationInput()] : transcript;
          }
        }
        const turnInput = s.legacyTranscript ? [{ type: 'text', text: JSON.stringify(s.legacyTranscript) }, ...current.filter(item => item.type === 'image')] : current;
        turnParams = { threadId: s.threadId, input: turnInput, ...(body.reasoning?.effort || body.reasoning_effort ? { effort: body.reasoning?.effort || body.reasoning_effort } : {}) };
        await s.rpc.call('turn/start', turnParams);
      }
      while (true) {
        const event = await s.rpc.next(), params = event.params || {};
        if (event.method === 'item/started' && params.item?.type === 'webSearch') {
          streamedText = true; if (onEvent) await onEvent({ type: 'irreversible' });
        } else if (event.method === 'item/started' && params.item?.type === 'agentMessage') {
          if (onEvent) await onEvent({ type: 'message_started', item: params.item });
        } else if (event.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          if (params.delta) streamedText = true;
          if (onEvent) await onEvent({ type: 'text_delta', itemId: params.itemId, delta: params.delta });
        } else if (event.method === 'item/completed' && params.item?.type === 'agentMessage') {
          const text = params.item.text;
          if (text) streamedText = true;
          const item = text ? { id: params.item.id || uid('msg_'), type: 'message', role: 'assistant', status: 'completed', ...(params.item.phase ? { phase: params.item.phase } : {}), content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] } : null;
          if (item) response.output.push(item);
          if (onEvent) await onEvent({ type: 'message_done', item });
        } else if (event.method === 'item/completed' && params.item?.type === 'webSearch') {
          if (webSearch.mode === 'disabled') throw failed();
          streamedText = true; // A native search must never be replayed by capacity retry.
          const item = searchItem(params.item); response.output.push(item);
          if (onEvent) await onEvent({ type: 'search_done', item });
        } else if (event.method === 'item/tool/call' && event.id !== undefined) {
          const callName = String(params.tool || ''), shortName = callName.includes('.') ? callName.slice(callName.lastIndexOf('.') + 1) : callName;
          const tool = s.mappings.get(callName) || s.mappings.get(shortName);
          if (!tool) {
            console.error('[model-harbor] unknown tool call:', callName.slice(0, 120), 'namespace:', String(params.namespace || '').slice(0, 120), 'registered:', [...s.mappings.keys()].slice(0, 20).join(','));
            throw failed('app-server requested an unregistered tool: ' + String(params.tool || '').slice(0, 120));
          }
          const item = { id: uid(tool.type === 'custom' ? 'ctc_' : 'fc_'), type: tool.type === 'tool_search' ? 'tool_search_call' : tool.type === 'custom' ? 'custom_tool_call' : 'function_call', status: 'completed', call_id: params.callId, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) };
          if (tool.type === 'tool_search') { delete item.name; item.execution = 'client'; item.arguments = params.arguments; }
          else if (tool.type === 'custom') { if (typeof params.arguments?.input !== 'string') throw failed(); item.input = params.arguments.input; }
          else item.arguments = JSON.stringify(params.arguments);
          response.output.push(item); response.status = 'completed';
          s.waiting = { id: event.id, callId: params.callId }; this.calls.set(params.callId, s);
          s.idle = setTimeout(() => this.dispose(s), this.toolWaitMs); s.idle.unref(); return finish(response);
        } else if (event.method === 'turn/completed' || event.method === 'turn/failed') {
          const status = params.turn?.status || (event.method === 'turn/failed' ? 'failed' : '');
          if (status !== 'completed') {
            const detail = String(params.turn?.error?.message || params.error?.message || '').slice(0, 400);
            if (isCapacityDetail(detail) && await retryTurn(detail, 'upstream model at capacity')) continue;
            if (/context window|contextWindow|too many tokens|token limit/i.test(detail)) throw new HttpError(413, '远程 Codex 上下文已超出模型窗口；请压缩历史或减少附件', 'remote_context_window_exceeded');
            throw new HttpError(502, detail ? '远程 Codex 回合失败：' + detail : '远程 Codex 回合失败，请检查登录、模型权限和 CLI 日志', 'codex_turn_failed');
          }
          if ((body.tool_choice === 'required' || (body.tool_choice && typeof body.tool_choice === 'object')) && !response.output.some(i => i.type === 'web_search_call')) throw new HttpError(502, '远程模型未按 tool_choice 调用工具');
          response.status = 'completed'; this.dispose(s); return finish(response);
        } else if (event.method === 'thread/tokenUsage/updated') {
          const u = params.tokenUsage?.last;
          if (u) response.usage = { input_tokens: u.inputTokens || 0, output_tokens: u.outputTokens || 0, total_tokens: u.totalTokens || 0, input_tokens_details: { cached_tokens: u.cachedInputTokens || 0 }, output_tokens_details: { reasoning_tokens: u.reasoningOutputTokens || 0 } };
        } else if (event.method === 'error' && !params.willRetry) {
          const detail = String(params.message || params.error?.message || JSON.stringify(params || {})).slice(0, 500);
          console.error('[model-harbor] app-server error event:', rpcDetail(detail));
          if (isCapacityDetail(detail) && await retryTurn(detail, 'upstream model at capacity')) continue;
          throw failed(detail);
        } else if (event.id !== undefined && event.method) {
          // Unexpected approval/local tool requests are refused, never auto-approved.
          console.error('[model-harbor] unexpected app-server request:', String(event.method).slice(0, 120));
          s.rpc.send({ id: event.id, error: { code: -32601, message: 'Only client dynamic tools are supported' } });
          throw failed('unexpected app-server request: ' + String(event.method).slice(0, 120));
        }
      }
    } catch (e) {
      e.capacityRetryHandled = true;
      this.dispose(s);
      if (e instanceof HttpError && e.message === '远程 Codex 工具桥接失败，请检查登录、模型权限和 app-server 版本' && context) e.message += `（${context}）`;
      throw e;
    }
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

export async function sendAgent(bridge, p, model, body, endpoint, res, signal, options = {}) {
  if (!body.stream) {
    const response = await bridge.run(p, model, body, endpoint, signal, undefined, options);
    completeMetrics(res, response); if (response.output?.length) markOutput(res);
    return endpoint === 'responses' ? response : agentChat(response);
  }
  const normalized = agentInput(body, endpoint); validateAgent(normalized); toolSpecs(normalized.tools, normalized.tool_choice);
  res.apiRetrySafe = true;
  // A single public stream survives pre-output account failover. Headers,
  // response.created and keepalives do not commit the selected account.
  if (!res.agentStream) {
    openSSE(res);
    res.agentStream = { seq: 0, initial: budgetResponse(responseBase(body.model), outputBudget(normalized)) };
    if (endpoint === 'responses') {
      for (const type of ['response.created', 'response.in_progress']) await writeSSE(res, { type, sequence_number: res.agentStream.seq++, response: res.agentStream.initial }, type);
    }
  }
  const stream = res.agentStream, initial = stream.initial;
  const emit = (type, fields) => writeSSE(res, { type, sequence_number: stream.seq++, ...fields }, type);
  const chatBase = { id: initial.id, object: 'chat.completion.chunk', created: initial.created_at, model: body.model };
  const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded && res.writableLength < 65536) res.write(': keepalive\n\n'); }, 15000); heartbeat.unref();
  const live = new Map(), emitted = new Set();
  const ensureMessage = async item => {
    let state = live.get(item.id);
    if (!state) {
      state = { index: live.size, text: '', message: { id: item.id, type: 'message', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: '', annotations: [], logprobs: [] }] } };
      live.set(item.id, state);
      if (endpoint === 'responses') {
        await emit('response.output_item.added', { output_index: state.index, item: structuredClone(state.message) });
        await emit('response.content_part.added', { item_id: item.id, output_index: state.index, content_index: 0, part: { ...state.message.content[0], text: '' } });
      }
    }
    return state;
  };
  const onEvent = async event => {
    if (event.type === 'irreversible') { res.apiOutputStarted = true; return; }
    if (event.type === 'message_started') return; // Empty item is not committed output.
    if (event.type === 'text_delta' && event.delta) {
      markOutput(res);
      const state = await ensureMessage({ id: event.itemId });
      state.text += event.delta; state.message.content[0].text = state.text;
      if (endpoint === 'responses') await emit('response.output_text.delta', { item_id: event.itemId, output_index: state.index, content_index: 0, delta: event.delta, logprobs: [] });
      else await writeSSE(res, { ...chatBase, choices: [{ index: 0, delta: { role: 'assistant', content: event.delta }, finish_reason: null }] });
    } else if (event.type === 'message_done' && event.item) {
      markOutput(res);
      const state = await ensureMessage(event.item), text = event.item.content?.[0]?.text ?? state.text;
      // Some CLI versions emit only item/completed, without text deltas.
      if (!state.text && text) {
        if (endpoint === 'responses') await emit('response.output_text.delta', { item_id: event.item.id, output_index: state.index, content_index: 0, delta: text, logprobs: [] });
        else await writeSSE(res, { ...chatBase, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
      }
      state.text = text; state.message = event.item; emitted.add(event.item.id);
      if (endpoint === 'responses') {
        const meta = { output_index: state.index, item_id: event.item.id, content_index: 0 };
        await emit('response.output_text.done', { ...meta, text, logprobs: [] });
        await emit('response.content_part.done', { ...meta, part: event.item.content[0] });
        await emit('response.output_item.done', { output_index: state.index, item: event.item });
      }
    } else if (event.type === 'search_done') {
      markOutput(res);
      const index = live.size; live.set(event.item.id, { index }); emitted.add(event.item.id);
      if (endpoint === 'responses') {
        await emit('response.output_item.added', { output_index: index, item: { ...event.item, status: 'in_progress' } });
        for (const status of ['in_progress', 'searching', 'completed']) await emit('response.web_search_call.' + status, { output_index: index, item_id: event.item.id });
        await emit('response.output_item.done', { output_index: index, item: event.item });
      }
    }
  };
  let response;
  try { response = await bridge.run(p, model, body, endpoint, signal, onEvent, options); }
  finally { clearInterval(heartbeat); }
  completeMetrics(res, response); response.id = initial.id;
  if (endpoint === 'responses') {
    for (const item of response.output) {
      if (emitted.has(item.id)) continue;
      if (item.type === 'message') { await onEvent({ type: 'message_done', item }); continue; }
      if (item.type === 'web_search_call') { await onEvent({ type: 'search_done', item }); continue; }
      markOutput(res);
      const index = live.size; live.set(item.id, { index });
      const meta = { output_index: index, item_id: item.id }, custom = item.type === 'custom_tool_call', field = custom ? 'input' : 'arguments';
      await emit('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', ...(item.type === 'tool_search_call' ? {} : { [field]: '' }) } });
      if (item.type !== 'tool_search_call') {
        const stem = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments';
        await emit(stem + '.delta', { ...meta, delta: item[field] });
        await emit(stem + '.done', { ...meta, [field]: item[field], name: item.name });
      }
      await emit('response.output_item.done', { output_index: index, item });
    }
    await emit('response.completed', { response });
  } else {
    for (const item of response.output) if (item.type === 'message' && !emitted.has(item.id)) await onEvent({ type: 'message_done', item });
    const chat = agentChat(response), { message, finish_reason } = chat.choices[0];
    if (message.tool_calls) { markOutput(res); await writeSSE(res, { ...chatBase, choices: [{ index: 0, delta: { tool_calls: message.tool_calls.map((t, index) => ({ ...t, index })) }, finish_reason: null }] }); }
    await writeSSE(res, { ...chatBase, choices: [{ index: 0, delta: {}, finish_reason }] });
    if (chat.usage) await writeSSE(res, { ...chatBase, choices: [], usage: chat.usage });
    await writeSSE(res, '[DONE]');
  }
  res.end(); return null;
}
