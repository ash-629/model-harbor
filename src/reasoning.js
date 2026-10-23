// Preserve provider-specific reasoning across stateless Chat tool turns.
// DeepSeek V4 thinking mode requires the assistant tool-call message to retain
// its exact `reasoning_content` on the following request. Responses clients may
// not return that provider-specific field, so keep a bounded, short-lived cache
// keyed by tool call ID and also expose a portable reasoning summary item.

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1024;
const MAX_ENTRY_CHARS = 2 * 1024 * 1024;
const MAX_TOTAL_CHARS = 16 * 1024 * 1024;
const cache = new Map();
let totalChars = 0;

function cacheKey(scope, callId) {
  return `${String(scope || '')}\0${String(callId || '')}`;
}

function prune(now = Date.now()) {
  for (const [key, entry] of cache) {
    if (entry.expires <= now) {
      cache.delete(key);
      totalChars -= entry.text.length;
    } else break;
  }
  while (cache.size > MAX_ENTRIES || totalChars > MAX_TOTAL_CHARS) {
    const [key, entry] = cache.entries().next().value || [];
    if (!key) break;
    cache.delete(key);
    totalChars -= entry.text.length;
  }
}

export function reasoningTextFromItem(item) {
  if (!item || item.type !== 'reasoning') return '';
  const values = [];
  if (typeof item.reasoning_content === 'string') values.push(item.reasoning_content);
  for (const part of [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]) {
    if (typeof part === 'string') values.push(part);
    else if (typeof part?.text === 'string' && ['summary_text', 'reasoning_text', 'text'].includes(part.type)) values.push(part.text);
  }
  return values.join('\n');
}

export function rememberReasoning(scope, callId, text, now = Date.now()) {
  const key = cacheKey(scope, callId);
  if (!callId || typeof text !== 'string' || !text || text.length > MAX_ENTRY_CHARS) return false;
  const previous = cache.get(key);
  if (previous) totalChars -= previous.text.length;
  cache.delete(key);
  cache.set(key, { text, expires: now + TTL_MS });
  totalChars += text.length;
  prune(now);
  return cache.has(key);
}

export function cachedReasoning(scope, callId, now = Date.now()) {
  prune(now);
  return cache.get(cacheKey(scope, callId))?.text || '';
}

export function createReasoningItem(id, text) {
  return { id, type: 'reasoning', status: text ? 'completed' : 'in_progress', summary: [{ type: 'summary_text', text }] };
}

// Restore provider-specific reasoning for clients that call the Chat endpoint
// directly and only send back assistant tool calls plus tool results.
// DeepSeek thinking mode rejects a tool-call assistant message without the
// field even when the original chain of thought is no longer available, so
// `fillEmpty` keeps the protocol valid with an explicitly empty value.
export function restoreCachedReasoning(payload, scope, options = {}) {
  if (!Array.isArray(payload?.messages)) return payload;
  const now = typeof options === 'number' ? options : (options?.now ?? Date.now());
  const fillEmpty = typeof options === 'object' && options.fillEmpty === true;
  let changed = false;
  const messages = payload.messages.map(message => {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || (typeof message.reasoning_content === 'string' && message.reasoning_content)) return message;
    let reasoning = '';
    for (const call of message.tool_calls) {
      reasoning = cachedReasoning(scope, call?.id, now);
      if (reasoning) break;
    }
    // Some OpenAI-compatible clients echo the provider field as `reasoning`.
    if (!reasoning && typeof message.reasoning === 'string') reasoning = message.reasoning;
    if (!reasoning && !fillEmpty) return message;
    changed = true;
    return { ...message, reasoning_content: reasoning };
  });
  return changed ? { ...payload, messages } : payload;
}

export function rememberChatReasoning(chat, scope, now = Date.now()) {
  const message = chat?.choices?.[0]?.message;
  if (!message || !Array.isArray(message.tool_calls)) return false;
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  let remembered = false;
  for (const call of message.tool_calls) remembered = rememberReasoning(scope, call?.id, reasoning, now) || remembered;
  return remembered;
}

export function createChatReasoningTracker(scope) {
  let reasoning = '';
  const callIds = new Map();
  let flushed = false;
  const flush = (now = Date.now()) => {
    if (flushed) return false;
    flushed = true;
    let remembered = false;
    for (const id of callIds.values()) remembered = rememberReasoning(scope, id, reasoning, now) || remembered;
    return remembered;
  };
  return {
    push(chat, now = Date.now()) {
      const choice = chat?.choices?.[0];
      if (!choice) return false;
      const delta = choice.delta || {};
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      for (const call of delta.tool_calls || []) {
        if (call?.id) callIds.set(call.index ?? callIds.size, call.id);
      }
      if (choice.finish_reason) flush(now);
      return false;
    },
    flush,
    get reasoning() { return reasoning; }
  };
}

export function clearReasoningCacheForTests() {
  cache.clear();
  totalChars = 0;
}
