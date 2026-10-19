// F-03/F-05: upstream requests, streaming backpressure, cancellation and sanitized failures.
import { HttpError } from './store.js';
import { optimizeApiPayload, tokenPolicy, usageMetrics, requestStats } from './api-token-policy.js';
import { toChat, fromChat, bridgeStream, sseEvents, openSSE, writeSSE } from './protocol.js';
import { sendAgent } from './nas-agent.js';
import { claudeModels, sendClaude, ClaudeCodeBridge } from './claude-code.js';
const defaultClaudeBridge = new ClaudeCodeBridge();

export async function upstreamFetch(store, p, path, body, signal) {
  const timeout = AbortSignal.timeout((p.timeout || 180) * 1000);
  const headers = { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) };
  const key = store.unseal(p.apiKey); if (key) headers.authorization = `Bearer ${key}`;
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
    await response.body?.cancel();
    const err = response.status === 413
      ? new HttpError(413, `上游 ${p.name} 拒绝请求：实际转发 ${(requestBytes / (1024 * 1024)).toFixed(2)} MiB（${requestBytes} 字节），超过上游允许的请求大小。请在客户端压缩会话历史、减少附件，或新开会话携带任务摘要；提高模型港上限无法解除上游限制。`, 'upstream_request_too_large')
      : new HttpError(response.status, `上游 ${p.name} 返回 HTTP ${response.status}；请检查密钥、模型权限和接口协议`, 'upstream_error');
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
  const response = await upstreamFetch(store, p, 'models', undefined, signal);
  const data = await response.json();
  if (!Array.isArray(data.data)) throw new HttpError(502, '上游模型接口未返回 data 数组，请手工填写模型');
  return data.data.map(m => m.id);
}
export async function route(store, p, model, body, endpoint, res, signal, nasAgent, claudeBridge = defaultClaudeBridge) {
  if (p.type === 'nas-codex') {
    if (!nasAgent) throw new HttpError(502, 'Codex 官方 app-server 桥接未初始化', 'codex_bridge_unavailable');
    return sendAgent(nasAgent, p, model, body, endpoint, res, signal);
  }
  if (p.type === 'claude-code') {
    return sendClaude(claudeBridge, p, model, body, endpoint, res, signal);
  }
  if (endpoint === 'chat/completions' && p.protocol === 'responses') throw new HttpError(400, '此上游仅提供 Responses，请使用 /v1/responses 或更改供应商协议');
  const bridge = endpoint === 'responses' && p.protocol === 'chat';
  let payload = { ...(bridge ? toChat(body) : body), model };
  const policy = tokenPolicy(p.tokenOptimization);
  const optimized = optimizeApiPayload(payload, policy, res.apiOptimizationDisabled);
  payload = optimized.payload;
  if (payload.stream && (bridge || endpoint === 'chat/completions') && policy.captureStreamUsage) {
    payload = { ...payload, stream_options: { ...payload.stream_options, include_usage: true } };
  }
  optimized.stats.after = requestStats(payload);
  const metrics = res.apiMetrics = { provider: p.id, protocol: bridge ? 'chat' : endpoint, ...optimized.stats, usage: null, completion: 'pending' };
  const upstream = await upstreamFetch(store, p, bridge ? 'chat/completions' : endpoint, payload, signal);
  if (!body.stream) {
    const data = await upstream.json();
    if (data.error) throw new HttpError(502, '上游返回了错误响应', 'upstream_error');
    metrics.usage = usageMetrics(data.usage);
    metrics.completion = data.status || data.choices?.[0]?.finish_reason || 'completed';
    if (bridge) return fromChat(data, body.model);
    return { ...data, model: body.model };
  }
  if (!upstream.headers.get('content-type')?.includes('text/event-stream')) { await upstream.body.cancel(); throw new HttpError(502, '上游没有返回 SSE 流，请检查协议配置'); }
  if (bridge) { await bridgeStream(upstream.body, res, body.model, (response, rawUsage) => { metrics.usage = usageMetrics(rawUsage); metrics.completion = response.status; }); return null; }
  openSSE(res);
  let terminal = false;
  for await (const event of sseEvents(upstream.body)) {
    if (event.data === '[DONE]') { terminal = true; await writeSSE(res, '[DONE]', event.event); continue; }
    let data; try { data = JSON.parse(event.data); } catch { throw new HttpError(502, '上游 SSE 包含无效 JSON'); }
    if (data.error || data.type === 'error' || data.type === 'response.failed') throw new HttpError(502, '上游流返回错误', 'upstream_error');
    if (data.usage || data.response?.usage) metrics.usage = usageMetrics(data.usage || data.response.usage);
    if (data.choices?.some(c => c.finish_reason)) metrics.completion = data.choices.find(c => c.finish_reason).finish_reason;
    if (['response.completed', 'response.incomplete'].includes(data.type)) metrics.completion = data.type.slice(9);
    if (data.model) data.model = body.model;
    if (data.response?.model) data.response.model = body.model;
    if (data.choices?.some(c => c.finish_reason) || ['response.completed', 'response.incomplete'].includes(data.type)) terminal = true;
    await writeSSE(res, data, event.event);
  }
  if (!terminal) throw new HttpError(502, '上游流意外结束，未收到完成标记');
  if (metrics.completion === 'pending') metrics.completion = 'completed';
  res.end(); return null;
}
