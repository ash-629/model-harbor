// I-03..I-06/IR-03/IR-04: bounded API/CLI adapters and durable background image jobs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { HttpError } from './store.js';

export const runnerFile = fileURLToPath(new URL('./codex-image-runner.py', import.meta.url));
export const grokRunnerFile = fileURLToPath(new URL('./grok-image-runner.py', import.meta.url));
export const sizes = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536', '16:9': '1536x864', '9:16': '864x1536' };
const MAX = 20 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const problem = message => new HttpError(502, message);

export function imageInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX) throw problem('Image exceeds 20 MB');
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { mime: 'image/png', ext: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let width, height, offset = 2;
    while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break; }
      if (length < 2) break;
      offset += length + 2;
    }
    return { mime: 'image/jpeg', ext: 'jpg', width, height };
  }
  if (bytes.length > 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  throw problem('The provider did not return a PNG, JPEG or WebP image');
}
export function fromBase64(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX / 3) * 4 + 200) throw problem('Invalid or oversized image data');
  const raw = value.replace(/^data:image\/(?:png|jpeg|webp);base64,/, '').replace(/\s/g, '');
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw problem('Invalid image base64 data');
  const bytes = Buffer.from(raw, 'base64'); imageInfo(bytes); return bytes;
}
async function limitedBody(response, limit) {
  const chunks = []; let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > limit) throw problem('Image response exceeds the size limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
const privateIP = ip => /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:|fe80:|ff[0-9a-f]{2}:|::ffff:)/i.test(ip) || /^::(?:1)?$/.test(ip);
async function imageURL(value, baseUrl, signal) {
  let url; try { url = new URL(value); } catch { throw problem('Invalid image download URL'); }
  for (let hop = 0; hop < 4; hop++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw problem('Invalid image download URL');
    // A configured local API may return local images. Other image hosts must resolve publicly.
    if (url.origin !== new URL(baseUrl).origin) {
      const addresses = await lookup(url.hostname, { all: true });
      if (!addresses.length || addresses.some(a => privateIP(a.address))) throw problem('Image download URL resolves to a private address');
    }
    const response = await fetch(url, { signal, redirect: 'manual', headers: { accept: 'image/png,image/jpeg,image/webp' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw problem('Invalid image download redirect');
      url = new URL(location, url); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw problem('Image download failed'); }
    const bytes = await limitedBody(response, MAX); imageInfo(bytes); return bytes;
  }
  throw problem('Too many image download redirects');
}
export async function apiImage(store, p, job, signal) {
  const minimax = p.type === 'minimax';
  const body = minimax ? { model: p.model, prompt: job.prompt, aspect_ratio: job.aspect, n: 1, response_format: 'base64', prompt_optimizer: false }
    : { model: p.model, prompt: job.prompt, size: sizes[job.aspect], n: 1 };
  const references = job.references || [];
  let payload = JSON.stringify(body), endpoint = minimax ? '/image_generation' : '/images/generations';
  let contentType = { 'content-type': 'application/json' };
  if (references.length && minimax) {
    body.subject_reference = references.map(image_file => ({ type: 'character', image_file }));
    payload = JSON.stringify(body);
  } else if (references.length) {
    endpoint = '/images/edits';
    const form = new FormData();
    for (const [name, value] of Object.entries(body)) form.append(name, String(value));
    references.forEach((value, i) => {
      const bytes = fromBase64(value), info = imageInfo(bytes);
      form.append('image[]', new Blob([bytes], { type: info.mime }), `reference-${i + 1}.${info.ext}`);
    });
    payload = form; contentType = {};
  }
  const key = store.unseal(p.apiKey);
  const response = await fetch(p.baseUrl + endpoint, {
    method: 'POST', signal, redirect: 'error', headers: { ...contentType, ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: payload,
  });
  if (!response.ok) { await response.body?.cancel(); throw problem(`Image API returned HTTP ${response.status}. Check the key, model access and base URL.`); }
  let data; try { data = JSON.parse((await limitedBody(response, 32 * 1024 * 1024)).toString('utf8')); } catch (e) { if (e instanceof HttpError) throw e; throw problem('Image API returned invalid JSON'); }
  if (data.error || (data.base_resp?.status_code && data.base_resp.status_code !== 0)) throw problem('Image API rejected the request. Check the prompt, account balance and model access.');
  const encoded = minimax ? data.data?.image_base64?.[0] : data.data?.[0]?.b64_json;
  if (encoded) return fromBase64(encoded);
  const url = minimax ? data.data?.image_urls?.[0] : data.data?.[0]?.url;
  if (url) return imageURL(url, p.baseUrl, signal);
  throw problem('Image API did not return an image');
}

export function codexCommand(p, operation, id) {
  const tail = [p.pythonPath, p.execution === 'local' ? runnerFile : p.runnerPath, operation, ...(id ? [id] : [])];
  if (p.execution === 'local') return { command: tail[0], args: tail.slice(1) };
  const remote = p.execution === 'ssh-docker' ? ['sudo', '-n', p.dockerPath, 'exec', '-i', p.container, ...tail] : tail;
  return { command: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-p', String(p.sshPort), '-i', p.sshKeyPath, `${p.sshUser}@${p.sshHost}`, remote.map(quote).join(' ')] };
}
export async function codexRun(p, operation, job, workRoot, signal) {
  const { command, args } = codexCommand(p, operation, job?.id);
  const body = JSON.stringify({ prompt: job?.prompt, references: job?.references || [], aspect: job?.aspect, timeout: p.timeout, model: p.model, sandbox: p.sandbox, codexPath: p.codexPath });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, signal, env: { ...process.env, MODEL_HARBOR_IMAGE_ROOT: workRoot } });
    const chunks = []; let size = 0, exceeded = false;
    child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
    child.stdout.on('data', bytes => { size += bytes.length; if (size > 32 * 1024 * 1024) { exceeded = true; child.kill(); } else chunks.push(bytes); });
    child.on('error', () => reject(problem('Cannot start the image runner. Check SSH, Python and executable paths.')));
    child.on('close', () => {
      if (exceeded) return reject(problem('Image runner output exceeds the size limit'));
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(problem('Image runner failed. Check SSH permissions, runner path and Codex login.')); }
      if (data.error) return reject(problem(String(data.error).slice(0, 600)));
      resolve(data);
    });
    child.stdin.end(body);
  });
}

