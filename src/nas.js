// F-07, R-03: fixed SSH/Docker adapter. Prompts travel via stdin, never shell interpolation.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { HttpError } from './store.js';
import { uid, openSSE, writeSSE, fromChat } from './protocol.js';
import { runtimePrefix, codexExecutable, sshCommand } from './remote-codex.js';
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

export function remote(p, command, stdin = '', signal) {
  return new Promise((resolve, reject) => {
    const ssh = sshCommand(p, command);
    const child = spawn(ssh.command, ssh.args, { windowsHide: true, signal });
    let out = '', err = '', size = 0; const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => { child.kill(); reject(new HttpError(504, '远程调用超时')); }, (p.timeout || 180) * 1000 + 10000);
    child.stdout.on('data', data => { size += data.length; if (size > 8 * 1024 * 1024) { child.kill(); reject(new HttpError(502, '远程输出超出限制')); } else out += decoder.write(data); });
    child.stderr.on('data', data => { if (err.length < 2000) err += data.toString(); });
    child.on('error', () => { clearTimeout(timer); reject(new HttpError(signal?.aborted ? 499 : 502, signal?.aborted ? '请求已取消' : '无法启动 SSH，请检查 SSH 客户端及私钥路径')); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      out += decoder.end();
      if (code === 0) resolve(out);
      else {
        const reason = /Permission denied/.test(err) ? 'SSH 认证失败' : /sudo.*password|password is required/.test(err) ? '远程 sudo 需要配置免交互 Docker 权限' : /Host key verification/.test(err) ? 'SSH 主机密钥未受信，请先手动连接核对' : /timed out|unreachable|refused/i.test(err) ? '远程网络连接失败' : 'SSH / Docker / Codex 执行失败';
        reject(new HttpError(502, `${p.execution === 'ssh' && reason === 'SSH / Docker / Codex 执行失败' ? 'SSH / Codex 执行失败' : reason}（退出码 ${code}）`));
      }
    });
    child.stdin.end(stdin);
  });
}
function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(p => ['text', 'input_text', 'output_text'].includes(p.type))) return content.map(p => p.text).join('\n');
  throw new HttpError(400, '远程 Codex 桥接仅支持文本内容', 'unsupported_parameter');
}
export async function nasCompletion(p, model, body, signal) {
  if (body.tools?.length || (body.tool_choice && body.tool_choice !== 'none')) throw new HttpError(400, '远程 Codex 是文本桥接，不支持客户端工具调用；编程 Agent 请使用原生 API 上游', 'unsupported_parameter');
  for (const k of ['response_format', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'reasoning_effort']) if (body[k] !== undefined) throw new HttpError(400, `远程文本桥接暂不支持参数 ${k}`, 'unsupported_parameter');
  if (body.n && body.n !== 1) throw new HttpError(400, '远程文本桥接只支持 n=1');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, 'messages 必须为非空数组');
  const transcript = body.messages.map(m => {
    if (!['system', 'developer', 'user', 'assistant'].includes(m.role) || m.tool_calls) throw new HttpError(400, '远程文本桥接不支持工具消息');
    return { role: m.role, content: textContent(m.content) };
  });
  const prompt = '你是文本对话服务。请依据以下 JSON 中的对话历史回答最后的用户消息。不要执行命令、使用工具或访问文件。只输出回答内容。\n' + JSON.stringify(transcript);
  const command = [...runtimePrefix(p), 'timeout', '--signal=TERM', '--kill-after=5s', `${p.timeout || 180}s`, codexExecutable(p), 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-C', '/tmp', '-s', 'read-only', '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false', '-c', 'features.apply_patch_freeform=false', '-m', model, '-'];
  const raw = await remote(p, command, prompt, signal);
  let text = '', usage, completed = false;
  for (const line of raw.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'turn.failed' || event.type === 'error') throw new HttpError(502, '远程 Codex 推理失败，请检查登录状态、模型权限和容器日志');
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text += (text ? '\n' : '') + event.item.text;
    if (event.type === 'turn.completed') { completed = true; usage = event.usage; }
  }
  if (!completed || !text) throw new HttpError(502, '远程 Codex 没有返回完成的文本回复');
  return { id: uid('chatcmpl-'), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: usage ? { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0), prompt_tokens_details: { cached_tokens: usage.cached_input_tokens || 0 } } : undefined };
}
export async function sendNas(chat, res, endpoint, stream) {
  if (!stream) return endpoint === 'responses' ? fromChat(chat, chat.model) : chat;
  openSSE(res);
  if (endpoint === 'responses') {
    const response = fromChat(chat, chat.model), item = response.output[0]; let seq = 0;
    const emit = (type, fields) => writeSSE(res, { type, sequence_number: seq++, ...fields }, type);
    const initial = { ...response, status: 'in_progress', output: [], usage: null };
    await emit('response.created', { response: initial }); await emit('response.in_progress', { response: initial });
    await emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    await emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { ...item.content[0], text: '' } });
    await emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: chat.choices[0].message.content });
    await emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: chat.choices[0].message.content });
    await emit('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
    await emit('response.output_item.done', { output_index: 0, item });
    await emit('response.completed', { response });
  } else {
    const base = { id: chat.id, object: 'chat.completion.chunk', created: chat.created, model: chat.model };
    await writeSSE(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: chat.choices[0].message.content }, finish_reason: null }] });
    await writeSSE(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    await writeSSE(res, { ...base, choices: [], usage: chat.usage });
    await writeSSE(res, '[DONE]');
  }
  res.end(); return null;
}
