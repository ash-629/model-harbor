import fs from 'node:fs';
import { HttpError } from './store.js';

// Bearer-authenticated client access; deliberately excludes provider administration.
export async function mediaAPI({ pathname, method, url, req, res, imageProviders, videoProviders, imageJobs, videoJobs, json, readBody }) {
  const match = /^\/v1\/media\/(image|video)\/(providers|jobs|jobs\/([a-f0-9-]{36})|files\/([a-f0-9-]{36}))$/.exec(pathname);
  if (!match) throw new HttpError(404, '媒体接口不存在');
  const [, kind, action, jobId, fileId] = match;
  const providers = kind === 'image' ? imageProviders : videoProviders;
  const jobs = kind === 'image' ? imageJobs : videoJobs;
  const view = job => {
    const safe = jobs.public(job);
    const field = kind === 'image' ? 'imageUrl' : 'videoUrl';
    safe[field] = safe.status === 'completed' ? `/v1/media/${kind}/files/${safe.id}` : null;
    return safe;
  };
  if (action === 'providers' && method === 'GET') return json(res, 200, { providers: providers.list().filter(p => p.enabled).map(({ id, name, type, supportsImageInput }) => ({ id, name, type, supportsImageInput })) });
  if (action === 'jobs' && method === 'POST') return json(res, 202, view(jobs.create(await readBody(req, 22 * 1024 * 1024))));
  if (jobId && method === 'GET') return json(res, 200, view(jobs.get(jobId)));
  if (fileId && method === 'GET') {
    const { file, job } = jobs.file(fileId);
    res.writeHead(200, { 'content-type': job.mime, 'content-length': fs.statSync(file).size, 'content-disposition': `attachment; filename="model-harbor-${job.id}.${job.ext}"` });
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
  }
  throw new HttpError(405, '不支持此媒体操作');
}