export function grokCommand(p, operation, id) {
  const tail = [p.pythonPath, p.execution === 'local' ? grokRunnerFile : p.runnerPath, operation, ...(id ? [id] : [])];
  if (p.execution === 'local') return { command: tail[0], args: tail.slice(1) };
  const remote = p.execution === 'ssh-docker' ? ['sudo', '-n', p.dockerPath, 'exec', '-i', p.container, ...tail] : tail;
  return { command: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-p', String(p.sshPort), '-i', p.sshKeyPath, `${p.sshUser}@${p.sshHost}`, remote.map(quote).join(' ')] };
}
export async function grokRun(p, operation, job, signal) {
  const { command, args } = grokCommand(p, operation, job?.id);
  const body = JSON.stringify({ prompt: job?.prompt, references: job?.references || [], aspect: job?.aspect, timeout: p.timeout, model: p.model, grokPath: p.grokPath });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, signal });
    const chunks = []; let size = 0, exceeded = false;
    child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
    child.stdout.on('data', bytes => { size += bytes.length; if (size > 32 * 1024 * 1024) { exceeded = true; child.kill(); } else chunks.push(bytes); });
    child.on('error', () => reject(problem('Cannot start the Grok image runner. Check SSH, Python and executable paths.')));
    child.on('close', () => {
      if (exceeded) return reject(problem('Grok image runner output exceeds the size limit'));
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(problem('Grok image runner failed. Check SSH permissions, runner path and Grok login.')); }
      if (data.error) return reject(problem(String(data.error).slice(0, 600)));
      resolve(data);
    });
    child.stdin.end(body);
  });
}

