// F-03/F-05: upstream requests, streaming backpressure, cancellation and sanitized failures.
import { HttpError } from './store.js';
import { optimizeApiPayload, tokenPolicy, usageMetrics, requestStats } from './api-token-policy.js';
import { toChat, fromChat, bridgeStream, sseEvents, openSSE, writeSSE, chatToResponses, responsesToChat, responsesStreamToChat, normalizeChatToolMessages } from './protocol.js';
import { sendAgent } from './nas-agent.js';
import { claudeModels, sendClaude, ClaudeCodeBridge } from './claude-code.js';
import { grokModels, sendGrok, GrokCodeBridge } from './grok-code.js';
import { discoverOpenCodeGo, isOpenCodeGoProvider, openCodeSessionId, classifyOpenCodeGoModel, OPENCODE_GO_SESSION_HEADER, OPENCODE_GO_USER_AGENT } from './opencode-go.js';
import { openCodeGoCredential } from './opencode-go-auth.js';
import { chatToolPlan } from './chat-tools.js';
import { responsesToolPlan, restoreResponsesResponse, responsesEventRewriter } from './responses-tools.js';
import { optimizePayloadImages, imageOptimizationSettings, shouldOptimizeProviderImages } from './image-optimizer.js';
import { createChatReasoningTracker, rememberChatReasoning, restoreCachedReasoning } from './reasoning.js';

export function extractUpstreamError(text) {
  let parsed; try { parsed = JSON.parse(text); } catch {}
  const candidates = [
    parsed?.error?.message, parsed?.error?.error?.message, parsed?.message,
    parsed?.error?.detail, parsed?.detail, typeof parsed?.error === 'string' ? parsed.error : ''
  ];
  let detail = candidates.find(value => typeof value === 'string' && value.trim());
  // A plain-text error body is useful when it is not an HTML page or JSON.
  if (!detail && parsed === undefined && text && !text.trimStart().startsWith('<')) detail = text;
  if (typeof detail !== 'string') return '';
  return detail.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]').replace(/\b(?:sk|oc_sk|mh)-[A-Za-z0-9._-]{8,}\b/g, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 400);
}
const defaultClaudeBridge = new ClaudeCodeBridge();
const defaultGrokBridge = new GrokCodeBridge();

// Compaction ciphertext is provider-specific. Only use this fallback after
// the destination explicitly rejects it; valid native blobs pass unchanged.
export function compactionFallback(body) {
  if (!Array.isArray(body.input)) return null;
  let count = 0, missing = 0;
  const input = body.input.flatMap(item => {
    const reasoning = item?.type === 'reasoning' && typeof item.encrypted_content === 'string';
    if (item?.type !== 'compaction' && !reasoning) return [item];
    count++;
    const parts = [item.summary, item.content];
    const texts = parts.flatMap(part => typeof part === 'string' ? [part] : Array.isArray(part) ? part.filter(v => ['summary_text', 'text', 'output_text', 'input_text'].includes(v?.type) && typeof v.text === 'string').map(v => v.text) : []);
    if (!texts.length) missing++;
    // Encrypted reasoning has no portable meaning; keep visible summaries,
    // but omit an opaque-only reasoning item rather than inventing thoughts.
    if (reasoning && !texts.length) return [];
    return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: texts.length ? texts.join('\n') : '[Earlier history was compacted into encrypted data that this provider cannot decode. That history is unavailable. Do not invent its contents; use the remaining visible messages and request a task summary if needed.]' }] }];
  });
  return count ? { payload: { ...body, input }, count, missing } : null;
}

