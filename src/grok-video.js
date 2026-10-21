// G-02: Grok subscription video runner over SSH. Media is returned as a file, not a URL.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError } from './store.js';
export const grokVideoRunnerFile = fileURLToPath(new URL('./grok-video-runner.py', import.meta.url));
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const problem = message => new HttpError(502, message);
export const videoAspects = new Set(['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', 'auto']);
export const videoDurations = new Set([6, 10, 15]);
export const videoResolutions = new Set(['480p', '720p']);
 export function videoInfo(bytes, extension = '') {
  if (!Buffer.isBuffer(bytes) || bytes.length > 200 * 1024 * 1024) throw problem('Video exceeds 200 MB');
  const ext = String(extension).toLowerCase().replace(/^\./, '');
  const mp4 = bytes.length > 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  const webm = bytes.length > 4 && bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
  const mov = mp4 && /(qt|isom|mp4|M4V|avc1)/.test(bytes.toString('ascii', 8, Math.min(bytes.length, 20)).replace(/\0/g, ''));
  if (!mp4 && !webm) throw problem('The provider did not return an MP4 or WebM video');
  return { mime: webm ? 'video/webm' : 'video/mp4', ext: webm ? 'webm' : 'mp4', ...(ext && ['mp4', 'webm', 'mov'].includes(ext) ? { sourceExt: ext } : {}) };
}
export function grokVideoCommand(p, operation, id) {
  const tail = [p.pythonPath, p.execution === 'local' ? grokVideoRunnerFile : p.runnerPath, operation, ...(id ? [id] : [])];
  if (p.execution === 'local') return { command: tail[0], args: tail.slice(1) };
  const remote = p.execution === 'ssh-docker' ? ['sudo', '-n', p.dockerPath, 'exec', '-i', p.container, ...tail] : tail;
  return { command: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-p', String(p.sshPort), '-i', p.sshKeyPath, `${p.sshUser}@${p.sshHost}`, remote.map(quote).join(' ')] };
}
export async function grokVideoRun(p, operation, job, signal) {
  const { command, args } = grokVideoCommand(p, operation, job?.id);
  const body = JSON.stringify({ prompt: job?.prompt, references: job?.references || [], aspect: job?.aspect, duration: job?.duration, resolution: job?.resolution, timeout: p.timeout, model: p.model, grokPath: p.grokPath });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, signal });
    const chunks = []; let size = 0, exceeded = false;
    child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
    child.stdout.on('data', bytes => { size += bytes.length; if (size > 220 * 1024 * 1024) { exceeded = true; child.kill(); } else chunks.push(bytes); });
    child.on('error', () => reject(problem('Cannot start the Grok video runner. Check SSH, Python and executable paths.')));
    child.on('close', () => {
      if (exceeded) return reject(problem('Grok video runner output exceeds the size limit'));
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(problem('Grok video runner failed. Check SSH permissions, runner path and Grok login.')); }
      if (data.error) return reject(problem(String(data.error).slice(0, 1000)));
      resolve(data);
    });
    child.stdin.end(body);
  });
}
