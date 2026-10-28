// Adapt Responses-native upstreams that reject custom tools or namespaces.
// Client custom tools are exposed as a single-string function argument, then
// restored to custom_tool_call on the way back. The client-side tool contract
// remains unchanged.
import crypto from 'node:crypto';
import { HttpError } from './store.js';
import { normalizeObjectParameters } from './tool-schema.js';

const fail = () => { throw new HttpError(502, '上游返回了无效的自定义工具参数'); };
const toolKey = t => `${t.namespace || ''}/${t.name}`;
const aliasFor = (t, namespace) => {
  const key = `${namespace || ''}/${t.name}`;
  if (!namespace && /^[A-Za-z0-9_-]{1,64}$/.test(t.name) && !t.name.startsWith('mh_')) return t.name;
  return 'mh_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);
};
function parseCustom(value) {
  let args;
  try { args = JSON.parse(value); } catch { fail(); }
  if (!args || typeof args.input !== 'string' || Object.keys(args).length !== 1) fail();
  return args.input;
}

export function responsesToolPlan(body, { dropHosted = false } = {}) {
  const byAlias = new Map(), byKey = new Map();
  const originalTools = Array.isArray(body.tools) ? body.tools : [];
  const tools = [];
  const droppedHosted = new Set(), droppedArguments = new Set();
  let transformed = false;
  const register = (t, namespace) => {
    const flattened = t?.type === 'function' && t.function;
    if (flattened) t = { ...t.function, type: 'function' };
    if (!t || !['function', 'custom', 'tool_search'].includes(t.type) || typeof t.name !== 'string' || !t.name || t.name.length > 256 || /[\s\x00-\x1f\x7f]/.test(t.name)) {
      throw new HttpError(400, '工具名称或类型无效', 'unsupported_parameter');
    }
    const info = { ...t, namespace: namespace || t.namespace };
    const key = toolKey(info);
    const alias = byKey.get(key) || aliasFor(info, info.namespace);
    byKey.set(key, alias);
    if (byAlias.has(alias) && toolKey(byAlias.get(alias)) !== key) throw new HttpError(400, '工具短名冲突', 'unsupported_parameter');
    byAlias.set(alias, info);
    const custom = t.type === 'custom' || t.type === 'tool_search';
    if (custom || flattened || alias !== t.name || namespace) transformed = true;
    const description = `${info.namespace ? info.namespace + '.' : ''}${t.name}: ${t.description || ''}` +
      (t.type === 'custom' ? '\nReturn the exact raw tool input in the input string, preserving newlines.' + (t.format ? '\nThe raw input MUST follow: ' + JSON.stringify(t.format) : '') : '');
    const originalParameters = t.type === 'custom'
      ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false }
      : t.parameters || { type: 'object', properties: {} };
    const parameters = normalizeObjectParameters(originalParameters);
    if (parameters !== originalParameters) transformed = true;
    tools.push({ type: 'function', name: alias, description, parameters, strict: false });
  };
  const add = (t, namespace) => {
    if (!t || typeof t !== 'object') throw new HttpError(400, '工具声明无效', 'unsupported_parameter');
    if (t.type === 'namespace') {
      if (!Array.isArray(t.tools)) throw new HttpError(400, '工具命名空间无效', 'unsupported_parameter');
      transformed = true;
      for (const child of t.tools) add(child, t.name);
    } else if (t.type === 'programmatic_tool_calling') {
      // A control flag rather than a callable tool. Grok rejects the
      // declaration itself, so omit it and rebuild the tools array.
      transformed = true;
    }
    else if (t.type === 'tool_search') {
      // tool_search is a client-side discovery tool only when it carries an
      // execution mode. Server-side search is a hosted capability.
      if (t.execution === 'client') register({ ...t, name: t.name || 'tool_search' }, namespace);
      else if (dropHosted) { droppedHosted.add('tool_search'); transformed = true; }
      else tools.push(t);
    } else if (['function', 'custom'].includes(t.type)) register(t, namespace);
    else if (dropHosted && ['web_search_preview', 'web_search_preview_2025_03_11'].includes(t.type)) {
      droppedHosted.add(t.type); transformed = true;
    } else if (dropHosted && t.type === 'web_search') {
      // Grok supports hosted web_search but rejects these two options.
      // Preserve filters/location/content-type preferences it does accept.
      const { external_web_access, search_context_size, ...supported } = t;
      if (external_web_access !== undefined) droppedArguments.add('external_web_access');
      if (search_context_size !== undefined) droppedArguments.add('search_context_size');
      if (external_web_access !== undefined || search_context_size !== undefined) transformed = true;
      tools.push(supported);
    } else tools.push(t); // keep supported hosted/native declarations untouched
  };
  for (const tool of originalTools) add(tool);
  const input = Array.isArray(body.input) ? body.input.map(item => {
    if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(item.type)) {
      const info = byKey.get(toolKey(item));
      const alias = info || (item.type === 'custom_tool_call' ? aliasFor({ name: item.name }, item.namespace) : item.name);
      transformed = true;
      return {
        ...item,
        type: 'function_call',
        name: alias,
        arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
        ...(item.namespace ? { namespace: undefined } : {})
      };
    }
    if (['custom_tool_call_output', 'tool_search_output'].includes(item.type)) {
      transformed = true;
      return { ...item, type: 'function_call_output', output: item.type === 'tool_search_output' ? JSON.stringify({ tools: item.tools || [] }) : item.output };
    }
    return item;
  }) : body.input;
  let choice = body.tool_choice;
  if (choice && typeof choice === 'object' && ['function', 'custom', 'tool_search'].includes(choice.type)) {
    const alias = byKey.get(toolKey(choice));
    if (!alias) throw new HttpError(400, 'tool_choice 指定的工具不存在', 'unsupported_parameter');
    choice = { type: 'function', name: alias };
    transformed = true;
  }
  if (choice && typeof choice === 'object' && droppedHosted.has(choice.type)) {
    throw new HttpError(400, `Grok 不支持强制使用服务端工具 ${choice.type}`, 'unsupported_parameter');
  }
  let request = transformed ? { ...body, tools, input, ...(choice !== undefined ? { tool_choice: choice } : {}) } : body;
  if (droppedHosted.size) {
    const note = 'This upstream cannot execute these hosted tools: ' + [...droppedHosted].join(', ') + '. Do not claim to have used them. Use available client tools if appropriate, or explain the limitation.';
    request = { ...request, instructions: [request.instructions, note].filter(Boolean).join('\n\n') };
  }
  return { request, byAlias, originalTools, transformed, droppedHosted: [...droppedHosted], droppedArguments: [...droppedArguments] };
}