export async function upstreamFetch(store, p, path, body, signal, sessionId = '') {
  const timeout = AbortSignal.timeout((p.timeout || 180) * 1000);
  const headers = { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) };
  const credential = isOpenCodeGoProvider(p) ? await openCodeGoCredential(store, p, { signal }) : { apiKey: store.unseal(p.apiKey) };
  if (credential.apiKey) headers.authorization = `Bearer ${credential.apiKey}`;
  if (credential.orgId) headers['x-opencode-org-id'] = credential.orgId;
  if (isOpenCodeGoProvider(p)) {
    headers['user-agent'] = OPENCODE_GO_USER_AGENT;
    if (sessionId) headers[OPENCODE_GO_SESSION_HEADER] = sessionId;
  }
  const encodedBody = body ? JSON.stringify(body) : undefined;
  const requestBytes = encodedBody === undefined ? 0 : Buffer.byteLength(encodedBody, 'utf8');
  let response;
  try {
    response = await fetch(`${p.baseUrl}/${path}`, { method: body ? 'POST' : 'GET', headers,
      body: encodedBody, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
  } catch (e) {
    throw new HttpError(signal?.aborted ? 499 : e.name === 'TimeoutError' ? 504 : 502, signal?.aborted ? '请求已取消' : e.name === 'TimeoutError' ? '上游响应超时' : '无法连接上游，请检查 Base URL、网络或证书');
  }
  if (!response.ok) {
    // Interpret only a known public configuration error; never echo raw
    // upstream bodies, which can contain credentials or request content.
    let goDetail = '';
    if (isOpenCodeGoProvider(p) && [400, 422].includes(response.status) && response.body) {
      const reader = response.body.getReader(); let text = '';
      try {
        const decoder = new TextDecoder(); let bytes = 0;
        while (bytes < 8192) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          text += decoder.decode(part.value.subarray(0, Math.max(0, 8192 - (bytes - part.value.byteLength))), { stream: true });
        }
      } finally { try { await reader.cancel(); } catch {} }
      goDetail = extractUpstreamError(text);
      if (goDetail) {
        if (goDetail.includes('This Go model requires Global regions.')) {
          throw new HttpError(400, 'OpenCode Go 要求此模型使用 Global regions。请到 OpenCode 工作区 → Privacy → Regions 选择 Global 后重试。', 'opencode_go_global_regions_required');
        }
      }
    } else await response.body?.cancel();
    let message = `上游 ${p.name} 返回 HTTP ${response.status}；请检查密钥、模型权限和接口协议`;
    if (goDetail) message += `。OpenCode：${goDetail}`;
    const err = response.status === 413
      ? new HttpError(413, `上游 ${p.name} 拒绝请求：实际转发 ${(requestBytes / (1024 * 1024)).toFixed(2)} MiB（${requestBytes} 字节），超过上游允许的请求大小。请在客户端压缩会话历史、减少附件，或新开会话携带任务摘要；提高模型港上限无法解除上游限制。`, 'upstream_request_too_large')
      : new HttpError(response.status, message, 'upstream_error');
    err.retryAfter = response.headers.get('retry-after'); throw err;
  }
  return response;
}
export async function discover(store, p, signal, nasAgent) {
  if (p.type === 'nas-codex') {
    if (!nasAgent?.models) throw new HttpError(502, 'Codex 官方 app-server 桥接未初始化', 'codex_bridge_unavailable');
    return nasAgent.models(p, signal);
  }
  if (p.type === 'claude-code') return claudeModels(p, signal);
  if (p.type === 'grok-code') return grokModels(p, signal);
  if (isOpenCodeGoProvider(p)) return discoverOpenCodeGo(store, p, signal);
  const response = await upstreamFetch(store, p, 'models', undefined, signal);
  const data = await response.json();
  if (!Array.isArray(data.data)) throw new HttpError(502, '上游模型接口未返回 data 数组，请手工填写模型');
  return data.data.map(m => m.id);
}
export async function route(store, p, model, body, endpoint, res, signal, nasAgent, claudeBridge = defaultClaudeBridge, requestSessionId = '', grokBridge = defaultGrokBridge, options = {}) {
  if (p.type === 'nas-codex') {
    if (!nasAgent) throw new HttpError(502, 'Codex 官方 app-server 桥接未初始化', 'codex_bridge_unavailable');
    res.apiMetrics = { provider: p.id, protocol: 'chat', usage: null, completion: 'pending' };
    return sendAgent(nasAgent, p, model, body, endpoint, res, signal, options);
  }
  if (p.type === 'claude-code') {
    return sendClaude(claudeBridge, p, model, body, endpoint, res, signal);
  }
  if (p.type === 'grok-code') {
    return sendGrok(grokBridge, p, model, body, endpoint, res, signal);
  }
  const sessionId = isOpenCodeGoProvider(p) ? openCodeSessionId(body, requestSessionId) : '';
  if (endpoint === 'chat/completions' && p.protocol === 'responses') throw new HttpError(400, '此上游仅提供 Responses，请使用 /v1/responses 或更改供应商协议');
  const go = isOpenCodeGoProvider(p), group = go ? classifyOpenCodeGoModel(model) : '';
  if (go && !['chat', 'responses'].includes(group)) throw new HttpError(400, `OpenCode Go 模型 ${model} 使用 ${group || '未知'} 端点；模型港暂不支持该协议`, 'opencode_go_protocol');
  // Grok's Go Responses endpoint rejects custom tools and namespaces. It does
  // support the equivalent single-string function, so keep the original
  // client contract while translating only for this model family.
  const goResponsesNative = go && group === 'responses' && /^(?:grok|muse-spark)/i.test(model);
  // A merged Go provider routes by each model's official endpoint. Translate
  // only when the client's requested public API differs from that endpoint.
  const publicFamily = endpoint === 'responses' ? 'responses' : 'chat';
  const native = go ? group : p.protocol === 'responses' ? 'responses' : p.protocol === 'both' ? publicFamily : 'chat';
  const bridge = publicFamily === 'responses' && native === 'chat';
  const chatToResp = publicFamily === 'chat' && native === 'responses';
  // DeepSeek thinking-mode tool turns require the assistant message to carry
  // `reasoning_content`. When the client dropped it and the short-lived cache
  // no longer has the original chain, send an explicit empty value instead of
  // failing the whole conversation with a 400.
  const reasoningEcho = native === 'chat' && (/deepseek/i.test(String(model)) || /deepseek/i.test(String(p.baseUrl || '')));
  const reasoningOptions = reasoningEcho ? { fillEmpty: true } : undefined;
  const toolPlan = bridge ? chatToolPlan(body) : undefined;
  const nativeToolPlan = goResponsesNative && publicFamily === 'responses' ? responsesToolPlan(body, { dropHosted: true }) : undefined;
  let payload = { ...(bridge ? toChat(body, toolPlan, p.id, reasoningEcho ? { fillReasoning: true } : undefined) : chatToResp ? chatToResponses(body) : nativeToolPlan ? nativeToolPlan.request : body), model };
  if (native === 'chat') payload = restoreCachedReasoning(payload, p.id, reasoningOptions);
  if (go && native === 'chat') payload = normalizeChatToolMessages(payload);
  const chatReasoningTracker = native === 'chat' && body.stream ? createChatReasoningTracker(p.id) : null;
  const imageSettings = imageOptimizationSettings();
  let imageResult = null;
  if (shouldOptimizeProviderImages(p, imageSettings, go)) {
    try {
      imageResult = await optimizePayloadImages(payload, { ...imageSettings, enabled: true });
      payload = imageResult.payload;
    } catch (error) {
      console.warn('[image-optimizer] payload pass skipped: ' + String(error?.message || error).slice(0, 240));
    }
  }
  const policy = tokenPolicy(p.tokenOptimization);
  const optimized = optimizeApiPayload(payload, policy, res.apiOptimizationDisabled);
  payload = optimized.payload;
  if (payload.stream && (bridge || endpoint === 'chat/completions') && policy.captureStreamUsage) {
    payload = { ...payload, stream_options: { ...payload.stream_options, include_usage: true } };
  }
  optimized.stats.after = requestStats(payload);
  const toolTypes = Array.isArray(body.tools) ? body.tools.map(tool => String(tool?.type || (tool?.function ? 'function' : 'unknown')).slice(0, 60)) : [];
  const metrics = res.apiMetrics = { provider: p.id, protocol: native === 'chat' ? 'chat' : 'responses', ...optimized.stats, usage: null, completion: 'pending', ...(toolTypes.length ? { toolTypes } : {}), ...(nativeToolPlan?.droppedHosted?.length ? { droppedHosted: nativeToolPlan.droppedHosted } : {}), ...(nativeToolPlan?.droppedArguments?.length ? { droppedArguments: nativeToolPlan.droppedArguments } : {}), ...(imageResult?.stats?.images ? { imageOptimization: imageResult.stats } : {}) };
  let upstream;
  try {
    upstream = await upstreamFetch(store, p, native === 'chat' ? 'chat/completions' : 'responses', payload, signal, sessionId);
  } catch (error) {
    const fallback = go && native === 'responses' && error.status === 400 && /Could not decode the compaction blob|Could not decrypt the provided encrypted_content/i.test(error.message) ? compactionFallback(payload) : null;
    if (!fallback || signal?.aborted) throw error;
    payload = fallback.payload;
    metrics.compactionFallback = { count: fallback.count, missing: fallback.missing };
    metrics.after = requestStats(payload);
    upstream = await upstreamFetch(store, p, 'responses', payload, signal, sessionId);
  }
  if (!body.stream) {
    const data = await upstream.json();
    if (data.error) throw new HttpError(502, '上游返回了错误响应', 'upstream_error');
    if (native === 'chat') rememberChatReasoning(data, p.id);
    metrics.usage = usageMetrics(data.usage);
    metrics.completion = data.status || data.choices?.[0]?.finish_reason || 'completed';
    if (bridge) return fromChat(data, body.model, toolPlan, p.id);
    if (chatToResp) return responsesToChat(data, body.model);
    if (nativeToolPlan?.transformed) return { ...restoreResponsesResponse(data, nativeToolPlan), model: body.model };
    return { ...data, model: body.model };
  }
  if (!upstream.headers.get('content-type')?.includes('text/event-stream')) { await upstream.body.cancel(); throw new HttpError(502, '上游没有返回 SSE 流，请检查协议配置'); }
  if (bridge) { await bridgeStream(upstream.body, res, body.model, (response, rawUsage) => { metrics.usage = usageMetrics(rawUsage); metrics.completion = response.status; }, toolPlan, p.id); return null; }
  if (chatToResp) { await responsesStreamToChat(upstream.body, res, body.model); return null; }
  const rewrite = nativeToolPlan?.transformed ? responsesEventRewriter(nativeToolPlan) : null;
  openSSE(res);
  let terminal = false;
  for await (const event of sseEvents(upstream.body)) {
    if (event.data === '[DONE]') { terminal = true; await writeSSE(res, '[DONE]', event.event); continue; }
    let data; try { data = JSON.parse(event.data); } catch { throw new HttpError(502, '上游 SSE 包含无效 JSON'); }
    if (data.error || data.type === 'error' || data.type === 'response.failed') throw new HttpError(502, '上游流返回错误', 'upstream_error');
    chatReasoningTracker?.push(data);
    if (data.usage || data.response?.usage) metrics.usage = usageMetrics(data.usage || data.response.usage);
    if (data.choices?.some(c => c.finish_reason)) metrics.completion = data.choices.find(c => c.finish_reason).finish_reason;
    if (['response.completed', 'response.incomplete'].includes(data.type)) metrics.completion = data.type.slice(9);
    if (data.model) data.model = body.model;
    if (data.response?.model) data.response.model = body.model;
    if (data.choices?.some(c => c.finish_reason) || ['response.completed', 'response.incomplete'].includes(data.type)) terminal = true;
    for (const emitted of rewrite ? rewrite(data) : [data]) await writeSSE(res, emitted, event.event || emitted.type);
  }
  if (!terminal) throw new HttpError(502, '上游流意外结束，未收到完成标记');
  chatReasoningTracker?.flush();
  if (metrics.completion === 'pending') metrics.completion = 'completed';
  res.end(); return null;
}

