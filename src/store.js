// F-02, R-02: single-user encrypted credential storage; atomic writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code = 'invalid_request_error') { super(message); this.status = status; this.code = code; }
}
export class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'config.json');
    const keyFile = path.join(dir, 'master.key');
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = fs.readFileSync(keyFile);
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
      version: 1, gatewayKey: this.seal('mh-' + crypto.randomBytes(24).toString('hex')), providers: []
    };
    this.save();
  }
  seal(value) {
    if (!value) return '';
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(x => x.toString('base64')).join('.');
  }
  unseal(value) {
    if (!value) return '';
    const [iv, tag, ciphertext] = value.split('.').map(x => Buffer.from(x, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  publicProvider(p) { const { apiKey, ...rest } = p; return { ...rest, hasApiKey: Boolean(apiKey) }; }
  list() { return this.data.providers.map(p => this.publicProvider(p)); }
  get(id) { const p = this.data.providers.find(p => p.id === id); if (!p) throw new HttpError(404, '供应商不存在'); return p; }
  upsert(input, oldId) {
    if (!input || typeof input !== 'object') throw new HttpError(400, '配置必须是对象');
    const id = String(input.id || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) throw new HttpError(400, '前缀只能包含小写字母、数字、下划线、短横线，最多 40 字符');
    if (oldId && oldId !== id) throw new HttpError(400, '已有供应商的前缀不可修改');
    const old = oldId ? this.get(oldId) : null;
    if (!old && this.data.providers.some(p => p.id === id)) throw new HttpError(409, '供应商前缀已存在');
    const type = input.type || 'openai';
    if (!['openai', 'nas-codex', 'claude-code'].includes(type)) throw new HttpError(400, '未知供应商类型');
    if (old && old.type !== type) throw new HttpError(400, '已有供应商的类型不可修改');
    const models = input.models ?? old?.models ?? [];
    if (!Array.isArray(models) || models.length > 2000 || models.some(m => typeof m !== 'string' || !m.trim() || m.length > 200 || /[\r\n\x00]/.test(m))) throw new HttpError(400, '模型列表应为有效模型 ID 数组（最多 2000 项）');
    const p = {
      id, name: String(input.name || id).trim().slice(0, 80), type,
      enabled: input.enabled !== false, models: [...new Set(models.map(m => m.trim()))],
      apiKey: input.clearApiKey ? '' : input.apiKey ? this.seal(String(input.apiKey)) : old?.apiKey || '',
      protocol: input.protocol || 'chat', timeout: Number(input.timeout ?? old?.timeout ?? (type === 'nas-codex' ? 600 : 180)),
      updatedAt: new Date().toISOString(), lastSync: old?.lastSync || null
    };
    if (!Number.isFinite(p.timeout) || p.timeout < 10 || p.timeout > 600) throw new HttpError(400, '超时应为 10–600 秒');
    if (!['chat', 'responses', 'both'].includes(p.protocol)) throw new HttpError(400, '无效的接口协议');
    const validateRemote = () => {
      p.execution = input.execution ?? old?.execution ?? 'ssh-docker';
      if (!['ssh', 'ssh-docker'].includes(p.execution)) throw new HttpError(400, '请选择 SSH 或 SSH + Docker 执行方式');
      for (const k of ['sshHost', 'sshUser', ...(p.execution === 'ssh-docker' ? ['container'] : [])]) {
        p[k] = String(input[k] ?? old?.[k] ?? '');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(p[k])) throw new HttpError(400, `${k} 格式不正确`);
      }
      p.sshPort = Number(input.sshPort ?? old?.sshPort ?? 22);
      if (!Number.isInteger(p.sshPort) || p.sshPort < 1 || p.sshPort > 65535) throw new HttpError(400, 'SSH 端口应为 1–65535');
      p.sshKeyPath = String(input.sshKeyPath ?? old?.sshKeyPath ?? '');
      if (!p.sshKeyPath || /[\r\n\x00]/.test(p.sshKeyPath)) throw new HttpError(400, '请输入 SSH 私钥绝对路径');
    };
    if (type === 'openai') {
      let url; try { url = new URL(input.baseUrl); } catch { throw new HttpError(400, '请输入有效的 API Base URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HttpError(400, 'API 地址只支持 HTTP/HTTPS，不应含认证、查询或片段');
      p.baseUrl = url.toString().replace(/\/+$/, '');
      if (/\/(models|responses|chat\/completions)$/.test(p.baseUrl)) throw new HttpError(400, '请输入 Base URL，例如 https://api.example.com/v1，不包含具体接口路径');
    } else if (type === 'nas-codex') {
      validateRemote();
      p.codexPath = String(input.codexPath ?? old?.codexPath ?? 'codex').trim();
      if (p.codexPath !== 'codex' && !/^\/[A-Za-z0-9_./ -]+$/.test(p.codexPath)) throw new HttpError(400, 'Codex 路径须为 codex 或目标主机/容器内的绝对路径');
      if (p.execution === 'ssh-docker') p.dockerPath = String(input.dockerPath ?? old?.dockerPath ?? '/usr/local/bin/docker').trim();
      if (p.dockerPath && !/^\/[A-Za-z0-9_./-]+$/.test(p.dockerPath)) throw new HttpError(400, 'Docker 命令须为目标主机上的绝对路径');
      p.protocol = 'chat';
    } else {
      validateRemote();
      p.claudePath = String(input.claudePath ?? old?.claudePath ?? 'claude').trim();
      if (p.claudePath !== 'claude' && !/^\/[A-Za-z0-9_./-]+$/.test(p.claudePath)) throw new HttpError(400, 'Claude Code 路径须为 claude 或目标主机/容器内的绝对路径');
      p.dockerPath = String(input.dockerPath ?? old?.dockerPath ?? '/usr/local/bin/docker').trim();
      if (!/^\/[A-Za-z0-9_./-]+$/.test(p.dockerPath)) throw new HttpError(400, 'Docker 命令须为目标主机上的绝对路径');
      p.protocol = 'chat';
    }
    if (old) this.data.providers[this.data.providers.indexOf(old)] = p; else this.data.providers.push(p);
    this.save(); return this.publicProvider(p);
  }
  remove(id) { this.get(id); this.data.providers = this.data.providers.filter(p => p.id !== id); this.save(); }
  setModels(id, models) {
    const p = this.get(id);
    if (!Array.isArray(models) || models.length > 2000 || models.some(m => typeof m !== 'string' || !m || m.length > 200 || /[\r\n\x00]/.test(m))) throw new HttpError(502, '上游返回的模型列表格式不正确');
    p.models = [...new Set(models)]; p.lastSync = new Date().toISOString(); this.save(); return this.publicProvider(p);
  }
  gatewayKey() { return this.unseal(this.data.gatewayKey); }
  models() {
    return this.data.providers.filter(p => p.enabled).flatMap(p => p.models.map(model => ({
      id: `${p.id}/${model}`, object: 'model', created: 0, owned_by: p.id,
      name: model, provider_name: p.name, source: p.type,
      capabilities: { tools: true, custom_tools: p.type === 'nas-codex' || p.type === 'claude-code' || p.protocol !== 'chat', text: true, cli_bridge: p.type === 'nas-codex' || p.type === 'claude-code' }
    })));
  }
  resolve(model) {
    if (typeof model !== 'string') throw new HttpError(400, '必须指定 model');
    for (const p of this.data.providers) {
      if (p.enabled && model.startsWith(p.id + '/') && p.models.includes(model.slice(p.id.length + 1))) return { provider: p, model: model.slice(p.id.length + 1) };
    }
    throw new HttpError(404, '模型不存在或供应商已停用，请从 /v1/models 选择模型', 'model_not_found');
  }
}
