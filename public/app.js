import { createImageUI } from './image-ui.js';
import { t, getLanguage, setLanguage, captureStaticText, translateError } from './i18n.js';
// P-01/P-02: provider CRUD, model directory, connection instructions, real request test.
const $ = id => document.getElementById(id);
const h = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
let csrf, state = { providers: [], models: [], logs: [] }, editing = null, busy = false, testBusy = false, keyVisible = false, connectionKey = '';
let toastTimer, currentView = 'overview', saving = false, refreshing = false;
const translateStatic = captureStaticText();
const errorsById = new Map();
let testResult = null, connectionProtocol = 'anthropic';
const imageUI = createImageUI({api, toast});
const usageById = new Map();
const resetKeys = new Map();
let resetProvider = null, resetBusy = false;
function pendingResetKey(id) {
  try { const key = localStorage.getItem('mh_reset_' + id); if (key) resetKeys.set(id, key); else resetKeys.delete(id); } catch {}
  return resetKeys.get(id);
}
function storeResetKey(id, key) {
  if (key) resetKeys.set(id, key); else resetKeys.delete(id);
  try { if (key) localStorage.setItem('mh_reset_' + id, key); else localStorage.removeItem('mh_reset_' + id); } catch {}
}
function newResetKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function resetLabel() { return resetBusy ? t('正在重置…') : resetProvider && pendingResetKey(resetProvider) ? t('重试同一次重置') : t('确认并重置'); }
function openReset(id) {
  if (busy || usageById.get(id)?.loading) return;
  const p = state.providers.find(p => p.id === id), data = usageById.get(id)?.data;
  if (!p || (!(data?.resetCredits > 0) && !pendingResetKey(id))) return;
  resetProvider = id; $('reset-provider-name').textContent = p.name; errorBox('reset-error');
  $('reset-confirm').textContent = resetLabel(); $('reset-dialog').showModal();
}
$('reset-cancel').addEventListener('click', () => { if (!resetBusy) $('reset-dialog').close(); });
$('reset-dialog').addEventListener('cancel', event => { if (resetBusy) event.preventDefault(); });
$('reset-confirm').addEventListener('click', async () => {
  if (!resetProvider || resetBusy || busy) return;
  const id = resetProvider, key = pendingResetKey(id) || newResetKey(); storeResetKey(id, key);
  resetBusy = true; busy = true; $('reset-confirm').disabled = true; $('reset-cancel').disabled = true;
  $('reset-confirm').textContent = resetLabel(); errorBox('reset-error'); renderProviders();
  try {
    const result = await api('/providers/' + id + '/reset', {method:'POST', body:JSON.stringify({confirmed:true, idempotencyKey:key})});
    storeResetKey(id, null); usageById.clear();
    usageById.set(id, result.usage ? {data:result.usage} : {error:t('重置结果已返回，但用量刷新失败，请点击刷新用量。')});
    const outcomes = {reset:'额度已重置', alreadyRedeemed:'本次操作已完成，未重复消耗次数', nothingToReset:'当前没有可重置的额度窗口', noCredit:'没有可用的重置次数'};
    toast(t(outcomes[result.outcome])); $('reset-dialog').close();
  } catch (e) { errorBox('reset-error', e.message); }
  finally { resetBusy = false; busy = false; $('reset-confirm').disabled = false; $('reset-cancel').disabled = false; $('reset-confirm').textContent = resetLabel(); renderProviders(); }
});
function usageWindow(window) {
  const label = window.durationMins === 300 ? t('5 小时用量') : window.durationMins === 10080 ? t('每周用量') : window.durationMins ? t('{minutes} 分钟用量', {minutes:window.durationMins}) : t('用量窗口');
  const percent = value => Math.round(value * 10) / 10;
  const known = window.usedPercent !== null && window.usedPercent !== undefined;
  const reset = window.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString(getLanguage()) : t('暂不可用');
  return `<div class="quota-window"><div class="quota-row"><strong>${h(label)}</strong><span>${known ? h(t('已用 {percent}%', {percent:percent(window.usedPercent)})) : t('暂不可用')}</span></div>${known ? `<progress max="100" value="${window.usedPercent}" aria-label="${h(label)}"></progress><div class="quota-detail">${h(t('剩余 {percent}%', {percent:percent(window.remainingPercent)}))}</div>` : ''}<div class="quota-detail">${h(t('下次重置：{time}', {time:reset}))}</div></div>`;
}
function usageMarkup(p) {
  if (p.type !== 'nas-codex') return '';
  const usage = usageById.get(p.id), data = usage?.data;
  let body = '';
  if (data) {
    const buckets = data.buckets.length ? data.buckets : [{id:'codex', windows:[]}];
    body = buckets.map(bucket => {
      const windows = [...bucket.windows];
      for (const durationMins of [300, 10080]) if (!windows.some(w => w.durationMins === durationMins)) windows.push({durationMins, usedPercent:null});
      windows.sort((a,b) => (a.durationMins || Infinity) - (b.durationMins || Infinity));
      return `<div class="quota-bucket">${buckets.length > 1 || bucket.planType ? `<div class="quota-detail">${h(bucket.name || (bucket.id === 'codex' ? t('默认额度') : bucket.id))}${bucket.planType ? ' · ' + h(bucket.planType) : ''}</div>` : ''}${windows.map(usageWindow).join('')}</div>`;
    }).join('');
    body += `<div class="quota-row quota-resets"><strong>${t('剩余重置次数')}</strong><span>${data.resetCredits === null ? t('暂不可用') : h(t('{count} 次', {count:data.resetCredits}))}</span></div><div class="quota-detail">${h(t('更新于 {time}', {time:new Date(data.checkedAt).toLocaleTimeString(getLanguage())}))}</div><div class="quota-detail">${t('同一账号额度共享；数据最多缓存 30 秒。')}</div>`;
  }
  body += `<button class="button secondary quota-reset-button" data-reset-usage="${h(p.id)}" ${busy || usage?.loading || (!(data?.resetCredits > 0) && !pendingResetKey(p.id)) ? 'disabled' : ''}>${pendingResetKey(p.id) ? t('重试同一次重置') : t('重置额度')}</button>`;
  if (usage?.error) body = `<div class="notice error" role="alert">${h(translateError(usage.error))}</div>` + body;
  return `<section class="provider-quota"><div class="quota-row"><strong>${t('Codex 账号用量')}</strong><button class="button ghost" data-usage="${h(p.id)}" ${usage?.loading ? 'disabled' : ''}>${usage?.loading ? t('查询中…') : data ? t('刷新用量') : t('查看用量')}</button></div>${body || `<div class="quota-detail">${usage?.loading ? t('正在读取账号额度…') : t('查看用量、重置时间与可用重置次数。')}</div>`}</section>`;
}
async function loadUsage(id, force = false) {
  const previous = usageById.get(id);
  if (resetBusy || previous?.loading || (!force && previous?.data && Date.now() - new Date(previous.data.checkedAt).getTime() < 60000)) return;
  usageById.set(id, {...previous, loading:true, error:null}); renderProviders();
  try { usageById.set(id, {data:await api('/providers/' + id + '/usage'), loading:false}); }
  catch (e) { usageById.set(id, {...previous, error:e.message, loading:false}); }
  renderProviders();
}
function toast(message) { $('toast').textContent = translateError(t(message)); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function errorBox(id, message) { errorsById.set(id, message); $(id).textContent = translateError(message) || ''; $(id).hidden = !message; }
async function api(path, options = {}) {
  const response = await fetch('/api' + path, { ...options, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf || '', ...options.headers } });
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || t('请求失败')); return data;
}
async function load() {
  state = await api('/config');
  $('stat-providers').textContent = state.providers.filter(p => p.enabled).length;
  $('stat-models').textContent = state.models.length;
  $('base-url').textContent = state.baseUrl; renderConnection();
  renderSelectors();
  renderModels(); renderProviders(); renderLogs(); capability();
}
function renderSelectors() {
  const selected = $('provider-filter').value;
  $('provider-filter').innerHTML = `<option value="">${t('所有供应商')}</option>` + state.providers.map(p => `<option value="${h(p.id)}">${h(p.name)}</option>`).join('');
  if (state.providers.some(p => p.id === selected)) $('provider-filter').value = selected;
  const selectedModel = $('test-model').value;
  $('test-model').innerHTML = state.models.length ? state.models.map(m => `<option value="${h(m.id)}">${h(m.id)}</option>`).join('') : `<option value="">${t('请先添加模型')}</option>`;
  if (state.models.some(m => m.id === selectedModel)) $('test-model').value = selectedModel;
  $('test-submit').disabled = !state.models.length || testBusy;
}
function renderModels() {
  const search = $('search').value.toLowerCase(), provider = $('provider-filter').value;
  const models = state.models.filter(m => (!provider || m.owned_by === provider) && `${m.id} ${m.provider_name}`.toLowerCase().includes(search));
  $('model-count').textContent = models.length;
  $('models-empty').hidden = Boolean(models.length);
  $('models-empty').querySelector('h3').textContent = state.models.length ? t('没有匹配的模型') : t('把第一个模型接进来');
  $('models-empty').querySelector('p').textContent = state.models.length ? t('试试其他关键词或切换供应商筛选。') : t('添加供应商并刷新模型，或手动填写模型 ID。');
  $('empty-add').hidden = Boolean(state.models.length);
  $('models-body').innerHTML = models.map(m => `<tr><td><span class="model-name" title="${h(m.name)}">${h(m.name)}</span><code class="model-id">${h(m.id)}</code></td><td><span class="source-badge">${h(m.provider_name)}</span></td><td><span class="source-badge ${m.source === 'nas-codex' ? 'bridge-badge' : ''}">${m.source === 'nas-codex' ? t('Codex 工具桥接') : 'API'}</span></td><td><button class="button ghost" data-test="${h(m.id)}">${t('测试 ↗')}</button></td></tr>`).join('');
  $('model-footer').textContent = t('共 {count} 个模型 · 仅显示已启用供应商的配置模型', {count: models.length});
  $('refresh-all').disabled = busy || !state.providers.some(p => p.enabled);
}
function renderProviders() {
  $('providers-empty').hidden = Boolean(state.providers.length);
  $('providers-grid').innerHTML = state.providers.map(p => `<article class="panel provider-card"><div class="provider-top"><div class="provider-mark">${p.type === 'nas-codex' ? '⌂' : h(p.name.slice(0, 1).toUpperCase())}</div><span class="status-pill ${p.enabled ? '' : 'off'}">${p.enabled ? t('已启用') : t('已停用')}</span></div><h3>${h(p.name)}</h3><code class="model-id">${h(p.id)} / ${p.type === 'nas-codex' ? (p.execution === 'ssh' ? 'Codex · SSH' : 'Codex · SSH + Docker') : h(p.protocol)}</code><p>${h(p.baseUrl || `${p.sshUser}@${p.sshHost}${p.execution === 'ssh' ? '' : ' · ' + p.container}`)}</p><div class="provider-meta"><span>${t('{count} 个模型', {count: p.models.length})}</span><span>·</span><span>${p.lastSync ? t('同步于 {time}', {time: new Date(p.lastSync).toLocaleTimeString(getLanguage(), {hour:'2-digit',minute:'2-digit'})}) : t('尚未同步')}</span></div>${usageMarkup(p)}<div class="provider-actions"><button class="button ghost" data-refresh="${h(p.id)}" ${busy ? 'disabled' : ''}>${t('↻ 刷新模型')}</button><button class="button ghost" data-edit="${h(p.id)}" ${busy ? 'disabled' : ''}>${t('编辑')}</button><button class="button ghost danger" data-delete="${h(p.id)}" ${busy ? 'disabled' : ''}>${t('删除')}</button></div></article>`).join('');
}
function renderLogs() {
  $('logs-empty').hidden = Boolean(state.logs.length);
  $('logs-body').innerHTML = state.logs.map(l => `<tr><td>${h(new Date(l.time).toLocaleTimeString(getLanguage()))}</td><td><code>${h(l.model)}</code>${l.error ? `<div class="log-error">${h(translateError(l.error))}</div>` : ''}</td><td>${h(l.endpoint)}</td><td><span class="source-badge ${l.status === 200 ? '' : 'bridge-badge'}">${l.status}</span></td><td>${(l.duration / 1000).toFixed(2)} s</td></tr>`).join('');
}
function capability() {
  const model = state.models.find(m => m.id === $('test-model').value);
  $('test-capability').textContent = model?.source === 'nas-codex' ? t('远程 Codex 支持客户端工具调用；由客户端执行工具，远端负责推理。') : '';
}
const views = new Set(['overview', 'providers', 'images', 'logs', 'settings']);
function viewFromLocation() {
  const name = location.hash.replace(/^#\/?/, '');
  return views.has(name) ? name : 'overview';
}
function view(name, { updateUrl = true } = {}) {
  if (!views.has(name)) name = 'overview';
  currentView = name;
  document.querySelector('.stats').hidden = ['images', 'settings'].includes(name);
  $('add-btn').hidden = ['images', 'settings'].includes(name);
  imageUI.setVisible(name === 'images');
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== name + '-view');
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  const names = { settings: [t('设置'), t('管理你的模型港。'), t('配置管理页面的登录方式。')], images: [t('生成图像'), t('描述你的想象。'), t('从一句话开始，把想法变成可以保存的图像。')], overview: [t('模型总览'), t('所有模型，一个入口。'), t('连接不同来源，在同一份模型列表里自由选择。')], providers: [t('供应商'), t('连接你的模型来源。'), t('统一管理 API 服务与远程 Codex。')], logs: [t('请求记录'), t('每一次调用，都有迹可循。'), t('检查路由结果、响应状态与请求耗时。')] };
  [$('page-name').textContent, $('heading').textContent, $('subtitle').textContent] = names[name];
  if (name === 'settings') loadSettings();
  if (name === 'providers') for (const p of state.providers) if (p.type === 'nas-codex' && p.enabled) loadUsage(p.id);
  if (updateUrl && location.hash !== '#' + name) history.pushState({ view: name }, '', '#' + name);
}
let settingsLoading = false;
async function loadSettings() {
  if (settingsLoading) return;
  settingsLoading = true; $('save-settings').disabled = true;
  try {
    const settings = await api('/settings');
    $('login-enabled').checked = settings.loginEnabled;
    $('login-username').value = settings.username;
    $('login-password').value = ''; $('login-password-confirm').value = '';
    errorBox('settings-error');
  } catch (e) { errorBox('settings-error', e.message); }
  finally { settingsLoading = false; $('save-settings').disabled = false; }
}
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); if (settingsLoading) return;
  if ($('login-password').value !== $('login-password-confirm').value) { errorBox('settings-error', t('两次输入的新密码不一致')); return; }
  settingsLoading = true; $('save-settings').disabled = true; errorBox('settings-error');
  try {
    const result = await api('/settings', {method:'PUT', body:JSON.stringify({loginEnabled:$('login-enabled').checked, username:$('login-username').value, password:$('login-password').value})});
    $('login-password').value = ''; $('login-password-confirm').value = '';
    if (result.credentialsChanged && result.loginEnabled) {
      csrf = ''; $('settings-relogin').hidden = false;
      $('settings-status').textContent = t('设置已保存，请使用新账号密码重新登录。');
    } else {
      csrf = (await api('/session')).csrf;
      $('settings-status').textContent = t('设置已保存');
    }
  } catch (e) { errorBox('settings-error', e.message); }
  finally { settingsLoading = false; $('save-settings').disabled = false; }
});
$('settings-relogin').addEventListener('click', () => location.reload());
function typeFields() {
  const remoteCodex = $('p-type').value === 'nas-codex';
  $('remote-codex-fields').hidden = !remoteCodex; $('http-fields').hidden = remoteCodex;
  $('p-url').required = !remoteCodex;
  ['p-host', 'p-user', 'p-ssh-key'].forEach(id => $(id).required = remoteCodex);
  const docker = $('p-execution').value === 'ssh-docker';
  $('p-container-label').hidden = !docker; $('p-container').required = remoteCodex && docker;
  $('p-codex-label').hidden = docker; $('p-codex').required = remoteCodex && !docker;
}
function openEditor(id) {
  editing = id || null; $('provider-form').reset(); errorBox('editor-error');
  const p = id ? state.providers.find(p => p.id === id) : null;
  $('editor-title').textContent = p ? t('编辑供应商') : t('添加供应商');
  $('p-id').disabled = Boolean(p); $('preset-label').hidden = Boolean(p);
  $('p-type').value = p?.type || 'openai';
  $('p-execution').value = p?.execution || 'ssh-docker'; $('p-codex').value = p?.codexPath || 'codex';
  $('key-help').textContent = p?.hasApiKey ? t('已保存密钥，留空保持原值；输入新密钥可替换。') : t('密钥在服务端加密保存。');
  $('clear-key-label').hidden = !p?.hasApiKey;
  if (p) {
    const fields = { 'p-name': 'name', 'p-id': 'id', 'p-url': 'baseUrl', 'p-protocol': 'protocol', 'p-host': 'sshHost', 'p-user': 'sshUser', 'p-ssh-key': 'sshKeyPath', 'p-container': 'container', 'p-timeout': 'timeout' };
    for (const [id, key] of Object.entries(fields)) $(id).value = p[key] ?? '';
    $('p-models').value = p.models.join('\n'); $('p-enabled').checked = p.enabled;
  }
  typeFields(); $('provider-dialog').showModal();
}
$('p-execution').addEventListener('change', typeFields);
$('preset').addEventListener('change', () => {
  const preset = $('preset').value;
  $('p-type').value = preset === 'remote-codex' ? 'nas-codex' : 'openai';
  const config = { custom: ['', '', '', 'chat'], deepseek: ['DeepSeek', 'deepseek', 'https://api.deepseek.com/v1', 'chat'], openai: ['OpenAI', 'openai', 'https://api.openai.com/v1', 'both'], 'remote-codex': [t('远程 Codex'), 'codex', '', 'chat'] }[preset];
  [$('p-name').value, $('p-id').value, $('p-url').value, $('p-protocol').value] = config;
  $('p-key').value = ''; $('p-models').value = ''; typeFields();
});
$('provider-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const input = { id: $('p-id').value.trim(), name: $('p-name').value, type: $('p-type').value, baseUrl: $('p-url').value.trim(), protocol: $('p-protocol').value, apiKey: $('p-key').value, clearApiKey: $('p-clear-key').checked, enabled: $('p-enabled').checked,
    models: $('p-models').value.split(/[\n,，]/).map(m => m.trim()).filter(Boolean), timeout: Number($('p-timeout').value), sshHost: $('p-host').value.trim(), sshUser: $('p-user').value.trim(), sshKeyPath: $('p-ssh-key').value.trim(), container: $('p-container').value.trim(), execution: $('p-execution').value, codexPath: $('p-codex').value.trim() };
  busy = true; saving = true; $('save-provider').disabled = true; $('save-provider').textContent = t('正在保存…'); errorBox('editor-error');
  try {
    await api('/providers' + (editing ? '/' + editing : ''), { method: editing ? 'PUT' : 'POST', body: JSON.stringify(input) });
    usageById.delete(input.id);
    $('provider-dialog').close(); await load(); toast('供应商已保存，可点击「刷新模型」获取模型列表');
  } catch (e) { errorBox('editor-error', e.message); }
  finally { busy = false; saving = false; $('save-provider').disabled = false; $('save-provider').textContent = t('保存供应商'); renderProviders(); renderModels(); }
});
async function refresh(ids) {
  if (busy) return; busy = true; refreshing = true; errorBox('global-error'); $('refresh-all').textContent = t('正在刷新…'); renderModels(); renderProviders();
  const errors = []; let count = 0;
  try {
    for (const id of ids) { try { await api('/providers/' + id + '/refresh', { method: 'POST' }); count++; } catch (e) { errors.push(`${state.providers.find(p => p.id === id)?.name}: ${translateError(e.message)}`); } }
    await load(); if (errors.length) errorBox('global-error', errors.join('; ')); if (count) toast(t('已更新 {count} 个供应商的模型列表', {count}));
  } catch (e) { errorBox('global-error', e.message); }
  finally { busy = false; refreshing = false; $('refresh-all').textContent = t('↻ 刷新模型'); renderProviders(); renderModels(); }
}
document.addEventListener('click', async event => {
  const el = event.target.closest('button'); if (!el) return;
  if (el.dataset.view) view(el.dataset.view);
  if (el.classList.contains('close-dialog')) el.closest('dialog').close();
  if (el.dataset.edit) openEditor(el.dataset.edit);
  if (el.dataset.usage) loadUsage(el.dataset.usage, true);
  if (el.dataset.resetUsage) openReset(el.dataset.resetUsage);
  if (el.dataset.refresh) refresh([el.dataset.refresh]);
  if (el.dataset.test) { $('test-model').value = el.dataset.test; capability(); $('test-prompt').focus(); }
  if (el.dataset.delete && !busy) {
    const p = state.providers.find(p => p.id === el.dataset.delete);
    if (!confirm(t('删除「{name}」及其模型配置？', {name:p.name}))) return;
    busy = true;
    try { await api('/providers/' + p.id, { method: 'DELETE' }); await load(); toast('供应商已删除'); }
    catch (e) { errorBox('global-error', e.message); } finally { busy = false; renderProviders(); renderModels(); }
  }
});
$('test-form').addEventListener('submit', async event => {
  event.preventDefault(); if (testBusy) return;
  testBusy = true; testResult = {status:'pending'}; $('test-submit').disabled = true; $('test-submit').textContent = t('正在等待回复…'); $('test-output').hidden = false; $('test-result').textContent = t('请求已发出…'); $('test-result-label').textContent = t('处理中');
  try {
    const result = await api('/test', { method: 'POST', body: JSON.stringify({ model: $('test-model').value, prompt: $('test-prompt').value }) });
    testResult = {status:'done', text:result.text, duration:(result.duration / 1000).toFixed(2)}; renderTestOutput();
  } catch (e) { testResult = {status:'error', error:e.message}; renderTestOutput(); }
  finally { testBusy = false; $('test-submit').disabled = !state.models.length; $('test-submit').textContent = t('发送测试消息 →'); try { await load(); } catch {} }
});
function fallbackCopy(value) {
  const area = document.createElement('textarea');
  area.value = value; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.top = '0'; area.style.left = '-9999px'; area.style.opacity = '0';
  document.body.appendChild(area);
  const selection = document.getSelection(), previous = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  let copied = false;
  try { area.select(); area.setSelectionRange(0, area.value.length); copied = document.execCommand('copy'); }
  catch {}
  finally { area.remove(); if (previous && selection) { selection.removeAllRanges(); selection.addRange(previous); } }
  return copied;
}
async function copy(text) {
  const value = String(text ?? '');
  let copied = false;
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); copied = true; } catch {}
  }
  if (!copied) copied = fallbackCopy(value);
  toast(copied ? '已复制到剪贴板' : '无法访问剪贴板，请手动选择并复制');
}
function connectionURL() {return connectionProtocol === 'anthropic' ? (state.baseUrl || '').replace(/\/v1\/?$/, '') : state.baseUrl || '';}
function renderConnection() {
  $('connect-url').textContent = connectionURL();
  const base=(state.baseUrl || '').replace(/\/v1\/?$/, ''),model=state.models[0]?.id || 'provider/model';
  for(const protocol of ['anthropic','openai']) {
    const selected=protocol===connectionProtocol,tab=$('guide-tab-'+protocol);
    tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;$('guide-'+protocol).hidden=!selected;
  }
  $('guide-anthropic-example').textContent = `curl ${base}/v1/messages \\\n  -H "content-type: application/json" \\\n  -H "x-api-key: YOUR_GATEWAY_KEY" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -d '${JSON.stringify({model,max_tokens:1024,messages:[{role:'user',content:'Hello'}],stream:true},null,2)}'`;
  $('guide-openai-example').textContent = `curl ${base}/v1/responses \\\n  -H "content-type: application/json" \\\n  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \\\n  -d '${JSON.stringify({model,input:'Hello',store:false,stream:true},null,2)}'`;
}
for(const protocol of ['anthropic','openai']) {
  const tab=$('guide-tab-'+protocol);
  tab.addEventListener('click',()=>{connectionProtocol=protocol;renderConnection();});
  tab.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();connectionProtocol=event.key==='Home'?'anthropic':event.key==='End'?'openai':connectionProtocol==='anthropic'?'openai':'anthropic';renderConnection();$('guide-tab-'+connectionProtocol).focus();}});
}
function openConnection() { renderConnection(); keyVisible = false; connectionKey = ''; $('connect-key').textContent = '••••••••••••••••••••••••'; $('reveal-key').textContent = t('显示'); $('connection-dialog').showModal(); api('/key').then(({key}) => { connectionKey = key; }).catch(() => {}); }
$('reveal-key').addEventListener('click', async () => {
  try { keyVisible = !keyVisible; $('connect-key').textContent = keyVisible ? (await api('/key')).key : '••••••••••••••••••••••••'; $('reveal-key').textContent = keyVisible ? t('隐藏') : t('显示'); }
  catch (e) { toast(e.message); }
});
$('copy-key').addEventListener('click', async () => { try { const key = connectionKey || (await api('/key')).key; connectionKey = key; await copy(key); } catch (e) { toast(e.message); } });
$('connection-dialog').addEventListener('close', () => { $('connect-key').textContent = '••••••••••••••••••••••••'; keyVisible = false; connectionKey = ''; });
$('provider-dialog').addEventListener('close', () => { $('p-key').value = ''; });
['connection-btn', 'tip-connect'].forEach(id => $(id).addEventListener('click', openConnection));
$('copy-url').addEventListener('click', () => copy(state.baseUrl));
$('connect-copy-url').addEventListener('click', () => copy(connectionURL()));
['add-btn', 'empty-add'].forEach(id => $(id).addEventListener('click', () => openEditor()));
$('search').addEventListener('input', renderModels); $('provider-filter').addEventListener('change', renderModels);
$('test-model').addEventListener('change', capability);
$('refresh-all').addEventListener('click', () => refresh(state.providers.filter(p => p.enabled).map(p => p.id)));
$('reload-logs').addEventListener('click', () => load().catch(e => errorBox('global-error', e.message)));

