// I-02/I-04: separate image providers, encrypted keys and typed execution settings.
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './store.js';

const fail = message => { throw new HttpError(400, message); };
const text = (value, max = 512) => {
  const result = String(value ?? '').trim();
  if (result.length > max || /[\x00-\x1f]/.test(result)) fail('Invalid image provider field');
  return result;
};
export const absolute = value => path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
export class ImageProviders {
  constructor(store) { this.store = store; store.data.imageProviders ||= []; }
  list() { return this.store.data.imageProviders.map(p => this.store.publicProvider(p)); }
  get(id) {
    const p = this.store.data.imageProviders.find(p => p.id === id);
    if (!p) throw new HttpError(404, 'Image provider not found');
    return p;
  }
  upsert(input, oldId) {
    const id = oldId || text(input.id || 'img-' + crypto.randomBytes(5).toString('hex'), 40);
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) fail('Invalid image provider ID');
    const old = oldId ? this.get(oldId) : null;
    if (!old && this.store.data.imageProviders.some(p => p.id === id)) throw new HttpError(409, 'Image provider ID already exists');
    const type = input.type || 'openai';
    if (!['openai', 'minimax', 'codex'].includes(type)) fail('Unknown image provider type');
    if (old && old.type !== type) fail('Existing image provider type cannot be changed');
    if (input.supportsImageInput !== undefined && typeof input.supportsImageInput !== 'boolean') fail('Invalid image input capability');
    const p = { supportsImageInput: input.supportsImageInput ?? old?.supportsImageInput ?? false, id, name: text(input.name, 80), type, enabled: input.enabled !== false,
      model: text(input.model, 200), timeout: Number(input.timeout ?? 900), updatedAt: new Date().toISOString() };
    if (!p.name) fail('Enter an image provider name');
    if (!Number.isInteger(p.timeout) || p.timeout < 30 || p.timeout > 1800) fail('Image timeout must be 30–1800 seconds');
    if (p.model && !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(p.model)) fail('Invalid image model ID');
    if (type !== 'codex') {
      if (!p.model) fail('Enter an image model ID');
      let url; try { url = new URL(input.baseUrl); } catch { fail('Enter a valid image API base URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('Image API URL must use HTTP/HTTPS without credentials or query parameters');
      p.baseUrl = url.href.replace(/\/+$/, '');
      if (/\/(images\/generations|image_generation)$/.test(p.baseUrl)) fail('Enter the base URL without the image endpoint path');
      p.apiKey = input.clearApiKey ? '' : input.apiKey ? this.store.seal(text(input.apiKey, 4096)) : old?.apiKey || '';
    } else {
      p.execution = input.execution || 'local';
      if (!['local', 'ssh', 'ssh-docker'].includes(p.execution)) fail('Invalid Codex execution mode');
      p.pythonPath = text(input.pythonPath || (process.platform === 'win32' && p.execution === 'local' ? 'python' : 'python3'));
      p.codexPath = text(input.codexPath || 'codex');
      p.sandbox = input.sandbox || 'workspace-write';
      if (!['workspace-write', 'danger-full-access'].includes(p.sandbox)) fail('Invalid Codex sandbox setting');
      if (p.sandbox === 'danger-full-access' && p.execution !== 'ssh-docker') fail('Container isolation mode requires SSH + Docker execution');
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
    }
    if (old) this.store.data.imageProviders[this.store.data.imageProviders.indexOf(old)] = p;
    else this.store.data.imageProviders.push(p);
    this.store.save();
    return this.store.publicProvider(p);
  }
  remove(id) { this.get(id); this.store.data.imageProviders = this.store.data.imageProviders.filter(p => p.id !== id); this.store.save(); }
}