// Provider groups: one public prefix, ordered Codex accounts, automatic failover.
const QUOTA_PATTERN = /usage limit|quota|额度|用量上限|已用完|超出额度|insufficient_quota|billing hard limit|credit balance/i;
const RATE_PATTERN = /rate limit|too many requests|请求过于频繁/i;

export function isQuotaError(error) {
  const text = `${error?.message || ''} ${error?.code || ''}`;
  return QUOTA_PATTERN.test(text) || RATE_PATTERN.test(text);
}

function cooldownKind(error) {
  const text = String(error?.message || '');
  return RATE_PATTERN.test(text) && !QUOTA_PATTERN.test(text) ? 'rate' : 'quota';
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

export async function markGroupCooldown(store, group, provider, error, nasAgent) {
  const now = Date.now(), kind = cooldownKind(error);
  let until = now + (kind === 'rate' ? 60 * 1000 : 30 * 60 * 1000);
  if (kind === 'quota' && nasAgent?.usage) {
    try {
      const usage = await withTimeout(nasAgent.usage(provider, undefined, true), 8000);
      const windows = (usage?.buckets || []).flatMap(bucket => bucket.windows || []);
      const exhausted = windows.filter(w => Number(w.usedPercent) >= 100 && Number(w.resetsAt) > 0);
      if (exhausted.length) until = Math.max(now + 60 * 1000, ...exhausted.map(w => Number(w.resetsAt) * 1000));
    } catch {}
  }
  store.setGroupCooldown(group.id, provider.id, { until, kind, at: new Date(now).toISOString(), error: String(error?.message || '').slice(0, 200) });
  return until;
}

export async function routeWithFailover(store, resolved, body, endpoint, res, signal, nasAgent, claudeBridge = defaultClaudeBridge, requestSessionId = '', grokBridge = defaultGrokBridge) {
  const group = resolved.group || null;
  const candidates = resolved.candidates?.length ? resolved.candidates : [{ provider: resolved.provider, model: resolved.model }];
  if (!group) return route(store, resolved.provider, resolved.model, body, endpoint, res, signal, nasAgent, claudeBridge, requestSessionId, grokBridge);
  const deferred = candidates.length > 1;
  const skipped = [];
  const trail = [];
  let lastError = null;
  for (let index = 0; index < candidates.length; index++) {
    const { provider, model } = candidates[index];
    const cooldown = store.groupCooldown(group.id, provider.id);
    if (cooldown) { skipped.push({ provider, until: Number(cooldown.until) }); continue; }
    try {
      const output = await route(store, provider, model, body, endpoint, res, signal, nasAgent, claudeBridge, requestSessionId, grokBridge, { deferOpen: deferred });
      store.clearGroupCooldown(group.id, provider.id);
      if (trail.length && res.apiMetrics) res.apiMetrics.failover = trail;
      return output;
    } catch (error) {
      const quota = isQuotaError(error);
      if (quota) {
        const until = await markGroupCooldown(store, group, provider, error, nasAgent);
        trail.push({ provider: provider.id, until });
      }
      if (!quota || res.headersSent || index >= candidates.length - 1) throw error;
      lastError = error;
    }
  }
  if (skipped.length) {
    const until = Math.min(...skipped.map(entry => entry.until));
    const when = new Date(until).toLocaleString('zh-CN', { hour12: false });
    throw new HttpError(429, `组「${group.name}」内的 Codex 账号额度暂不可用，最早 ${when} 恢复；可在模型港中重置冷却`, 'group_exhausted');
  }
  throw lastError || new HttpError(429, `组「${group.name}」内没有可用的 Codex 账号`, 'group_exhausted');
}