// Adapt client custom/namespace tools to Chat function calls, then restore the
// original Responses contract. Grammar is a model instruction, not enforced by Chat.
import crypto from 'node:crypto';
import { HttpError } from './store.js';
const fail = message => { throw new HttpError(400, message, 'unsupported_parameter'); };
const key = t => `${t.namespace || ''}/${t.name}`;
export function chatToolPlan(body) {
  const unsupported = [];
  const hosted = new Set(['web_search', 'web_search_preview', 'web_search_preview_2025_03_11', 'image_generation', 'file_search', 'code_interpreter', 'mcp']);
  const mappings = new Map(), byKey = new Map(), definitions = [];
  const register = (t, namespace, define = true) => {
    if (t?.type === 'function' && t.function) t = { ...t.function, type: 'function' };
    if (!t || !['function', 'custom', 'tool_search'].includes(t.type) || typeof t.name !== 'string' || !t.name || t.name.length > 256 || /[\s\x00-\x1f\x7f]/.test(t.name)) fail('Chat 工具名称或类型无效：type=' + String(t?.type).slice(0, 60));
    const info = { ...t, namespace: namespace || t.namespace };
    const k = key(info);
    let alias = byKey.get(k);
    if (!alias) {
      alias = !info.namespace && /^[A-Za-z0-9_-]{1,64}$/.test(info.name) && !info.name.startsWith('mh_') ? info.name : 'mh_' + crypto.createHash('sha256').update(k).digest('hex').slice(0, 40);
      byKey.set(k, alias); mappings.set(alias, info);
    }
    if (define) {
      if (definitions.some(d => d.function.name === alias)) fail('Chat 工具名称重复');
      const custom = t.type === 'custom';
      const description = `${info.namespace ? info.namespace + '.' : ''}${t.name}: ${t.description || ''}` +
        (custom ? '\nReturn the exact raw tool input in the input string, preserving newlines.' + (t.format ? '\nThe raw input MUST follow: ' + JSON.stringify(t.format) : '') : '');
      definitions.push({ type: 'function', function: { name: alias, description,
        parameters: custom ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false } : t.parameters || { type: 'object', properties: {} } } });
    }
    return alias;
  };
  const add = (t, namespace) => {
    if (!t || typeof t !== 'object') fail('Chat 工具声明必须是对象');
    if (hosted.has(t.type)) {
      if (body.tool_choice?.type === t.type) fail('Chat 上游不支持强制使用服务端工具 ' + t.type);
      unsupported.push(t.type); return;
    }
    if (t.type === 'namespace') {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(t.name || '') || !Array.isArray(t.tools)) fail('Chat namespace 工具无效');
      for (const child of t.tools) add(child, t.name);
    } else if (t.type === 'tool_search') {
      if (t.execution === 'client') register({ ...t, name: 'tool_search' }, namespace);
    } else if (t.type === 'programmatic_tool_calling' && t.enabled === false) { /* control flag */ }
    else register(t, namespace);
  };
  const catalog = [...(body.tools || [])];
  const input = Array.isArray(body.input) ? body.input : [];
  // Re-register tools discovered in a previous turn when the client only sends
  // a tool-search declaration on subsequent requests.
  for (const i of input) if (i.type === 'tool_search_output' && Array.isArray(i.tools)) {
    for (const t of i.tools) if (!catalog.some(x => x.type === t.type && x.name === t.name)) catalog.push(t);
  }
  for (const t of catalog) add(t);
  const historyName = item => {
    if (item.type === 'tool_search_call' && !item.name) item = { ...item, name: 'tool_search' };
    const k = key(item);
    return byKey.get(k) || register({ name: item.name, namespace: item.namespace,
      type: item.type === 'custom_tool_call' ? 'custom' : item.type === 'tool_search_call' ? 'tool_search' : 'function' }, undefined, false);
  };
  let choice = body.tool_choice;
  if (choice && typeof choice === 'object') {
    const alias = byKey.get(key(choice));
    if (!alias || !definitions.some(d => d.function.name === alias)) fail('tool_choice 指定的工具不存在');
    choice = { type: 'function', function: { name: alias } };
  }
  if (choice === 'required' && !definitions.length) fail('Chat tool_choice=required 需要可调用的客户端工具');
  return { definitions, mappings, historyName, choice, unsupported: [...new Set(unsupported)] };
}

export function restoreChatTool(item, plan) {
  const t = plan?.mappings.get(item.name);
  if (!t) return item;
  const base = { ...item, name: t.name, ...(t.namespace ? { namespace: t.namespace } : {}) };
  if (t.type === 'custom') {
    let args;
    try { args = JSON.parse(item.arguments); } catch { throw new HttpError(502, 'Chat 上游返回了无效的自定义工具输入'); }
    if (typeof args?.input !== 'string' || Object.keys(args).length !== 1) throw new HttpError(502, 'Chat 上游自定义工具输入必须只有 input 字符串');
    delete base.arguments;
    return { ...base, type: 'custom_tool_call', input: args.input };
  }
  if (t.type === 'tool_search') {
    let args;
    try { args = JSON.parse(item.arguments); } catch { throw new HttpError(502, 'Chat 上游工具搜索参数无效'); }
    delete base.arguments;
    return { ...base, type: 'tool_search_call', execution: 'client', arguments: args };
  }
  return base;
}
