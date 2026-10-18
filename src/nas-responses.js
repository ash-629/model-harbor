// Native structured Responses over a fixed SSH relay; no remote agent/tool execution.
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { HttpError } from './store.js';
import { runtimePrefix } from './remote-codex.js';
import { agentInput, outputBudget, agentChat } from './nas-agent.js';
import { openSSE, writeSSE, sseEvents } from './protocol.js';

const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
export function responsesCommand(p) {
  const command = [...runtimePrefix(p), 'timeout', '--signal=TERM', '--kill-after=5s', '610s',
    'python3', '/workspace/model-harbor/codex-responses-runner.py'];
  return { command: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15',
    '-i', p.sshKeyPath, p.sshUser + '@' + p.sshHost, command.map(quote).join(' ')] };
}
export function nativeRequest(raw, model, endpoint) {
  const body = agentInput(raw, endpoint);
  // Native discovery outputs must stay tool_search_output, not be wrapped as
  // dynamic function results as required by the legacy app-server adapter.
  if (endpoint === 'responses' && Array.isArray(raw.input)) body.input = raw.input.filter(i => i.type !== 'additional_tools');
  if (body.store === true || body.background || body.conversation || body.previous_response_id)
    throw new HttpError(400, 'Remote Responses requires store=false and complete history', 'unsupported_parameter');
  // Codex subscription selects its own sampling settings. Strip optional
  // sampling fields as reference clients do instead of blocking chat.
  const ignoredSampling = ['temperature','top_p'].filter(key => body[key] != null);
  const budget = outputBudget(body);
  const input = typeof body.input === 'string' ? [{role:'user',content:body.input}] : body.input;
  if (!Array.isArray(input) || !input.length) throw new HttpError(400, 'input is required');
  const result = {...body, model, stream:true, store:false, instructions:body.instructions || '',
    input:input.map(item => {
      const value = {...item};
      if (value.role === 'system') value.role = 'developer';
      // Provider-specific IDs and plaintext reasoning cannot be replayed as
      // encrypted OpenAI reasoning. Preserve its text as historical context.
      if (value.type === 'reasoning' && !value.encrypted_content?.startsWith('gAAAA')) {
        const text = [...(value.summary || []), ...(value.content || [])].map(p => p.text || '').join('\n');
        return text ? {role:'assistant',content:[{type:'output_text',text:'[Historical reasoning]\n'+text}]} : null;
      }
      if (value.type !== 'reasoning') delete value.id;
      if (value.type === 'function_call' && !value.arguments?.trim()) value.arguments = '{}';
      return value;
    }).filter(Boolean)};
  // Subscription Responses does not enforce these token fields; disclose the
  // same generation hint used by the previous bridge instead of inventing a cap.
  if (budget) result.instructions += '\nRequested output budget: '+budget+' tokens. This is a generation hint; keep tool arguments complete.';
  result.include = [...new Set([...(body.include || []), 'reasoning.encrypted_content'])];
  for (const key of ['messages','max_tokens','max_completion_tokens','max_output_tokens','reasoning_effort','temperature','top_p'])
    delete result[key];
  if (body.reasoning_effort && !result.reasoning) result.reasoning = {effort:body.reasoning_effort};
  return {body:result,budget,ignoredSampling};
}
function decorate(response, publicModel, budget, ignoredSampling = []) {
  response.model = publicModel;
  if (ignoredSampling.length) response.metadata = {...response.metadata, model_harbor_ignored_sampling:ignoredSampling.join(',')};
  if (budget) response.metadata = {...response.metadata, model_harbor_output_limit:'hint', model_harbor_requested_output_tokens:String(budget)};
  return response;
}
export async function sendDirect(p, model, raw, endpoint, res, signal, launch = p => {
  const c = responsesCommand(p); return spawn(c.command, c.args, {windowsHide:true});
}) {
  const request = nativeRequest(raw, model, endpoint);
  const child = launch(p), timer = setTimeout(() => {child.kill();child.stdout.destroy(new HttpError(504,'Remote Codex Responses timed out','upstream_timeout'));}, (p.timeout || 180)*1000);
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  child.on('error', () => child.stdout.destroy(new HttpError(502,'Remote Codex relay could not start','codex_transport_error')));
  const abort = () => { child.kill(); child.stdout.destroy(new HttpError(499,'Request cancelled')); };
  signal?.addEventListener('abort', abort, {once:true});
  child.stdin.end(JSON.stringify(request.body));
  try {
    if (signal?.aborted) throw new HttpError(499,'Request cancelled');
    const iterator = child.stdout[Symbol.asyncIterator]();
    let prefix = Buffer.alloc(0), remainder;
    while (true) {
      const part = await iterator.next();
      if (part.done) throw new HttpError(502,'Remote Codex relay ended before headers','codex_transport_error');
      prefix = Buffer.concat([prefix, part.value]);
      const newline = prefix.indexOf(10);
      if (newline >= 0) { remainder = prefix.subarray(newline+1); prefix = prefix.subarray(0,newline); break; }
      if (prefix.length > 4096) throw new HttpError(502,'Invalid remote relay header');
    }
    const header = JSON.parse(prefix.toString());
    if (header.status !== 200) throw new HttpError(header.status || 502,
      header.code === 'codex_login_expired' ? 'Remote Codex login expired; refresh the login on the remote host' : 'Remote Codex Responses returned HTTP '+header.status+(header.message ? ': '+header.message : ''),
      header.code || 'codex_upstream_error');
    const stream = Readable.from((async function*() { if (remainder.length) yield remainder;
      while (true) {const part = await iterator.next();if (part.done) break;yield part.value;}
    })());
    let terminal = false, final;
    // Delay opening the client stream until the upstream has produced a real
    // response event. An immediate upstream protection error can then fall
    // back to the app-server relay without a half-written SSE response.
    let opened = false;
    for await (const event of sseEvents(stream)) {
      if (event.data === '[DONE]') continue; // [DONE] alone is not a Responses terminal event.
      const data = JSON.parse(event.data);
      if (data.response) decorate(data.response,raw.model,request.budget,request.ignoredSampling);
      if (data.model) data.model = raw.model;
      if (data.type === 'response.completed' || data.type === 'response.incomplete') {terminal = true;final = data.response;}
      if (data.type === 'error' || data.type === 'response.failed') {
        const detail = data.response?.error || data.error || {};
        const code = String(detail.code || 'unknown').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,80) || 'unknown';
        const protection = /response protection is unavailable/i.test(String(detail.message || ''));
        throw new HttpError(502, protection ? 'Remote Codex response protection unavailable' : 'Remote Codex inference failed (' + code + ')', protection ? 'codex_response_protection' : 'codex_response_failed');
      }
      if (raw.stream && endpoint === 'responses') { if (!opened) { openSSE(res); opened = true; } await writeSSE(res,data,event.event); }
    }
    if (!terminal || !final) throw new HttpError(502,'Remote stream ended without a terminal Responses event','upstream_stream_incomplete');
    if (endpoint === 'responses') {if(raw.stream){res.end();return null;}return final;}
    const chat = agentChat(final);
    if (!raw.stream) return chat;
    openSSE(res);
    const {message,finish_reason} = chat.choices[0];
    const base = {id:chat.id,object:'chat.completion.chunk',created:chat.created,model:raw.model};
    await writeSSE(res,{...base,choices:[{index:0,delta:{...message,...(message.tool_calls ? {tool_calls:message.tool_calls.map((t,index)=>({...t,index}))} : {})},finish_reason:null}]});
    await writeSSE(res,{...base,choices:[{index:0,delta:{},finish_reason}]});
    if(chat.usage) await writeSSE(res,{...base,choices:[],usage:chat.usage});
    await writeSSE(res,'[DONE]');res.end();return null;
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',abort);child.kill();
  }
}
