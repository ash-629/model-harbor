// F-07: tool package catalog, update checks and background downloads.
// ChatGPT is resolved from its fixed Microsoft Store product ID. Downloads are
// streamed to data/tools/chatgpt by a Python helper that can use the OpenWrt proxy.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HttpError } from './store.js';

const execFileAsync = promisify(execFile);
const helperFile = fileURLToPath(new URL('./tool-downloader.py', import.meta.url));
const VERSION_RE = /^[0-9][0-9A-Za-z.-]{0,80}$/;
const FILE_RE = /^chatgpt-desktop-([0-9][0-9A-Za-z.-]*)-x64\.msix$/;

export function compareVersions(left, right) {
  const parts = value => String(value || '').split(/[._-]/).map(piece => /^\d+$/.test(piece) ? Number(piece) : 0);
  const a = parts(left), b = parts(right), length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function safeError(error) {
  const message = String(error?.message || error || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return message.slice(0, 400) || '工具更新失败';
}

function parseJsonLines(buffer, onValue) {
  let start = 0;
  for (;;) {
    const end = buffer.indexOf('\n', start);
    if (end < 0) return buffer.slice(start);
    const line = buffer.slice(start, end).trim(); start = end + 1;
    if (!line) continue;
    try { onValue(JSON.parse(line)); } catch { /* helper diagnostics never become page content */ }
  }
}

export class ToolDownloads {
  constructor(dataDir, { scriptPath = helperFile, pythonPath = process.env.PYTHON_PATH || 'python3', env = process.env } = {}) {
    this.root = path.join(dataDir, 'tools', 'chatgpt');
    this.scriptPath = scriptPath;
    this.pythonPath = pythonPath;
    this.proxyConfigured = Boolean(env.MH_TOOL_PROXY || env.TOOL_DOWNLOAD_PROXY);
    this.helperEnv = { ...env };
    this.stateFile = path.join(this.root, 'state.json');
    this.job = null;
    this.checking = false;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(this.root)) if (name.endsWith('.part')) {
      try { fs.rmSync(path.join(this.root, name), { force: true }); } catch {}
    }
    this.state = this.loadState();
    this.installed = this.findInstalled();
  }

  loadState() {
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return value && typeof value === 'object' ? value : {};
    } catch { return {}; }
  }

  saveState() {
    const value = {
      checkedAt: this.state.checkedAt || null,
      latestVersion: this.state.latestVersion || null,
      status: this.state.status || 'idle',
      lastError: this.state.lastError || null
    };
    fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(this.stateFile + '.tmp', this.stateFile);
    this.state = value;
  }

  findInstalled() {
    let best = null;
    for (const name of fs.readdirSync(this.root)) {
      const match = FILE_RE.exec(name); if (!match) continue;
      const file = path.join(this.root, name), stat = fs.statSync(file);
      const item = { file, name, version: match[1], bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
      if (!best || compareVersions(item.version, best.version) > 0) best = item;
    }
    return best;
  }

  updateAvailable() {
    if (!this.installed || !this.state.latestVersion) return false;
    return compareVersions(this.state.latestVersion, this.installed.version) > 0;
  }

  status() {
    if (this.job && !this.job.done) return this.job.status;
    if (this.checking) return 'checking';
    if (this.state.status === 'downloading' || this.state.status === 'checking') return 'idle';
    return this.state.status || 'idle';
  }

  publicTool() {
    const progress = this.job && !this.job.done ? this.job.progress : null;
    return {
      id: 'chatgpt',
      name: 'ChatGPT 桌面端',
      platform: 'Windows · x64',
      source: 'Microsoft Store · OpenAI',
      installedVersion: this.installed?.version || null,
      latestVersion: this.state.latestVersion || null,
      updateAvailable: this.updateAvailable(),
      checkedAt: this.state.checkedAt || null,
      status: this.status(),
      progress: progress || null,
      bytes: this.installed?.bytes || this.job?.bytes || 0,
      fileName: this.installed?.name || null,
      downloadUrl: this.installed ? '/api/tools/chatgpt/download' : null,
      proxyConfigured: this.proxyConfigured,
      error: this.state.lastError || null
    };
  }

  list() { return [this.publicTool()]; }

  async check() {
    if (this.job && !this.job.done) return this.publicTool();
    if (this.checking) return this.publicTool();
    this.checking = true;
    this.state.lastError = null;
    this.state.status = 'checking';
    try {
      const { stdout } = await execFileAsync(this.pythonPath, [this.scriptPath, 'check'], {
        env: this.helperEnv, timeout: 70000, maxBuffer: 2 * 1024 * 1024
      });
      let result;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed.type === 'check') result = parsed;
        if (parsed.type === 'error') throw new Error(String(parsed.message || '版本查询失败'));
      }
      if (!result || !VERSION_RE.test(result.version) || typeof result.url !== 'string') throw new Error('版本查询没有返回有效结果');
      if (result.sha1 && !/^[0-9a-f]{40}$/i.test(result.sha1)) throw new Error('版本查询返回的校验值无效');
      this.state.latestVersion = result.version;
      this.state.checkedAt = new Date().toISOString();
      this.state.lastError = null;
      if (this.installed && compareVersions(this.installed.version, result.version) >= 0) {
        this.state.status = 'up_to_date';
        this.saveState();
        this.checking = false;
        return this.publicTool();
      }
      this.startDownload(result);
      this.state.status = 'downloading';
      this.saveState();
      this.checking = false;
      return this.publicTool();
    } catch (error) {
      this.state.status = 'error';
      this.state.lastError = safeError(error);
      this.saveState();
      this.checking = false;
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, this.state.lastError, 'tool_update_failed');
    } finally {
      this.checking = false;
    }
  }

  startDownload(meta) {
    const name = `chatgpt-desktop-${meta.version}-x64.msix`;
    const file = path.join(this.root, name);
    const job = this.job = { status: 'downloading', done: false, progress: { percent: 0, received: 0, total: 0 }, bytes: 0, output: '' };
    let complete = false;
    const child = spawn(this.pythonPath, [this.scriptPath, 'download'], { env: this.helperEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    job.child = child;
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ url: meta.url, version: meta.version, output: file, sha1: meta.sha1 || '' }));
    const onLine = value => {
      if (value.type === 'progress') job.progress = { percent: Number(value.percent) || 0, received: Number(value.received) || 0, total: Number(value.total) || 0 };
      if (value.type === 'complete') {
        complete = true;
        job.status = 'done'; job.done = true; job.progress = { percent: 100, received: value.bytes, total: value.bytes };
        this.installed = { file, name, version: meta.version, bytes: value.bytes, modifiedAt: new Date().toISOString() };
        for (const old of fs.readdirSync(this.root)) if (FILE_RE.test(old) && old !== name) { try { fs.rmSync(path.join(this.root, old), { force: true }); } catch {} }
        this.state.status = 'up_to_date'; this.state.lastError = null; this.saveState();
      }
      if (value.type === 'error') { job.error = safeError(value.message); }
    };
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout = parseJsonLines(stdout + chunk.toString('utf8'), onLine); });
    child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk.toString('utf8'); });
    child.on('error', error => {
      job.done = true; job.status = 'error'; job.error = safeError(error.message);
      this.state.status = 'error'; this.state.lastError = job.error; this.saveState();
    });
    child.on('close', code => {
      if (!complete && !job.done) {
        job.done = true; job.status = 'error';
        job.error = job.error || safeError(stderr || (code ? `下载进程退出码 ${code}` : '下载未完成'));
        this.state.status = 'error'; this.state.lastError = job.error; this.saveState();
      }
    });
  }

  file() {
    if (!this.installed) throw new HttpError(404, '还没有可下载的安装包');
    const resolved = path.resolve(this.installed.file);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep) || !fs.existsSync(resolved)) throw new HttpError(404, '安装包不存在');
    return { file: resolved, name: this.installed.name };
  }

  close() {
    if (this.job?.child && !this.job.done) { try { this.job.child.kill('SIGTERM'); } catch {} }
  }
}
