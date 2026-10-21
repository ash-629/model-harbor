// G-03: durable Grok video jobs and bounded local output storage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './store.js';
import { fromBase64 } from './images.js';
import { grokVideoRun, videoInfo, videoAspects, videoDurations, videoResolutions } from './grok-video.js';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class VideoJobs {
  constructor(store, providers, dir, { execute } = {}) {
    this.store = store; this.providers = providers; this.dir = path.join(dir, 'videos');
    this.jobs = new Map(); this.queue = []; this.active = false; this.controllers = new Set();
    this.execute = execute || (async (p, job, signal) => {
      const data = await grokVideoRun(p, 'generate', job, signal);
      const bytes = Buffer.from(String(data.video || ''), 'base64');
      videoInfo(bytes, data.ext);
      return { bytes, ext: data.ext || 'mp4' };
    });
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json') || !uuid.test(file.slice(0, -5))) continue;
      let job; try { job = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')); } catch { continue; }
      if (!uuid.test(job.id)) continue;
      if (['queued', 'running'].includes(job.status)) {
        job.status = 'failed'; job.error = 'The gateway restarted before this task finished. Generate again to retry.'; job.finishedAt = new Date().toISOString(); this.save(job);
      }
      this.jobs.set(job.id, job);
    }
  }
  save(job) { const file = path.join(this.dir, job.id + '.json'); fs.writeFileSync(file + '.tmp', JSON.stringify(this.public(job)), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); }
  public(job) { const { references, ...safe } = job; return { ...safe, videoUrl: job.status === 'completed' ? '/api/video/files/' + job.id : null }; }
  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(job => this.public(job)); }
  get(id) { const job = uuid.test(id) && this.jobs.get(id); if (!job) throw new HttpError(404, 'Video task not found'); return job; }
  create(input) {
    const p = structuredClone(this.providers.get(input.providerId));
    if (!p.enabled) throw new HttpError(400, 'Video provider is disabled');
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt || prompt.length > 16000) throw new HttpError(400, 'Video prompts must contain 1–16000 characters');
    const aspect = input.aspect || '16:9';
    if (!videoAspects.has(aspect)) throw new HttpError(400, 'Unsupported video aspect ratio');
    const duration = Number(input.duration ?? 6), resolution = String(input.resolution ?? '480p');
    if (!videoDurations.has(duration)) throw new HttpError(400, 'Unsupported video duration');
    if (!videoResolutions.has(resolution)) throw new HttpError(400, 'Unsupported video resolution');
    const references = input.references ?? [];
    if (!Array.isArray(references) || references.length > 3) throw new HttpError(400, '最多上传 3 张参考图');
    const validated = references.map(value => {
      if (typeof value !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(value) || value.length > 7 * 1024 * 1024) throw new HttpError(400, '参考图必须为 PNG、JPEG 或 WebP，每张不超过 5 MB');
      let bytes, info;
      try { bytes = fromBase64(value); info = imageInfoForReference(bytes); } catch { throw new HttpError(400, '参考图格式无效'); }
      if (bytes.length > 5 * 1024 * 1024 || !value.startsWith('data:' + info.mime + ';')) throw new HttpError(400, '参考图必须为 PNG、JPEG 或 WebP，每张不超过 5 MB');
      return 'data:' + info.mime + ';base64,' + bytes.toString('base64');
    });
    if (this.queue.length >= 10) throw new HttpError(429, 'Video queue is full. Wait for a task to finish.');
    const job = { id: crypto.randomUUID(), providerId: p.id, providerName: p.name, providerType: p.type, model: p.model, prompt, aspect, duration, resolution,
      references: validated, referenceCount: validated.length, status: 'queued', createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job); this.save(job); this.queue.push({ p, job }); queueMicrotask(() => this.pump()); return this.public(job);
  }
  async pump() {
    if (this.active) return; this.active = true;
    try {
      while (this.queue.length) {
        const { p, job } = this.queue.shift(), controller = new AbortController(); this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), (p.timeout + 20) * 1000);
        job.status = 'running'; job.startedAt = new Date().toISOString(); this.save(job);
        try {
          const output = await this.execute(p, job, controller.signal);
          if (controller.signal.aborted) throw new HttpError(504, 'Video generation timed out');
          const info = videoInfo(output.bytes, output.ext);
          fs.writeFileSync(path.join(this.dir, job.id + '.' + info.ext), output.bytes, { mode: 0o600, flag: 'wx' });
          Object.assign(job, info, { status: 'completed', bytes: output.bytes.length });
        } catch (e) {
          job.status = 'failed'; job.error = controller.signal.aborted ? 'Video generation timed out' : e instanceof HttpError ? e.message : 'Video generation failed. Check provider settings and network connectivity.';
        } finally {
          delete job.references; clearTimeout(timer); this.controllers.delete(controller); job.finishedAt = new Date().toISOString(); this.save(job);
        }
      }
    } finally { this.active = false; }
  }
  file(id) {
    const job = this.get(id);
    if (job.status !== 'completed' || !['mp4', 'webm'].includes(job.ext)) throw new HttpError(404, 'Video is not ready');
    const file = path.join(this.dir, job.id + '.' + job.ext);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Video file is missing');
    return { job, file };
  }
  async check(id) {
    const p = this.providers.get(id);
    return grokVideoRun(p, 'check', null, AbortSignal.timeout(45000));
  }
  close() { for (const controller of this.controllers) controller.abort(); this.queue = []; }
}
function imageInfoForReference(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mime: 'image/png' };
  if (bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg' };
  if (bytes.length > 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp' };
  throw new Error('invalid image');
}
