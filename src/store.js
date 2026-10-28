// F-02, R-02: single-user encrypted credential storage; atomic writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tokenPolicy } from './api-token-policy.js';
import { normalizeNoProxy, parseProxyUrl } from './provider-proxy.js';
import { GROK_API_BASE_URL, GROK_CLI_BASE_URL, grokBaseAllowed } from './grok-config.js';

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
  publicProvider(p) { const { apiKey, proxyPassword, ...rest } = p; return { ...rest, hasApiKey: Boolean(apiKey || p.openCodeAuthId), hasProxyPassword: Boolean(proxyPassword), ...(p.type === 'grok' ? { grok: this.grokStatus(p) } : {}) }; }
  grokStatus(p) {
    if (p.grokAuthMode !== 'oauth') return { mode: 'apiKey', authorized: false };
    const sealed = p.grokAuthId ? this.data.grokAuth?.[p.grokAuthId] : '';
    if (!sealed) return { mode: 'oauth', authorized: false };
    try {
      const value = JSON.parse(this.unseal(sealed));
      if (value.invalid) return { mode: 'oauth', authorized: false, expired: true };
      return { mode: 'oauth', authorized: true, email: value.email || '', expiresAt: value.expires ? new Date(value.expires).toISOString() : null };
    } catch { return { mode: 'oauth', authorized: false }; }
  }
  list() { return this.data.providers.map(p => this.publicProvider(p)); }
  publicProxy(p) { const { password, ...rest } = p; return { ...rest, hasPassword: Boolean(password) }; }
  listProxies() { return (this.data.proxies || []).map(p => this.publicProxy(p)); }
  getProxy(id) {
    const proxy = (this.data.proxies || []).find(item => item.id === id);
    if (!proxy) throw new HttpError(404, '代理不存在');
    return proxy;
  }
  upsertProxy(input, oldId) {
    if (!input || typeof input !== 'object') throw new HttpError(400, '代理配置必须是对象');
    const id = String(input.id || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) throw new HttpError(400, '代理 ID 只能包含小写字母、数字、下划线、短横线，最多 40 字符');
    if (oldId && oldId !== id) throw new HttpError(400, '已有代理的 ID 不可修改');
    const old = oldId ? this.getProxy(oldId) : null;
    if (!old && (this.data.proxies || []).some(item => item.id === id)) throw new HttpError(409, '代理 ID 已存在');
    const url = parseProxyUrl(input.url ?? old?.url ?? '');
    if (url === null || !url) throw new HttpError(400, '代理地址只支持 HTTP/HTTPS，且不能包含账号、查询或片段');
    const username = String(input.username ?? old?.username ?? '').trim();
    if (username.length > 128 || /[\x00-\x1f\x7f]/.test(username)) throw new HttpError(400, '代理用户名应为 0–128 个可见字符');
    const password = input.clearPassword ? '' : input.password ? this.seal(String(input.password)) : old?.password || '';
    const noProxy = normalizeNoProxy(input.noProxy ?? old?.noProxy ?? []);
    if (noProxy === null) throw new HttpError(400, '直连例外应为逗号分隔的域名，最多 50 项');
    const proxy = {
      id, name: String(input.name || old?.name || id).trim().slice(0, 80), url, username, password, noProxy,
      enabled: input.enabled !== false, updatedAt: new Date().toISOString()
    };
    this.data.proxies ||= [];
    if (old) this.data.proxies[this.data.proxies.indexOf(old)] = proxy; else this.data.proxies.push(proxy);
    this.save();
    return this.publicProxy(proxy);
  }
  removeProxy(id) {
    const proxy = this.getProxy(id);
    const users = this.data.providers.filter(p => p.proxyId === id).map(p => p.id);
    if (users.length) throw new HttpError(409, `代理仍被供应商使用：${users.join('、')}`);
    this.data.proxies = this.data.proxies.filter(item => item !== proxy);
    this.save();
  }
  reorderProviders(ids) {
    const current = this.data.providers;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new HttpError(400, '供应商排序必须是不重复的 ID 数组');
    if (ids.length !== current.length || ids.some(id => !current.some(p => p.id === id))) throw new HttpError(409, '供应商列表已变化，请刷新后重新排序');
    this.data.providers = ids.map(id => current.find(p => p.id === id));
    try { this.save(); } catch (error) { this.data.providers = current; throw error; }
    return this.list();
  }
  get(id) { const p = this.data.providers.find(p => p.id === id); if (!p) throw new HttpError(404, '供应商不存在'); return p; }
  upsert(input, oldId) {
    if (!input || typeof input !== 'object') throw new HttpError(400, '配置必须是对象');
    const id = String(input.id || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) throw new HttpError(400, '前缀只能包含小写字母、数字、下划线、短横线，最多 40 字符');
    if (oldId && oldId !== id) throw new HttpError(400, '已有供应商的前缀不可修改');
    const old = oldId ? this.get(oldId) : null;
    if (!old && this.data.providers.some(p => p.id === id)) throw new HttpError(409, '供应商前缀已存在');
    const type = input.type || 'openai';
    if (!['openai', 'nas-codex', 'claude-code', 'grok-code', 'grok'].includes(type)) throw new HttpError(400, '未知供应商类型');
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
    const proxyUrl = parseProxyUrl(input.proxyUrl ?? old?.proxyUrl ?? '');
    if (proxyUrl === null) throw new HttpError(400, '代理地址只支持 HTTP/HTTPS，且不能包含账号、查询或片段');
    p.proxyUrl = proxyUrl;
    p.proxyUsername = String(input.proxyUsername ?? old?.proxyUsername ?? '').trim();
    if (p.proxyUsername.length > 128 || /[\x00-\x1f\x7f]/.test(p.proxyUsername)) throw new HttpError(400, '代理用户名应为 0–128 个可见字符');
    p.proxyPassword = input.clearProxyPassword ? '' : input.proxyPassword ? this.seal(String(input.proxyPassword)) : old?.proxyPassword || '';
    const noProxy = normalizeNoProxy(input.noProxy ?? old?.noProxy ?? []);
    if (noProxy === null) throw new HttpError(400, '直连例外应为逗号分隔的域名，最多 50 项');
    p.noProxy = noProxy;
    p.proxyEnabled = Boolean(input.proxyEnabled ?? old?.proxyEnabled) && Boolean(p.proxyUrl);
    p.proxyId = String(input.proxyId ?? old?.proxyId ?? '').trim();
    if (p.proxyId) {
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(p.proxyId)) throw new HttpError(400, '代理 ID 格式不正确');
      if (!(this.data.proxies || []).some(item => item.id === p.proxyId)) throw new HttpError(400, '所选代理不存在，请先在「代理」页面创建');
      p.proxyEnabled = false; p.proxyUrl = ''; p.proxyUsername = ''; p.proxyPassword = ''; p.noProxy = [];
    }
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
      p.tokenOptimization = tokenPolicy(input.tokenOptimization ?? old?.tokenOptimization);
      let url; try { url = new URL(input.baseUrl); } catch { throw new HttpError(400, '请输入有效的 API Base URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HttpError(400, 'API 地址只支持 HTTP/HTTPS，不应含认证、查询或片段');
      p.baseUrl = url.toString().replace(/\/+$/, '');
      // Only server-created OAuth references survive edits; changing the URL
      // or supplying a manual key detaches the account credential.
      if (old?.openCodeAuthId && !input.apiKey && !input.clearApiKey && p.baseUrl === old.baseUrl) p.openCodeAuthId = old.openCodeAuthId;
      if (/\/(models|responses|chat\/completions)$/.test(p.baseUrl)) throw new HttpError(400, '请输入 Base URL，例如 https://api.example.com/v1，不包含具体接口路径');
    } else if (type === 'nas-codex') {
      validateRemote();
      p.codexPath = String(input.codexPath ?? old?.codexPath ?? 'codex').trim();
      if (p.codexPath !== 'codex' && !/^\/[A-Za-z0-9_./ -]+$/.test(p.codexPath)) throw new HttpError(400, 'Codex 路径须为 codex 或目标主机/容器内的绝对路径');
      if (p.execution === 'ssh-docker') p.dockerPath = String(input.dockerPath ?? old?.dockerPath ?? '/usr/local/bin/docker').trim();
      if (p.dockerPath && !/^\/[A-Za-z0-9_./-]+$/.test(p.dockerPath)) throw new HttpError(400, 'Docker 命令须为目标主机上的绝对路径');
      p.protocol = 'chat';
    } else if (type === 'claude-code') {
      validateRemote();
      p.claudePath = String(input.claudePath ?? old?.claudePath ?? 'claude').trim();
      if (p.claudePath !== 'claude' && !/^\/[A-Za-z0-9_./-]+$/.test(p.claudePath)) throw new HttpError(400, 'Claude Code 路径须为 claude 或目标主机/容器内的绝对路径');
      p.dockerPath = String(input.dockerPath ?? old?.dockerPath ?? '/usr/local/bin/docker').trim();
      if (!/^\/[A-Za-z0-9_./-]+$/.test(p.dockerPath)) throw new HttpError(400, 'Docker 命令须为目标主机上的绝对路径');
      p.protocol = 'chat';
    } else if (type === 'grok') {
      p.grokAuthMode = String(input.grokAuthMode ?? old?.grokAuthMode ?? 'oauth');
      if (!['oauth', 'apiKey'].includes(p.grokAuthMode)) throw new HttpError(400, 'Grok 认证方式只能是 OAuth 或 API Key');
      const fallback = p.grokAuthMode === 'oauth' ? GROK_CLI_BASE_URL : GROK_API_BASE_URL;
      let url; try { url = new URL(String(input.baseUrl ?? old?.baseUrl ?? fallback)); } catch { throw new HttpError(400, '请输入有效的 Grok Base URL'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new HttpError(400, 'Grok Base URL 必须是 HTTPS，且不含认证、查询或片段');
      if (!grokBaseAllowed(url.hostname)) throw new HttpError(400, 'Grok Base URL 只能是 cli-chat-proxy.grok.com 或 api.x.ai');
      p.baseUrl = url.toString().replace(/\/+$/, '');
      if (/\/(models|responses|chat\/completions)$/.test(p.baseUrl)) throw new HttpError(400, '请输入 Base URL，例如 https://cli-chat-proxy.grok.com/v1');
      p.protocol = String(input.protocol ?? old?.protocol ?? 'both');
      if (!['chat', 'responses', 'both'].includes(p.protocol)) throw new HttpError(400, '无效的接口协议');
      p.tokenOptimization = tokenPolicy(input.tokenOptimization ?? old?.tokenOptimization);
      if (p.grokAuthMode === 'oauth') {
        p.apiKey = '';
        if (old?.grokAuthId && old.grokAuthMode === 'oauth') p.grokAuthId = old.grokAuthId;
      }
    } else {
      validateRemote();
      p.grokPath = String(input.grokPath ?? old?.grokPath ?? 'grok').trim();
      if (p.grokPath !== 'grok' && !/^\/[A-Za-z0-9_./-]*\/grok$/.test(p.grokPath)) throw new HttpError(400, 'Grok 路径须为 grok 或目标主机/容器内以 /grok 结尾的绝对路径');
      p.dockerPath = String(input.dockerPath ?? old?.dockerPath ?? '/usr/local/bin/docker').trim();
      if (!/^\/[A-Za-z0-9_./-]+$/.test(p.dockerPath)) throw new HttpError(400, 'Docker 命令须为目标主机上的绝对路径');
      p.protocol = 'chat';
    }
    if (old) this.data.providers[this.data.providers.indexOf(old)] = p; else this.data.providers.push(p);
    this.save(); return this.publicProvider(p);
  }
  remove(id) {
    const p = this.get(id);
    this.data.providers = this.data.providers.filter(item => item.id !== id);
    if (p.grokAuthId && this.data.grokAuth) delete this.data.grokAuth[p.grokAuthId];
    this.save();
  }
  setGrokAuth(id, authId) {
    const p = this.get(id);
    this.data.grokAuth ||= {};
    if (p.type !== 'grok') throw new HttpError(400, '仅 Grok 订阅供应商支持授权');
    if (p.grokAuthId && p.grokAuthId !== authId && this.data.grokAuth) delete this.data.grokAuth[p.grokAuthId];
    p.grokAuthId = authId;
    p.updatedAt = new Date().toISOString();
    this.save();
    return this.publicProvider(p);
  }
  readGrokPending() {
    if (!this.data.grokPending) return {};
    try { return JSON.parse(this.unseal(this.data.grokPending)); } catch { return {}; }
  }
  writeGrokPending(map) {
    this.data.grokPending = map && Object.keys(map).length ? this.seal(JSON.stringify(map)) : '';
    this.save();
  }
  clearGrokAuth(id) {
    const p = this.get(id);
    if (p.grokAuthId && this.data.grokAuth) delete this.data.grokAuth[p.grokAuthId];
    delete p.grokAuthId;
    this.save();
    return this.publicProvider(p);
  }
  setModels(id, models) {
    const p = this.get(id);
    if (!Array.isArray(models) || models.length > 2000 || models.some(m => typeof m !== 'string' || !m || m.length > 200 || /[\r\n\x00]/.test(m))) throw new HttpError(502, '上游返回的模型列表格式不正确');
    p.models = [...new Set(models)]; p.lastSync = new Date().toISOString(); this.save(); return this.publicProvider(p);
  }
  gatewayKey() { return this.unseal(this.data.gatewayKey); }

  // Provider groups: one public prefix over several Codex accounts.
  groups() { return (this.data.providerGroups ||= []); }
  groupState() { return (this.data.groupState ||= {}); }
  groupModels(g) {
    const seen = new Set();
    for (const id of g.members || []) {
      const p = this.data.providers.find(p => p.id === id);
      if (!p || !p.enabled) continue;
      for (const model of p.models) seen.add(model);
    }
    return [...seen];
  }
  publicGroup(g) {
    const now = Date.now();
    const members = (g.members || []).map(id => {
      const p = this.data.providers.find(p => p.id === id);
      const cd = this.data.groupState?.[g.id]?.[id];
      const cooling = Boolean(cd && cd.until > now);
      return { id, name: p?.name || id, enabled: Boolean(p?.enabled), container: p?.container || null, cooling, until: cooling ? cd.until : null, reason: cooling ? cd.reason || cd.kind || null : null };
    });
    return { ...g, members, modelIds: this.groupModels(g) };
  }
  listGroups() { return this.groups().map(g => this.publicGroup(g)); }
  getGroup(id) { const g = this.groups().find(g => g.id === id); if (!g) throw new HttpError(404, '供应商组不存在'); return g; }
  upsertGroup(input, oldId) {
    if (!input || typeof input !== 'object') throw new HttpError(400, '配置必须是对象');
    const id = String(input.id || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) throw new HttpError(400, '组前缀只能包含小写字母、数字、下划线、短横线，最多 40 字符');
    if (oldId && oldId !== id) throw new HttpError(400, '已有组的前缀不可修改');
    const old = oldId ? this.getGroup(oldId) : null;
    if (!old && this.groups().some(g => g.id === id)) throw new HttpError(409, '组前缀已存在');
    if (this.data.providers.some(p => p.id === id)) throw new HttpError(409, '组前缀不能与供应商前缀相同');
    const members = input.members ?? old?.members ?? [];
    if (!Array.isArray(members) || !members.length || members.length > 10) throw new HttpError(400, '请选择 1–10 个 Codex 供应商');
    const unique = [...new Set(members.map(m => String(m)))];
    if (unique.length !== members.length) throw new HttpError(400, '组内供应商不能重复');
    for (const mid of unique) {
      const p = this.data.providers.find(p => p.id === mid);
      if (!p) throw new HttpError(400, `供应商 ${mid} 不存在`);
      if (p.type !== 'nas-codex') throw new HttpError(400, `供应商 ${mid} 不是 Codex 供应商`);
    }
    const g = {
      id,
      name: String(input.name || old?.name || id).trim().slice(0, 80) || id,
      enabled: input.enabled !== false,
      hideMembers: input.hideMembers !== false,
      members: unique,
      updatedAt: new Date().toISOString()
    };
    if (old) this.groups()[this.groups().indexOf(old)] = g; else this.groups().push(g);
    this.save(); return this.publicGroup(g);
  }
  removeGroup(id) {
    this.getGroup(id);
    this.data.providerGroups = this.groups().filter(g => g.id !== id);
    if (this.data.groupState) delete this.data.groupState[id];
    this.save();
  }
  groupCooldown(groupId, providerId) {
    const cd = this.data.groupState?.[groupId]?.[providerId];
    return cd && Number(cd.until) > Date.now() ? cd : null;
  }
  setGroupCooldown(groupId, providerId, value) {
    const state = this.groupState();
    (state[groupId] ||= {})[providerId] = value;
    this.save();
  }
  clearGroupCooldown(groupId, providerId) {
    const state = this.data.groupState?.[groupId];
    if (!state || !state[providerId]) return;
    delete state[providerId];
    if (!Object.keys(state).length) delete this.data.groupState[groupId];
    this.save();
  }
  clearGroupCooldowns(groupId) {
    if (this.data.groupState?.[groupId]) { delete this.data.groupState[groupId]; this.save(); }
  }
  models() {
    const groups = this.groups().filter(g => g.enabled);
    const hidden = new Set();
    for (const g of groups) if (g.hideMembers !== false) for (const id of g.members || []) hidden.add(id);
    const out = [];
    for (const g of groups) {
      for (const model of this.groupModels(g)) out.push({
        id: `${g.id}/${model}`, object: 'model', created: 0, owned_by: g.id,
        name: model, provider_name: g.name, source: 'codex-group',
        capabilities: { tools: true, custom_tools: true, text: true, cli_bridge: true, group: true, members: g.members.length }
      });
    }
    for (const p of this.data.providers) {
      if (!p.enabled || hidden.has(p.id)) continue;
      for (const model of p.models) out.push({
        id: `${p.id}/${model}`, object: 'model', created: 0, owned_by: p.id,
        name: model, provider_name: p.name, source: p.type,
        capabilities: { tools: true, custom_tools: p.type === 'nas-codex' || p.type === 'claude-code' || p.type === 'grok-code' || p.protocol !== 'chat', text: true, cli_bridge: p.type === 'nas-codex' || p.type === 'claude-code' || p.type === 'grok-code' }
      });
    }
    return out;
  }
  resolve(model) {
    if (typeof model !== 'string') throw new HttpError(400, '必须指定 model');
    for (const g of this.groups()) {
      if (!g.enabled || !model.startsWith(g.id + '/')) continue;
      const name = model.slice(g.id.length + 1);
      if (!this.groupModels(g).includes(name)) continue;
      const candidates = [];
      for (const id of g.members || []) {
        const p = this.data.providers.find(p => p.id === id);
        if (p && p.enabled && p.models.includes(name)) candidates.push({ provider: p, model: name });
      }
      if (candidates.length) return { group: g, model: name, provider: candidates[0].provider, candidates };
    }
    for (const p of this.data.providers) {
      if (p.enabled && model.startsWith(p.id + '/') && p.models.includes(model.slice(p.id.length + 1))) return { provider: p, model: model.slice(p.id.length + 1) };
    }
    throw new HttpError(404, '模型不存在或供应商已停用，请从 /v1/models 选择模型', 'model_not_found');
  }
}