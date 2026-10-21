// G-01: separate video providers. No credentials are stored here; Grok uses CLI login.
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './store.js';
const fail = message => { throw new HttpError(400, message); };
const text = (value, max = 512) => {
  const result = String(value ?? '').trim();
  if (result.length > max || /[\x00-\x1f]/.test(result)) fail('Invalid video provider field');
  return result;
};
const absolute = value => path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
export class VideoProviders {
  constructor(store) { this.store = store; store.data.videoProviders ||= []; }
  list() { return this.store.data.videoProviders.map(p => this.store.publicProvider(p)); }
  get(id) {
    const p = this.store.data.videoProviders.find(p => p.id === id);
    if (!p) throw new HttpError(404, 'Video provider not found');
    return p;
  }
  upsert(input, oldId) {
    if (!input || typeof input !== 'object') fail('Invalid video provider settings');
    const id = oldId || text(input.id || 'video-' + crypto.randomBytes(5).toString('hex'), 40);
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) fail('Invalid video provider ID');
    const old = oldId ? this.get(oldId) : null;
    if (!old && this.store.data.videoProviders.some(p => p.id === id)) throw new HttpError(409, 'Video provider ID already exists');
    const type = input.type || 'grok';
    if (type !== 'grok') fail('Unknown video provider type');
    if (old && old.type !== type) fail('Existing video provider type cannot be changed');
    const p = {
      id, name: text(input.name, 80), type, enabled: input.enabled !== false,
      model: text(input.model || 'grok-4.7', 200), timeout: Number(input.timeout ?? old?.timeout ?? 900),
      updatedAt: new Date().toISOString()
    };
    if (!p.name) fail('Enter a video provider name');
    if (!Number.isInteger(p.timeout) || p.timeout < 30 || p.timeout > 1800) fail('Video timeout must be 30–1800 seconds');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(p.model)) fail('Invalid video model ID');
    p.execution = input.execution || old?.execution || 'ssh-docker';
    if (!['local', 'ssh', 'ssh-docker'].includes(p.execution)) fail('Invalid video execution mode');
    p.pythonPath = text(input.pythonPath || (process.platform === 'win32' && p.execution === 'local' ? 'python' : 'python3'));
    p.grokPath = text(input.grokPath || 'grok');
    if (p.grokPath !== 'grok' && !/^\/[A-Za-z0-9_./-]*\/grok$/.test(p.grokPath)) fail('Grok path must be grok or an absolute path ending in /grok');
    if (p.execution !== 'local') {
      p.runnerPath = text(input.runnerPath);
      if (!p.runnerPath.startsWith('/')) fail('Remote runner path must be absolute');
      p.sshHost = text(input.sshHost, 128); p.sshUser = text(input.sshUser, 64);
      p.sshPort = Number(input.sshPort || 22); p.sshKeyPath = text(input.sshKeyPath);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p.sshHost) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p.sshUser)) fail('Invalid SSH host or user');
      if (!Number.isInteger(p.sshPort) || p.sshPort < 1 || p.sshPort > 65535) fail('Invalid SSH port');
      if (!absolute(p.sshKeyPath)) fail('SSH key path must be absolute on the gateway server');
    }
    if (p.execution === 'ssh-docker') {
      p.container = text(input.container, 128); p.dockerPath = text(input.dockerPath || '/usr/local/bin/docker');
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p.container) || !/^\/[A-Za-z0-9_./-]+$/.test(p.dockerPath)) fail('Invalid Docker container or executable path');
    }
    if (old) this.store.data.videoProviders[this.store.data.videoProviders.indexOf(old)] = p;
    else this.store.data.videoProviders.push(p);
    this.store.save();
    return this.store.publicProvider(p);
  }
  remove(id) { this.get(id); this.store.data.videoProviders = this.store.data.videoProviders.filter(p => p.id !== id); this.store.save(); }
}