function renderTestOutput() {
  if (!testResult) return;
  $('test-result-label').textContent = testResult.status === 'pending' ? t('处理中') : testResult.status === 'error' ? t('调用失败') : t('回复 · {duration} s', {duration:testResult.duration});
  $('test-result').textContent = testResult.status === 'pending' ? t('请求已发出…') : testResult.status === 'error' ? translateError(testResult.error) : testResult.text || t('模型返回了非文本结果。');
}
function applyLanguage() {
  translateStatic();
  imageUI.render();
  document.title = t('Model Harbor · 模型港');
  const en = getLanguage() === 'en';
  $('language-toggle').textContent = en ? '中文' : 'EN';
  $('language-toggle').setAttribute('aria-label', en ? 'Switch to Chinese' : '切换到英文');
  $('language-toggle').title = en ? 'Switch to Chinese' : '切换到英文';
  view(currentView);
  for (const [id, message] of errorsById) $(id).textContent = translateError(message) || '';
  renderTestOutput();
  renderSelectors(); renderModels(); renderProviders(); renderLogs(); capability();
  $('editor-title').textContent = t(editing ? '编辑供应商' : '添加供应商');
  $('key-help').textContent = t(editing && state.providers.find(p => p.id === editing)?.hasApiKey ? '已保存密钥，留空保持原值；输入新密钥可替换。' : '密钥在服务端加密保存。');
  $('save-provider').textContent = t(saving ? '正在保存…' : '保存供应商');
  $('refresh-all').textContent = t(refreshing ? '正在刷新…' : '↻ 刷新模型');
  $('test-submit').textContent = t(testBusy ? '正在等待回复…' : '发送测试消息 →');
  $('reveal-key').textContent = t(keyVisible ? '隐藏' : '显示');
  const prompt = $('test-prompt');
  if (['你好，请简短介绍一下你自己。', 'Hello! Please briefly introduce yourself.'].includes(prompt.value)) prompt.value = t('你好，请简短介绍一下你自己。');
}
$('language-toggle').addEventListener('click', () => {
  setLanguage(getLanguage() === 'en' ? 'zh-CN' : 'en');
  applyLanguage();
});
function syncViewFromLocation() {
  const name = viewFromLocation();
  if (location.hash !== '#' + name) history.replaceState({ view: name }, '', '#' + name);
  if (name !== currentView) view(name, { updateUrl: false });
}
window.addEventListener('hashchange', syncViewFromLocation);
window.addEventListener('popstate', syncViewFromLocation);
currentView = viewFromLocation();
if (location.hash !== '#' + currentView) history.replaceState({ view: currentView }, '', '#' + currentView);
applyLanguage();

try { csrf = (await api('/session')).csrf; await load(); view(currentView, { updateUrl: false }); } catch (e) { errorBox('global-error', e.message); }