export class ImageJobs {
  constructor(store, providers, dir, { execute } = {}) {
    this.store = store; this.providers = providers; this.dir = path.join(dir, 'images');
    this.workRoot = path.join(dir, 'codex-work'); this.jobs = new Map(); this.queue = []; this.active = false; this.controllers = new Set();
    this.execute = execute || (async (p, job, signal) => p.type === 'codex' ? fromBase64((await codexRun(p, 'generate', job, this.workRoot, signal)).image) : p.type === 'grok' ? fromBase64((await grokRun(p, 'generate', job, signal)).image) : apiImage(store, p, job, signal));
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json') || !uuid.test(file.slice(0, -5))) continue;
      let job; try { job = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')); } catch { continue; }
      if (!uuid.test(job.id)) continue;
      if (['queued', 'running'].includes(job.status)) { job.status = 'failed'; job.error = 'The gateway restarted before this task finished. Generate again to retry.'; job.finishedAt = new Date().toISOString(); this.save(job); }
      this.jobs.set(job.id, job);
    }
  }
  save(job) { const file = path.join(this.dir, job.id + '.json'); fs.writeFileSync(file + '.tmp', JSON.stringify(this.public(job)), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); }
  public(job) { const { references, ...safe } = job; return { ...safe, imageUrl: job.status === 'completed' ? '/api/image/files/' + job.id : null }; }
  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(job => this.public(job)); }
  get(id) { const job = uuid.test(id) && this.jobs.get(id); if (!job) throw new HttpError(404, 'Image task not found'); return job; }
  create(input) {
    const p = structuredClone(this.providers.get(input.providerId));
    if (!p.enabled) throw new HttpError(400, 'Image provider is disabled');
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt || prompt.length > (p.type === 'minimax' ? 1500 : 16000)) throw new HttpError(400, p.type === 'minimax' ? 'MiniMax prompts must contain 1–1500 characters' : 'Image prompts must contain 1–16000 characters');
    const aspect = input.aspect || '1:1';
    if (!Object.hasOwn(sizes, aspect)) throw new HttpError(400, 'Unsupported image aspect ratio');
    const references = input.references ?? [];
    if (!Array.isArray(references) || references.length > 3) throw new HttpError(400, '最多上传 3 张参考图');
    if (references.length && !p.supportsImageInput) throw new HttpError(400, '此服务商未启用图生图');
    const validated = references.map(value => {
      if (typeof value !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(value) || value.length > 7 * 1024 * 1024) throw new HttpError(400, '参考图必须为 PNG、JPEG 或 WebP，每张不超过 5 MB');
      let bytes, info;
      try { bytes = fromBase64(value); info = imageInfo(bytes); } catch { throw new HttpError(400, '参考图格式无效'); }
      if (bytes.length > 5 * 1024 * 1024 || !value.startsWith('data:' + info.mime + ';')) throw new HttpError(400, '参考图必须为 PNG、JPEG 或 WebP，每张不超过 5 MB');
      return 'data:' + info.mime + ';base64,' + bytes.toString('base64');
    });
    if (this.queue.length >= 20) throw new HttpError(429, 'Image queue is full. Wait for a task to finish.');
    const job = { id: crypto.randomUUID(), providerId: p.id, providerName: p.name, providerType: p.type, model: p.model, prompt, aspect,
      references: validated, referenceCount: validated.length, status: 'queued', createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job); this.save(job); this.queue.push({ p, job });
    queueMicrotask(() => this.pump()); return this.public(job);
  }
  async pump() {
    if (this.active) return; this.active = true;
    try {
      while (this.queue.length) {
        const { p, job } = this.queue.shift(), controller = new AbortController(); this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), (p.timeout + 20) * 1000);
        job.status = 'running'; job.startedAt = new Date().toISOString(); this.save(job);
        try {
          const bytes = await this.execute(p, job, controller.signal);
          if (controller.signal.aborted) throw problem('Image generation timed out');
          const info = imageInfo(bytes);
          fs.writeFileSync(path.join(this.dir, job.id + '.' + info.ext), bytes, { mode: 0o600, flag: 'wx' });
          Object.assign(job, info, { status: 'completed', bytes: bytes.length });
        } catch (e) {
          job.status = 'failed'; job.error = controller.signal.aborted ? 'Image generation timed out' : e instanceof HttpError ? e.message : 'Image generation failed. Check provider settings and network connectivity.';
        } finally {
          delete job.references; clearTimeout(timer); this.controllers.delete(controller); job.finishedAt = new Date().toISOString(); this.save(job);
        }
      }
    } finally { this.active = false; }
  }
  file(id) {
    const job = this.get(id);
    if (job.status !== 'completed' || !['png', 'jpg', 'webp'].includes(job.ext)) throw new HttpError(404, 'Image is not ready');
    const file = path.join(this.dir, job.id + '.' + job.ext);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Image file is missing');
    return { job, file };
  }
  async check(id) {
    const p = this.providers.get(id);
    if (p.type === 'grok') return grokRun(p, 'check', null, AbortSignal.timeout(45000));
    if (p.type !== 'codex') return { ok: true, verified: false, message: 'API settings saved. Click Generate to verify with a real image request.' };
    return codexRun(p, 'check', null, this.workRoot, AbortSignal.timeout(45000));
  }
  close() { for (const controller of this.controllers) controller.abort(); this.queue = []; }
}