// cli-chat-proxy (Grok subscription) rejects client-only item types, metadata
// and previous_response_id. Custom tools are rewritten by responsesToolPlan.
export function grokResponsesPlan(body) {
  const plan = responsesToolPlan(body, { dropHosted: true });
  let request = plan.request;
  let pruned = false;
  if (Array.isArray(request.input)) {
    const input = request.input.filter(item => {
      if (item && typeof item === 'object' && item.type !== 'item_reference') return true;
      pruned = true;
      return false;
    });
    if (pruned) request = { ...request, input };
  }
  if (request.metadata !== undefined) { const { metadata, ...rest } = request; request = rest; }
  if (request.previous_response_id !== undefined) { const { previous_response_id, ...rest } = request; request = rest; }
  return { ...plan, request, transformed: plan.transformed || pruned };
}

export function restoreResponsesItem(item, plan) {
  if (!item || !['function_call', 'custom_tool_call', 'tool_search_call'].includes(item.type)) return item;
  const t = plan.byAlias.get(item.name);
  if (!t) return item;
  const base = { ...item, name: t.name, ...(t.namespace ? { namespace: t.namespace } : {}) };
  if (t.type === 'custom') return { ...base, type: 'custom_tool_call', input: parseCustom(item.arguments), arguments: undefined };
  if (t.type === 'tool_search') {
    let args; try { args = JSON.parse(item.arguments || '{}'); } catch { fail(); }
    return { ...base, type: 'tool_search_call', execution: 'client', arguments: args };
  }
  return base;
}

export function restoreResponsesResponse(response, plan) {
  if (!response || typeof response !== 'object') return response;
  return {
    ...response,
    output: Array.isArray(response.output) ? response.output.map(item => restoreResponsesItem(item, plan)) : response.output,
    tools: plan.originalTools
  };
}

export function responsesEventRewriter(plan) {
  const states = new Map();
  let sequence = 0;
  const emit = list => list.map(data => ({ ...data, sequence_number: sequence++ }));
  return data => {
    if (!data || typeof data !== 'object') return emit([data]);
    let output = data;
    if (data.type === 'response.output_item.added' && data.item?.type === 'function_call') {
      const t = plan.byAlias.get(data.item.name);
      if (t?.type === 'custom') {
        states.set(data.item.id, { t, arguments: '' });
        output = { ...data, item: { ...data.item, type: 'custom_tool_call', input: '', name: t.name, ...(t.namespace ? { namespace: t.namespace } : {}), arguments: undefined } };
      } else if (t) output = { ...data, item: { ...data.item, name: t.name, ...(t.namespace ? { namespace: t.namespace } : {}) } };
    } else if (data.type === 'response.function_call_arguments.delta') {
      const state = states.get(data.item_id);
      if (state) { state.arguments += data.delta || ''; return emit([]); }
    } else if (data.type === 'response.function_call_arguments.done') {
      const state = states.get(data.item_id);
      if (state) {
        const input = parseCustom(typeof data.arguments === 'string' ? data.arguments : state.arguments);
        return emit([{ ...data, type: 'response.custom_tool_call_input.done', input, arguments: undefined }, { ...data, type: 'response.output_item.done', item: { ...data.item, type: 'custom_tool_call', input, name: state.t.name, ...(state.t.namespace ? { namespace: state.t.namespace } : {}), arguments: undefined } }]);
      }
    } else if (data.type === 'response.output_item.done' && data.item?.type === 'function_call') {
      const state = states.get(data.item.id);
      if (state) {
        const input = parseCustom(typeof data.item.arguments === 'string' ? data.item.arguments : state.arguments);
        output = { ...data, item: { ...data.item, type: 'custom_tool_call', input, name: state.t.name, ...(state.t.namespace ? { namespace: state.t.namespace } : {}), arguments: undefined } };
      } else {
        const t = plan.byAlias.get(data.item.name);
        if (t) output = { ...data, item: { ...data.item, name: t.name, ...(t.namespace ? { namespace: t.namespace } : {}) } };
      }
    } else if (['response.completed', 'response.incomplete'].includes(data.type) && data.response) {
      output = { ...data, response: restoreResponsesResponse(data.response, plan) };
    } else if (['response.created', 'response.in_progress'].includes(data.type) && data.response) {
      output = { ...data, response: { ...data.response, tools: plan.originalTools } };
    }
    return emit([output]);
  };
}
