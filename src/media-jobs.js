import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './store.js';

const active = job => ['queued', 'running'].includes(job.status);
export class MediaJobControls {
  initControls() {
    this.accepting = true; this.stopped = false; this.jobControllers = new Map(); this.cleanupPlans = new Map();
    this.referencesDir = path.join(this.dir, 'references');
    fs.mkdirSync(this.referencesDir, { recursive: true, mode: 0o700 });
    this.referenceTimer = setInterval(() => { try { this.expireReferences(); } catch { console.warn('Media reference cleanup failed'); } }, 3600000);
    this.referenceTimer.unref();
  }
  rememberReferences(job) {
    if (!job.references?.length) return;
    const file = path.join(this.referencesDir, job.id + '.json');
    fs.writeFileSync(file, JSON.stringify(job.references), { mode: 0o600, flag: 'wx' });
    job.referencesExpireAt = new Date(Date.now() + 7 * 86400000).toISOString();
  }
  expireReferences() {
    for (const job of this.jobs.values()) {
      if (active(job) || job.pinned || !job.referencesExpireAt || Date.parse(job.referencesExpireAt) > Date.now()) continue;
      fs.rmSync(path.join(this.referencesDir, job.id + '.json'), { force: true });
    }
  }
  assertAccepting() { if (!this.accepting) throw new HttpError(503, '服务正在准备重启，请稍后提交'); }
  page({ offset = 0, limit = 20 } = {}) {
    offset = Number(offset); limit = Number(limit);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, '分页参数无效');
    this.expireReferences();
    const all = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { jobs: all.slice(offset, offset + limit).map(job => this.public(job)), total: all.length, offset, limit, storage: this.storage() };
  }
  storage() {
    let bytes = 0, referenceBytes = 0;
    for (const name of fs.readdirSync(this.dir)) { const stat = fs.statSync(path.join(this.dir, name)); if (stat.isFile()) bytes += stat.size; }
    for (const name of fs.readdirSync(this.referencesDir)) referenceBytes += fs.statSync(path.join(this.referencesDir, name)).size;
    return { bytes: bytes + referenceBytes, referenceBytes, total: this.jobs.size, active: [...this.jobs.values()].filter(active).length, pinned: [...this.jobs.values()].filter(j => j.pinned).length };
  }
  cancel(id) {
    const job = this.get(id);
    if (!active(job)) return this.public(job);
    job.cancelRequested = true;
    this.queue = this.queue.filter(item => item.job.id !== id);
    this.jobControllers.get(id)?.abort(new Error('cancelled'));
    if (job.status === 'queued') { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); delete job.references; }
    this.save(job); return this.public(job);
  }
  retry(id) {
    this.assertAccepting();
    const job = this.get(id);
    if (active(job) || job.status === 'completed') throw new HttpError(409, '只有失败或取消的任务可以重试');
    if (job.retriedJobId && this.jobs.has(job.retriedJobId) && active(this.jobs.get(job.retriedJobId))) return this.public(this.jobs.get(job.retriedJobId));
    let references = [];
    if (job.referenceCount) {
      const file = path.join(this.referencesDir, id + '.json');
      if (!fs.existsSync(file)) throw new HttpError(409, '参考图已过期或未保存，请复用描述并重新上传参考图');
      references = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    const result = this.create({ providerId: job.providerId, prompt: job.prompt, aspect: job.aspect, duration: job.duration, resolution: job.resolution, references });
    job.retriedJobId = result.id; this.save(job); return result;
  }
  pin(id, pinned) {
    if (typeof pinned !== 'boolean') throw new HttpError(400, '保留设置必须为布尔值');
    const job = this.get(id); job.pinned = pinned; this.save(job); return this.public(job);
  }
  remove(id) {
    const job = this.get(id);
    if (active(job)) throw new HttpError(409, '请先取消任务并等待结束');
    if (job.pinned) throw new HttpError(409, '请先取消保留再删除');
    for (const ext of ['json', 'png', 'jpg', 'webp', 'mp4', 'webm']) fs.rmSync(path.join(this.dir, id + '.' + ext), { force: true });
    fs.rmSync(path.join(this.referencesDir, id + '.json'), { force: true });
    this.jobs.delete(id); return { deleted: true };
  }
  previewCleanup({ olderDays = 30, maxMiB = null } = {}) {
    olderDays = Number(olderDays);
    if (!Number.isFinite(olderDays) || olderDays < 0 || olderDays > 3650 || (maxMiB !== null && (!Number.isFinite(Number(maxMiB)) || Number(maxMiB) < 0))) throw new HttpError(400, '清理条件无效');
    const cutoff = Date.now() - olderDays * 86400000;
    const all = [...this.jobs.values()].filter(j => !active(j) && !j.pinned).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
    let bytes = this.storage().bytes, target = maxMiB === null ? Infinity : Number(maxMiB) * 1048576;
    const selected = [];
    for (const job of all) {
      if (Date.parse(job.createdAt) >= cutoff && bytes <= target) continue;
      let size = 0;
      for (const file of [path.join(this.dir, job.id + '.json'), ...(job.ext ? [path.join(this.dir, job.id + '.' + job.ext)] : []), path.join(this.referencesDir, job.id + '.json')]) {
        try { size += fs.statSync(file).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      selected.push({ id: job.id, createdAt: job.createdAt, bytes: size }); bytes -= size;
    }
    const token = crypto.randomUUID();
    this.cleanupPlans.set(token, { ids: selected.map(j => j.id), expires: Date.now() + 10 * 60000 });
    if (this.cleanupPlans.size > 20) this.cleanupPlans.delete(this.cleanupPlans.keys().next().value);
    return { token, jobs: selected, bytes: selected.reduce((n,j) => n+j.bytes,0), remainingBytes: bytes };
  }
  cleanup(token) {
    const plan = this.cleanupPlans.get(token);
    if (!plan || plan.expires < Date.now()) throw new HttpError(409, '清理预览已过期，请重新预览');
    const jobs = plan.ids.map(id => this.jobs.get(id)).filter(Boolean);
    if (jobs.some(j => active(j) || j.pinned)) throw new HttpError(409, '任务状态已变化，请重新预览');
    for (const job of jobs) this.remove(job.id);
    this.cleanupPlans.delete(token); return { deleted: jobs.length };
  }
  beginDrain() { this.accepting = false; }
  close() {
    this.accepting = false; this.stopped = true; clearInterval(this.referenceTimer);
    for (const job of this.jobs.values()) if (active(job)) {
      job.status = 'failed'; job.error = '服务重启中断了任务；结果尚未确认，请检查后手动重试。'; job.finishedAt = new Date().toISOString(); delete job.references; this.save(job);
    }
    for (const controller of this.controllers) controller.abort(new Error('shutdown'));
    this.queue = [];
  }
}
