import { createImageUI } from './image-ui.js';
import { createVideoUI } from './video-ui.js';
import { t, getLanguage, setLanguage, captureStaticText, translateError } from './i18n.js';
// P-01/P-02: provider CRUD, model directory, connection instructions, real request test.
const $ = id => document.getElementById(id);
const h = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
let csrf, state = { providers: [], groups: [], models: [], logs: [] }, editing = null, busy = false, testBusy = false, keyVisible = false, connectionKey = '';
let toastTimer, currentView = 'overview', saving = false, refreshing = false;
const translateStatic = captureStaticText();
const errorsById = new Map();
let testResult = null, connectionProtocol = 'anthropic';
const imageUI = createImageUI({api, toast});
const videoUI = createVideoUI({api, toast});
const usageById = new Map();
const resetKeys = new Map();
let resetProvider = null, resetBusy = false;
let providerDrag = null;
let toolState = { tools: [] }, toolBusy = false, toolPollTimer = null;
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
function usageTone(value) {
  if (value === null || value === undefined || value === '') return 'unknown';
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 'unknown';
  if (percent >= 100) return 'critical';
  if (percent >= 80) return 'danger';
  if (percent >= 60) return 'warning';
  return 'safe';
}
function usageWindow(window) {
  const label = window.durationMins === 300 ? t('5 小时用量') : window.durationMins === 10080 ? t('每周用量') : window.durationMins === 43200 ? t('每月用量') : window.durationMins ? t('{minutes} 分钟用量', {minutes:window.durationMins}) : t('用量窗口');
  const percent = value => Math.round(value * 10) / 10;
  const known = window.usedPercent !== null && window.usedPercent !== undefined;
  const tone = known ? usageTone(window.usedPercent) : 'unknown';
  const reset = window.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString(getLanguage()) : t('暂不可用');
  return `<div class="quota-window quota-${tone}"><div class="quota-row"><strong>${h(label)}</strong><span class="quota-used">${known ? h(t('已用 {percent}%', {percent:percent(window.usedPercent)})) : t('暂不可用')}</span></div>${known ? `<progress max="100" value="${window.usedPercent}" aria-label="${h(label)}"></progress><div class="quota-detail">${h(t('剩余 {percent}%', {percent:percent(window.remainingPercent)}))}</div>` : ''}<div class="quota-detail">${h(t('下次重置：{time}', {time:reset}))}</div></div>`;
}
function balanceProvider(p) { return p.type === 'openai' && /(^|\.)deepseek\.com(\/|$)/.test((p.baseUrl || '').replace(/^https?:\/\//, '')); }
function balanceMoney(b) {
  if (!b || b.total === null || b.total === undefined) return '—';
  const symbol = b.currency === 'CNY' ? '¥' : b.currency === 'USD' ? '$' : b.currency ? b.currency + ' ' : '';
  return symbol + Number(b.total).toFixed(2);
}
function balanceMarkup(p) {
  const usage = usageById.get(p.id), data = usage?.data;
  const balances = data?.balances || [], primary = balances[0];
  const low = data && (data.available === false || (primary && primary.total !== null && primary.total <= 0));
  let body = '';
  if (primary) {
    body = `<div class="balance-split"><span><span class="balance-caption">${t('充值')}</span> ${h(balanceMoney({ ...primary, total: primary.toppedUp ?? 0 }))}</span><span class="balance-dot">·</span><span><span class="balance-caption">${t('赠送')}</span> ${h(balanceMoney({ ...primary, total: primary.granted ?? 0 }))}</span></div>`;
    if (balances.length > 1) body += `<div class="balance-list">${balances.slice(1).map(b => `<div class="balance-alt"><span>${h(b.currency || t('账户余额'))}</span><strong>${h(balanceMoney(b))}</strong></div>`).join('')}</div>`;
    if (data.available === false) body += `<div class="balance-foot balance-warning">${t('余额不足，API 暂不可用')}</div>`;
  }
  const foot = data ? `<div class="balance-foot">${h(t('更新于 {time}', {time:new Date(data.checkedAt).toLocaleTimeString(getLanguage())}))}</div>` : `<div class="balance-foot">${usage?.loading ? t('正在读取账号额度…') : t('查看账户余额。')}</div>`;
  const error = usage?.error ? `<div class="notice error" role="alert">${h(translateError(usage.error))}</div>` : '';
  return `<section class="provider-quota balance-card"><div class="balance-head"><div class="balance-title"><span>${t('账户余额')}</span><strong class="${low ? 'low' : ''}">${primary ? h(balanceMoney(primary)) : '—'}</strong></div><button class="button ghost balance-refresh" data-usage="${h(p.id)}" ${usage?.loading ? 'disabled' : ''}>${usage?.loading ? t('查询中…') : data ? t('刷新余额') : t('查看余额')}</button></div>${error}${body}${foot}</section>`;
}

function openCodeGoProvider(p) { return p.type === 'openai' && p.baseUrl === 'https://opencode.ai/inference/go/openai/v1'; }
function openCodeGoUsageMarkup(p) {
  const usage = usageById.get(p.id), data = usage?.data;
  const minutes = { rolling: 300, weekly: 10080, monthly: 43200 };
  const body = (data?.windows || []).map(w => usageWindow({ ...w, durationMins: w.durationMins || minutes[w.id] })).join('');
  const error = usage?.error ? `<div class="notice error" role="alert">${h(translateError(usage.error))}</div>` : '';
  return `<section class="provider-quota"><div class="quota-row"><strong>${t('OpenCode Go 账号用量')}</strong><button class="button ghost quota-refresh" data-usage="${h(p.id)}" ${usage?.loading ? 'disabled' : ''}>${usage?.loading ? t('查询中…') : data ? t('刷新用量') : t('查看用量')}</button></div>${error}${body}${!data && usage?.loading ? `<div class="quota-detail">${t('正在读取账号额度…')}</div>` : ''}<div class="quota-detail">${t('Chat 与 Responses 共享同一 Go 工作区额度；数据最多缓存 30 秒。')}</div>${data ? `<div class="quota-detail">${h(t('更新于 {time}', {time:new Date(data.checkedAt).toLocaleTimeString(getLanguage())}))}</div>` : ''}</section>`;
}
function usageMarkup(p) {
  if (openCodeGoProvider(p)) return openCodeGoUsageMarkup(p);
  if (balanceProvider(p)) return balanceMarkup(p);
  if (p.type !== 'nas-codex' && p.type !== 'claude-code' && p.type !== 'grok-code' && p.type !== 'grok') return '';
  const usage = usageById.get(p.id), data = usage?.data, claude = p.type === 'claude-code', grok = p.type === 'grok-code' || p.type === 'grok';
  let body = '';
  if (data) {
    const buckets = data.buckets?.length ? data.buckets : [{id: claude ? 'claude' : grok ? 'grok' : 'codex', windows:[]}];
    body = buckets.map(bucket => {
      const windows = [...(bucket.windows || [])];
      const pad = p.type === 'grok' ? [] : grok ? [10080] : [300, 10080];
      for (const durationMins of pad) if (!windows.some(w => w.durationMins === durationMins)) windows.push({durationMins, usedPercent:null});
      windows.sort((a,b) => (a.durationMins || Infinity) - (b.durationMins || Infinity));
      return `<div class="quota-bucket">${buckets.length > 1 || bucket.planType ? `<div class="quota-detail">${h(bucket.name || (bucket.id === 'codex' ? t('默认额度') : bucket.id))}${bucket.planType ? ' · ' + h(bucket.planType) : ''}</div>` : ''}${windows.map(usageWindow).join('')}</div>`;
    }).join('');
    if (claude) body += `<div class="quota-detail">${h(t('更新于 {time}', {time:new Date(data.checkedAt).toLocaleTimeString(getLanguage())}))}</div><div class="quota-detail">${t('Claude 用量按账号共享；数据最多缓存 30 秒。')}</div>`;
    else if (grok) body += `<div class="quota-detail">${h(t('更新于 {time}', {time:new Date(data.checkedAt).toLocaleTimeString(getLanguage())}))}</div><div class="quota-detail">${t('Grok 用量按订阅账号共享；数据最多缓存 30 秒。')}</div>`;
    else body += `<div class="quota-row quota-resets"><strong>${t('剩余重置次数')}</strong><span>${data.resetCredits === null ? t('暂不可用') : h(t('{count} 次', {count:data.resetCredits}))}</span></div><div class="quota-detail">${h(t('更新于 {time}', {time:new Date(data.checkedAt).toLocaleTimeString(getLanguage())}))}</div><div class="quota-detail">${t('同一账号额度共享；数据最多缓存 30 秒。')}</div>`;
  }
  if (!claude && !grok) body += `<button class="button secondary quota-reset-button" data-reset-usage="${h(p.id)}" ${busy || usage?.loading || (!(data?.resetCredits > 0) && !pendingResetKey(p.id)) ? 'disabled' : ''}>${pendingResetKey(p.id) ? t('重试同一次重置') : t('重置额度')}</button>`;
  if (usage?.error) body = `<div class="notice error" role="alert">${h(translateError(usage.error))}</div>` + body;
  return `<section class="provider-quota"><div class="quota-row"><strong>${t(claude ? 'Claude 账号用量' : grok ? 'Grok 账号用量' : 'Codex 账号用量')}</strong><button class="button ghost quota-refresh" data-usage="${h(p.id)}" ${usage?.loading ? 'disabled' : ''}>${usage?.loading ? t('查询中…') : data ? t('刷新用量') : t('查看用量')}</button></div>${body || `<div class="quota-detail">${usage?.loading ? t('正在读取账号额度…') : t(claude ? '查看 Claude 的 5 小时与每周用量。' : p.type === 'grok' ? '查看 Grok 订阅的每周与每月用量。' : grok ? '查看 Grok 的每周用量。' : '查看用量、重置时间与可用重置次数。')}</div>`}</section>`;
}
async function loadUsage(id, force = false) {
  const previous = usageById.get(id);
  if (resetBusy || previous?.loading || (!force && previous?.data && Date.now() - new Date(previous.data.checkedAt).getTime() < 60000)) return;
  usageById.set(id, {...previous, loading:true, error:null}); renderProviders();
  try { usageById.set(id, {data:await api('/providers/' + id + '/usage'), loading:false}); }
  catch (e) { usageById.set(id, {...previous, error:e.message, loading:false}); }
  renderProviders();
}
function toolBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return t('未知');
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}
function toolStatusLabel(tool) {
  const map = {
    idle: '尚未检测',
    checking: '正在检查最新版本…',
    downloading: '正在通过 OpenWrt 代理下载…',
    up_to_date: '已是最新版本',
    error: '检测或下载失败'
  };
  return t(map[tool.status] || '尚未检测');
}
function stopToolPoll() { clearTimeout(toolPollTimer); toolPollTimer = null; }
function scheduleToolPoll() {
  stopToolPoll();
  if (currentView !== 'tools') return;
  if (!toolState.tools.some(tool => ['checking', 'downloading'].includes(tool.status))) return;
  toolPollTimer = setTimeout(() => loadTools(true), 1800);
}
function renderTools() {
  const grid = $('tools-grid'); if (!grid) return;
  if (!toolState.tools.length) {
    grid.innerHTML = `<section class="panel tool-empty"><div class="empty-symbol">⇩</div><h3>${t('工具列表正在加载')}</h3><p>${t('稍候会显示可下载的桌面工具。')}</p></section>`;
    return;
  }
  grid.innerHTML = toolState.tools.map(tool => {
    const working = ['checking', 'downloading'].includes(tool.status);
    const progress = tool.progress;
    const progressMarkup = tool.status === 'downloading'
      ? `<div class="tool-progress"><div class="tool-progress-row"><span>${t('下载进度')}</span><strong>${progress?.percent ?? 0}%</strong></div><progress max="100" value="${progress?.percent ?? 0}"></progress><small>${h(toolBytes(progress?.received || 0))} / ${h(toolBytes(progress?.total || tool.bytes || 0))}</small></div>`
      : tool.status === 'checking' ? `<div class="tool-progress tool-progress-checking"><progress></progress><small>${t('正在向 Microsoft Store 查询版本…')}</small></div>` : '';
    const checked = tool.checkedAt ? new Date(tool.checkedAt).toLocaleString(getLanguage()) : t('尚未检测');
    return `<article class="panel tool-card"><div class="tool-card-top"><div class="tool-mark">GPT</div><div><div class="eyebrow">MICROSOFT STORE · OPENAI</div><h3>${h(tool.name)}</h3><p>${h(tool.platform)}</p></div><span class="status-pill ${tool.status === 'error' ? 'off' : ''}">${h(toolStatusLabel(tool))}</span></div><div class="tool-versions"><div><span>${t('已安装版本')}</span><strong>${h(tool.installedVersion || t('尚未下载'))}</strong></div><div><span>${t('最新版本')}</span><strong>${h(tool.latestVersion || t('待检测'))}</strong></div><div><span>${t('安装包大小')}</span><strong>${h(tool.bytes ? toolBytes(tool.bytes) : t('未知'))}</strong></div></div>${progressMarkup}${tool.error ? `<div class="notice error" role="alert">${h(translateError(tool.error))}</div>` : ''}<div class="tool-card-meta"><span>${t('来源：Microsoft Store 官方安装包')}</span><span>·</span><span>${h(t('上次检测：{time}', { time: checked }))}</span><span>·</span><span class="${tool.proxyConfigured ? 'tool-proxy-ok' : 'tool-proxy-missing'}">${tool.proxyConfigured ? t('OpenWrt 代理已启用') : t('未配置下载代理')}</span></div><div class="tool-actions"><button class="button primary tool-update-button" data-tool-check ${working ? 'disabled' : ''}>${tool.status === 'checking' ? t('正在检测…') : tool.status === 'downloading' ? t('正在下载…') : t('检测更新')}</button>${tool.downloadUrl ? `<a class="button secondary" href="${h(tool.downloadUrl)}" download="${h(tool.fileName || '')}">${t('下载安装包')}</a>` : ''}</div></article>`;
  }).join('');
}
async function loadTools(force = false) {
  if (toolBusy && !force) return;
  try {
    const result = await api('/tools');
    toolState = result;
    renderTools();
    scheduleToolPoll();
  } catch (error) {
    if (currentView === 'tools') errorBox('global-error', error.message);
    stopToolPoll();
  }
}
async function checkToolUpdate() {
  if (toolBusy) return;
  toolBusy = true; errorBox('global-error'); renderTools();
  try {
    const result = await api('/tools/chatgpt/check', { method: 'POST' });
    toolState = { tools: [result.tool] };
    renderTools(); scheduleToolPoll();
    toast(result.tool.status === 'downloading' ? '检测到新版本，正在下载安装包' : '工具已是最新版本');
  } catch (error) {
    errorBox('global-error', error.message);
    await loadTools(true);
  } finally {
    toolBusy = false; renderTools();
  }
}
function toast(message) { $('toast').textContent = translateError(t(message)); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function errorBox(id, message) { errorsById.set(id, message); $(id).textContent = translateError(message) || ''; $(id).hidden = !message; }
async function api(path, options = {}, retried = false) {
  const response = await fetch('/api' + path, { ...options, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf || '', ...options.headers } });
  if (response.status === 401 && !retried && path !== '/session') { csrf = (await api('/session', {}, true)).csrf; return api(path, options, true); }
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || t('请求失败')); return data;
}
async function load() {
  state = await api('/config');
  $('stat-providers').textContent = state.providers.filter(p => p.enabled).length;
  $('stat-models').textContent = state.models.length;
  $('base-url-openai').textContent = state.baseUrl || ''; $('base-url-anthropic').textContent = (state.baseUrl || '').replace(/\/v1\/?$/, ''); renderConnection();
  renderSelectors();
  renderModels(); renderProviders(); renderProxies(); renderLogs(); capability();
}
function renderSelectors() {
  const selected = $('provider-filter').value;
  $('provider-filter').innerHTML = `<option value="">${t('所有供应商')}</option>` + state.providers.map(p => `<option value="${h(p.id)}">${h(p.name)}</option>`).join('') + (state.groups || []).map(g => `<option value="${h(g.id)}">${h(g.name)}</option>`).join('');
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
  $('models-body').innerHTML = models.map(m => `<tr><td><span class="model-name" title="${h(m.name)}">${h(m.name)}</span><code class="model-id">${h(m.id)}</code></td><td><span class="source-badge">${h(m.provider_name)}</span></td><td><span class="source-badge ${m.source === 'nas-codex' || m.source === 'codex-group' || m.source === 'claude-code' || m.source === 'grok-code' ? 'bridge-badge' : ''}">${m.source === 'nas-codex' || m.source === 'codex-group' ? t('Codex 工具桥接') : m.source === 'claude-code' ? t('Claude 工具桥接') : m.source === 'grok-code' ? t('Grok 工具桥接') : 'API'}</span></td><td><button class="button ghost" data-test="${h(m.id)}">${t('测试 ↗')}</button></td></tr>`).join('');
  $('model-footer').textContent = t('共 {count} 个模型 · 仅显示已启用供应商的配置模型', {count: models.length});
  $('refresh-all').disabled = busy || !state.providers.some(p => p.enabled);
}
function proxyName(id) { return (state.proxies || []).find(item => item.id === id)?.name || id; }
function renderProxies() {
  const list = state.proxies || [];
  $('proxies-empty').hidden = Boolean(list.length);
  $('proxies-grid').innerHTML = list.map(px => `<article class="panel provider-card"><div class="provider-top"><div class="provider-mark">⇄</div><span class="status-pill ${px.enabled ? '' : 'off'}">${px.enabled ? t('已启用') : t('已停用')}</span></div><h3>${h(px.name)}</h3><code class="model-id">${h(px.id)}</code><p>${h(px.url)}</p><div class="provider-meta"><span>${px.hasPassword ? t('需要认证') : t('无认证')}</span><span>·</span><span>${t('{count} 个供应商在用', { count: (state.providers || []).filter(p => p.proxyId === px.id).length })}</span></div><div class="provider-actions"><button class="button ghost" data-proxy-test="${h(px.id)}" ${busy ? 'disabled' : ''}>${t('测试连通')}</button><button class="button ghost" data-proxy-edit="${h(px.id)}" ${busy ? 'disabled' : ''}>${t('编辑')}</button><button class="button ghost danger" data-proxy-delete="${h(px.id)}" ${busy ? 'disabled' : ''}>${t('删除')}</button></div></article>`).join('');
}
let proxyEditing = null;
function openProxyEditor(id) {
  proxyEditing = id || null;
  $('proxy-form').reset(); errorBox('proxy-editor-error');
  const px = id ? (state.proxies || []).find(item => item.id === id) : null;
  $('proxy-editor-title').textContent = px ? t('编辑代理') : t('添加代理');
  $('px-id').disabled = Boolean(px);
  $('px-id').value = px?.id || '';
  $('px-name').value = px?.name || '';
  $('px-url').value = px?.url || '';
  $('px-user').value = px?.username || '';
  $('px-password').value = '';
  $('px-clear').checked = false;
  $('px-clear-label').hidden = !px?.hasPassword;
  $('px-no-proxy').value = (px?.noProxy || []).join(', ');
  $('px-enabled').checked = px ? px.enabled !== false : true;
  $('proxy-dialog').showModal();
}
function renderProviders() {
  if (providerDrag) return;
  $('providers-empty').hidden = Boolean(state.providers.length);
  $('providers-grid').innerHTML = state.providers.map(p => `<article class="panel provider-card" data-provider-row="${h(p.id)}"><div class="provider-top"><button type="button" class="provider-drag-handle" data-provider-drag="${h(p.id)}" aria-label="${h(t('拖动排序；方向键上下移动'))}" title="${h(t('拖动排序；方向键上下移动'))}" ${busy ? 'disabled' : ''}>⠿</button><div class="provider-mark">${p.type === 'nas-codex' ? '⌂' : p.type === 'claude-code' ? '✦' : h(p.name.slice(0, 1).toUpperCase())}</div><span class="status-pill ${p.enabled ? '' : 'off'}">${p.enabled ? t('已启用') : t('已停用')}</span></div><h3>${h(p.name)}</h3><code class="model-id">${h(p.id)} / ${p.type === 'nas-codex' ? (p.execution === 'ssh' ? 'Codex · SSH' : 'Codex · SSH + Docker') : p.type === 'claude-code' ? (p.execution === 'ssh' ? 'Claude · SSH' : 'Claude · SSH + Docker') : openCodeGoProvider(p) ? t('Chat + Responses · 自动路由') : h(p.protocol)}</code><p>${h(p.baseUrl || `${p.sshUser}@${p.sshHost}${p.execution === 'ssh' ? '' : ' · ' + p.container}`)}</p><div class="provider-meta"><span>${t('{count} 个模型', {count: p.models.length})}</span><span>·</span>${p.type === 'grok' ? `<span>·</span><span>${p.grok?.authorized ? t('已授权') : t('未授权')}</span>` : ''}${p.proxyId ? `<span>·</span><span>${t('代理：{name}', { name: proxyName(p.proxyId) })}</span>` : ''}<span>${p.lastSync ? t('同步于 {time}', {time: new Date(p.lastSync).toLocaleTimeString(getLanguage(), {hour:'2-digit',minute:'2-digit'})}) : t('尚未同步')}</span></div>${usageMarkup(p)}${p.type === 'grok' ? `<button class="button ghost" data-grok-oauth="${h(p.id)}" ${busy ? 'disabled' : ''}>${p.grok?.authorized ? t('重新授权') : t('授权')}</button>` : ''}<div class="provider-actions"><button class="button ghost" data-refresh="${h(p.id)}" ${busy ? 'disabled' : ''}>${t('↻ 刷新模型')}</button><button class="button ghost" data-edit="${h(p.id)}" ${busy ? 'disabled' : ''}>${t('编辑')}</button><button class="button ghost danger" data-delete="${h(p.id)}" ${busy ? 'disabled' : ''}>${t('删除')}</button></div></article>`).join('');
  renderGroups();
}

// Display order is independent of account-group member priority.
async function saveProviderOrder(ids, focusId) {
  if (busy || ids.every((id, index) => state.providers[index]?.id === id)) { renderProviders(); return; }
  busy = true; errorBox('global-error'); renderProviders();
  try {
    const result = await api('/providers/order', { method: 'PUT', body: JSON.stringify({ ids }) });
    state.providers = result.providers;
    renderSelectors(); renderModels(); toast(t('供应商顺序已保存'));
  } catch (error) {
    errorBox('global-error', error.message);
    try { await load(); } catch {}
  } finally {
    busy = false; renderProviders();
    if (focusId) [...$('providers-grid').querySelectorAll('[data-provider-drag]')].find(el => el.dataset.providerDrag === focusId)?.focus();
  }
}
$('providers-grid').addEventListener('pointerdown', event => {
  const handle = event.target.closest('[data-provider-drag]');
  if (!handle || busy || providerDrag || event.button !== 0 || state.providers.length < 2) return;
  event.preventDefault(); handle.focus();
  const row = handle.closest('[data-provider-row]');
  providerDrag = { id: handle.dataset.providerDrag, pointerId: event.pointerId, row, handle, y: event.clientY, moved: false };
  handle.setPointerCapture(event.pointerId);
});
document.addEventListener('pointermove', event => {
  const drag = providerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (!drag.moved && Math.abs(event.clientY - drag.y) < 5) return;
  drag.moved = true; drag.row.classList.add('provider-dragging');
  event.preventDefault();
  if (event.clientY < 80) window.scrollBy(0, -18);
  else if (event.clientY > innerHeight - 80) window.scrollBy(0, 18);
  const others = [...$('providers-grid').querySelectorAll('[data-provider-row]')].filter(row => row !== drag.row);
  const next = others.find(row => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
  drag.next = next || null;
  $('providers-grid').querySelectorAll('.provider-drop-before,.provider-drop-after').forEach(row => row.classList.remove('provider-drop-before', 'provider-drop-after'));
  if (next) next.classList.add('provider-drop-before');
  else others.at(-1)?.classList.add('provider-drop-after');
}, { passive: false });
function finishProviderDrag(event, cancel = false) {
  const drag = providerDrag;
  if (!drag || (event.pointerId !== undefined && drag.pointerId !== event.pointerId)) return;
  if (!cancel && drag.moved) $('providers-grid').insertBefore(drag.row, drag.next || null);
  const ids = [...$('providers-grid').querySelectorAll('[data-provider-row]')].map(el => el.dataset.providerRow);
  providerDrag = null; drag.row.classList.remove('provider-dragging');
  if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
  if (cancel || !drag.moved) renderProviders();
  else void saveProviderOrder(ids, drag.id);
}
document.addEventListener('pointerup', event => finishProviderDrag(event));
document.addEventListener('pointercancel', event => finishProviderDrag(event, true));
window.addEventListener('blur', event => finishProviderDrag(event, true));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && providerDrag) { event.preventDefault(); finishProviderDrag(event, true); return; }
  const handle = event.target.closest?.('[data-provider-drag]');
  if (!handle || busy || providerDrag || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const ids = state.providers.map(p => p.id), index = ids.indexOf(handle.dataset.providerDrag);
  const target = index + (event.key === 'ArrowUp' ? -1 : 1);
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  void saveProviderOrder(ids, handle.dataset.providerDrag);
});

let groupEditing = null, groupMemberIds = [];
const groupById = id => (state.groups || []).find(g => g.id === id);

function renderGroupChoices() {
  const codex = state.providers.filter(p => p.type === 'nas-codex');
  const chosen = groupMemberIds.map(id => codex.find(p => p.id === id) || state.providers.find(p => p.id === id)).filter(Boolean);
  const rest = codex.filter(p => !groupMemberIds.includes(p.id));
  const row = (p, index) => `<div class="group-choice${index >= 0 ? ' chosen' : ''}"><label><input type="checkbox" data-gm="${h(p.id)}" ${index >= 0 ? 'checked' : ''}> ${h(p.name)} <code>${h(p.id)}</code></label>${index >= 0 ? `<span class="group-order"><button type="button" class="icon-button" data-gmove="${h(p.id)}" data-delta="-1" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" class="icon-button" data-gmove="${h(p.id)}" data-delta="1" ${index === chosen.length - 1 ? 'disabled' : ''}>↓</button></span>` : ''}</div>`;
  const html = chosen.map((p, i) => row(p, i)).join('') + rest.map(p => row(p, -1)).join('');
  $('g-choices').innerHTML = html || `<div class="muted small">${t('没有可用的 Codex 供应商，请先添加并登录。')}</div>`;
}

function openGroupEditor(id) {
  const g = id ? groupById(id) : null;
  groupEditing = g ? g.id : null;
  groupMemberIds = g ? g.members.map(m => m.id) : [];
  $('g-name').value = g ? g.name : '';
  $('g-id').value = g ? g.id : '';
  $('g-id').disabled = Boolean(g);
  $('g-enabled').checked = g ? g.enabled : true;
  $('g-hide').checked = g ? g.hideMembers !== false : true;
  $('group-dialog-title').textContent = t(g ? '编辑 Codex 账号组' : '新建 Codex 账号组');
  renderGroupChoices(); errorBox('group-error'); $('group-dialog').showModal();
}

function renderGroups() {
  const groups = state.groups || [];
  $('groups-empty').hidden = Boolean(groups.length);
  $('groups-grid').innerHTML = groups.map(g => {
    const members = g.members.map((m, i) => {
      const till = m.cooling && m.until ? t('至 {time}', { time: new Date(m.until).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' }) }) : '';
      return `<li><span class="group-rank">${i + 1}</span><span class="group-member-name">${h(m.name)}</span><code class="model-id">${h(m.container || m.id)}</code><span class="status-pill ${m.cooling ? 'off' : ''}">${m.cooling ? t('额度用尽') + till : m.enabled ? t('可用') : t('已停用')}</span><span class="group-order"><button class="icon-button" data-group="${h(g.id)}" data-group-up="${h(m.id)}" ${i === 0 ? 'disabled' : ''} title="${t('提高优先级')}">↑</button><button class="icon-button" data-group="${h(g.id)}" data-group-down="${h(m.id)}" ${i === g.members.length - 1 ? 'disabled' : ''} title="${t('降低优先级')}">↓</button></span></li>`;
    }).join('');
    return `<article class="panel provider-card group-card"><div class="provider-top"><div class="provider-mark">⛓</div><span class="status-pill ${g.enabled ? '' : 'off'}">${g.enabled ? t('已启用') : t('已停用')}</span></div><h3>${h(g.name)}</h3><code class="model-id">${h(g.id)}/…</code><p>${h(t('{count} 个账号 · 按优先级自动切换', { count: g.members.length }))}</p><ol class="group-member-list">${members}</ol><div class="provider-meta"><span>${h(t('{count} 个模型', { count: (g.modelIds || []).length }))}</span><span>·</span><span>${g.hideMembers !== false ? t('已隐藏单独入口') : t('保留单独入口')}</span></div><div class="provider-actions"><button class="button ghost" data-group-sync="${h(g.id)}" ${busy ? 'disabled' : ''}>${t('同步用量')}</button><button class="button ghost" data-group-clear="${h(g.id)}" ${busy ? 'disabled' : ''}>${t('重置冷却')}</button><button class="button ghost" data-group-edit="${h(g.id)}" ${busy ? 'disabled' : ''}>${t('编辑')}</button><button class="button ghost danger" data-group-delete="${h(g.id)}" ${busy ? 'disabled' : ''}>${t('删除')}</button></div></article>`;
  }).join('');
}

async function syncGroup(id) {
  busy = true;
  try { await api('/groups/' + id + '/sync', { method: 'POST' }); await load(); }
  catch (e) { errorBox('global-error', e.message); }
  finally { busy = false; renderProviders(); }
}

async function clearGroupCooldowns(id) {
  try { await api('/groups/' + id + '/clear-cooldowns', { method: 'POST' }); await load(); toast(t('冷却已重置')); }
  catch (e) { errorBox('global-error', e.message); }
}

async function moveGroupMember(groupId, memberId, delta) {
  const g = groupById(groupId); if (!g) return;
  const ids = g.members.map(m => m.id);
  const i = ids.indexOf(memberId), j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    await api('/groups/' + groupId, { method: 'PUT', body: JSON.stringify({ id: groupId, name: g.name, members: ids, enabled: g.enabled, hideMembers: g.hideMembers !== false }) });
    await load();
  } catch (e) { errorBox('global-error', e.message); }
}

function tokenMetricsMarkup(m) {
  if (!m) return '';
  const u = m.usage, val = n => Number.isFinite(n) ? n.toLocaleString(getLanguage()) : '—';
  return `<div class="muted small">${h(t('输入 / 输出 / 缓存'))}: ${val(u?.inputTokens)} / ${val(u?.outputTokens)} / ${val(u?.cachedInputTokens)}<br>${h(t('请求体积'))}: ${val(m.before?.requestBytes)} → ${val(m.after?.requestBytes)} B</div>`;
}
function renderLogs() {
  $('logs-empty').hidden = Boolean(state.logs.length);
  $('logs-body').innerHTML = state.logs.map(l => `<tr><td>${h(new Date(l.time).toLocaleTimeString(getLanguage()))}</td><td><code>${h(l.model)}</code>${l.error ? `<div class="log-error">${h(translateError(l.error))}</div>` : ''}</td><td>${h(l.endpoint)}${tokenMetricsMarkup(l.tokenMetrics)}</td><td><span class="source-badge ${l.status === 200 ? '' : 'bridge-badge'}">${l.status}</span></td><td>${(l.duration / 1000).toFixed(2)} s</td></tr>`).join('');
}
function capability() {
  const model = state.models.find(m => m.id === $('test-model').value);
  $('test-capability').textContent = model?.source === 'nas-codex' || model?.source === 'codex-group' ? t('远程 Codex 支持客户端工具调用；由客户端执行工具，远端负责推理。') : model?.source === 'claude-code' ? t('Claude Code 支持客户端 function/custom 工具；由客户端执行操作，容器负责推理。') : model?.source === 'grok-code' ? t('Grok 支持客户端 function/custom 工具；由客户端执行操作，容器负责推理。') : '';
}
const views = new Set(['overview', 'providers', 'proxies', 'images', 'videos', 'logs', 'tools', 'settings']);
function viewFromLocation() {
  const name = location.hash.replace(/^#\/?/, '');
  return views.has(name) ? name : 'overview';
}
function view(name, { updateUrl = true } = {}) {
  if (!views.has(name)) name = 'overview';
  currentView = name;
  document.querySelector('.stats').hidden = ['images', 'videos', 'tools', 'settings', 'proxies'].includes(name);
  $('add-btn').hidden = ['images', 'videos', 'tools', 'settings', 'proxies'].includes(name);
  imageUI.setVisible(name === 'images');
  videoUI.setVisible(name === 'videos');
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== name + '-view');
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  const names = { videos: [t('生成视频'), t('让描述动起来。'), t('用 Grok 订阅生成短片，可带最多 3 张参考图。')], tools: [t('工具下载'), t('常用工具，一处获取。'), t('检查更新并通过 OpenWrt 代理缓存安装包。')], settings: [t('设置'), t('管理你的模型港。'), t('配置管理页面的登录方式。')], images: [t('生成图像'), t('描述你的想象。'), t('从一句话开始，把想法变成可以保存的图像。')], overview: [t('模型总览'), t('所有模型，一个入口。'), t('连接不同来源，在同一份模型列表里自由选择。')], providers: [t('供应商'), t('连接你的模型来源。'), t('统一管理 API 服务与远程 Codex。')], proxies: [t('代理'), t('集中管理出站代理。'), t('保存常用代理，供应商直接选用。')], logs: [t('请求记录'), t('每一次调用，都有迹可循。'), t('检查路由结果、响应状态与请求耗时。')] };
  [$('page-name').textContent, $('heading').textContent, $('subtitle').textContent] = names[name];
  if (name === 'settings') loadSettings();
  if (name === 'tools') loadTools(); else stopToolPoll();
  if (name === 'proxies') renderProxies();
  if (name === 'providers') for (const p of state.providers) if ((p.type === 'nas-codex' || p.type === 'claude-code' || p.type === 'grok-code' || p.type === 'grok' || balanceProvider(p) || openCodeGoProvider(p)) && p.enabled) loadUsage(p.id);
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
  const type = $('p-type').value;
  const claude = type === 'claude-code';
  const grok = type === 'grok-code';
  const remote = type === 'nas-codex' || claude || grok;
  $('remote-codex-fields').hidden = !remote; $('http-fields').hidden = remote;
  $('p-url').required = !remote;
  ['p-host', 'p-user', 'p-ssh-key'].forEach(id => $(id).required = remote);
  const docker = $('p-execution').value === 'ssh-docker';
  $('p-container-label').hidden = !docker; $('p-container').required = remote && docker;
  $('p-docker-label').hidden = !docker; $('p-docker-path').required = remote && docker;
  $('p-codex-label').hidden = !remote;
  $('grok-options').hidden = type !== 'grok';
  if (type === 'grok') syncGrokMode();
  if (!remote) return;
  $('p-remote-notice').textContent = t(grok
    ? '通过 SSH 调用 Grok 官方 CLI，支持客户端 function/custom 工具；由客户端执行操作，容器负责推理。目标环境需安装并登录 Grok CLI，并部署工具执行器。'
    : claude
    ? '通过 SSH 调用 Claude Code，支持客户端工具和图片。目标环境需安装并登录 Claude Code，并部署工具执行器；工具由客户端执行。'
    : '通过 SSH 调用主机或容器里的官方 Codex CLI。支持文本、图片与客户端 function/custom 工具；由客户端执行命令和文件修改。目标环境需已安装并登录 Codex。');
  $('p-cli-label-text').textContent = t(grok ? 'Grok 可执行文件路径' : claude ? 'Claude Code 可执行文件路径' : 'Codex 可执行文件路径');
  $('p-cli-help').textContent = t(grok
    ? '填写目标主机或容器内的路径；默认 grok。需要 Linux、timeout、python3 和工具执行器；图片输入暂不支持。'
    : claude
    ? '填写目标主机或容器内的路径；仅当 PATH 包含 claude 时使用 claude。需要 Linux、timeout、python3 和工具执行器。'
    : '填写 Codex 命令或目标主机/容器内的绝对路径，默认 codex。使用官方 Codex CLI；无需安装 Python 执行器。');
  $('p-codex').placeholder = grok ? '/home/dev/.local/bin/grok' : claude ? '/home/dev/.local/bin/claude' : '/home/ubuntu/.local/bin/codex';
}

function fillProxySelect(selected) {
  const options = [`<option value="">${t('不使用代理')}</option>`]
    .concat((state.proxies || []).map(item => `<option value="${h(item.id)}">${h(item.name)}</option>`))
    .concat([`<option value="__custom">${t('自定义代理')}</option>`]);
  $('p-proxy-id').innerHTML = options.join('');
  $('p-proxy-id').value = selected;
}
function syncProxyMode() {
  const custom = $('p-proxy-id').value === '__custom';
  $('p-proxy-custom').hidden = !custom;
  if (!custom) $('p-proxy-enabled').checked = false;
}
function openEditor(id) {
  editing = id || null; $('provider-form').reset(); errorBox('editor-error');
  const p = id ? state.providers.find(p => p.id === id) : null;
  $('editor-title').textContent = p ? t('编辑供应商') : t('添加供应商');
  $('p-id').disabled = Boolean(p); $('preset-label').hidden = Boolean(p);
  $('p-type').value = p?.type || 'openai';
  $('p-execution').value = p?.execution || 'ssh-docker';
  $('p-codex').value = p ? (p.claudePath || p.codexPath || (p.type === 'claude-code' ? 'claude' : 'codex')) : 'codex';
  $('key-help').textContent = p?.hasApiKey ? t('已保存密钥，留空保持原值；输入新密钥可替换。') : t('密钥在服务端加密保存。');
  $('clear-key-label').hidden = !p?.hasApiKey;
  $('p-token-enabled').checked = p?.tokenOptimization?.enabled === true;
  $('p-token-usage').checked = p?.tokenOptimization?.captureStreamUsage === true;
  $('p-proxy-enabled').checked = p?.proxyEnabled === true;
  $('p-proxy-url').value = p?.proxyUrl || '';
  $('p-proxy-user').value = p?.proxyUsername || '';
  $('p-proxy-password').value = '';
  $('p-clear-proxy-password').checked = false;
  $('clear-proxy-password-label').hidden = !p?.hasProxyPassword;
  $('p-no-proxy').value = (p?.noProxy || []).join(', ');
  $('p-grok-auth-mode').value = p?.grokAuthMode || 'oauth';
  fillProxySelect(p ? (p.proxyId || (p.proxyUrl ? '__custom' : '')) : '');
  syncProxyMode();
  if (p) {
    const fields = { 'p-name': 'name', 'p-id': 'id', 'p-url': 'baseUrl', 'p-protocol': 'protocol', 'p-host': 'sshHost', 'p-user': 'sshUser', 'p-ssh-port': 'sshPort', 'p-ssh-key': 'sshKeyPath', 'p-container': 'container', 'p-docker-path': 'dockerPath', 'p-timeout': 'timeout' };
    for (const [id, key] of Object.entries(fields)) $(id).value = p[key] ?? '';
    $('p-ssh-port').value = p.sshPort || 22;
    $('p-docker-path').value = p.dockerPath || '/usr/local/bin/docker';
    $('p-models').value = p.models.join('\n'); $('p-enabled').checked = p.enabled;
  }
  syncOpenCodeGoPreset(); typeFields(); $('provider-dialog').showModal();
}
function syncGrokMode() {
  const oauth = $('p-grok-auth-mode').value === 'oauth';
  $('p-key-label').hidden = oauth;
  if (oauth) $('clear-key-label').hidden = true;
  $('p-url').placeholder = oauth ? 'https://cli-chat-proxy.grok.com/v1' : 'https://api.x.ai/v1';
}
$('p-grok-auth-mode').addEventListener('change', syncGrokMode);
$('p-proxy-id').addEventListener('change', syncProxyMode);
$('p-execution').addEventListener('change', typeFields);
function syncOpenCodeGoPreset() {
  const selected = $('preset').value === 'opencode-go';
  $('opencode-go-preset').hidden = !selected; $('provider-standard-fields').hidden = selected;
  $('save-provider').hidden = selected;
  for (const id of ['p-name', 'p-id', 'p-key', 'p-url', 'p-models', 'p-timeout']) $(id).required = !selected && (id === 'p-name' || id === 'p-id' || id === 'p-timeout');
  if (selected) for (const id of ['p-name', 'p-id', 'p-key', 'p-url', 'p-models']) $(id).disabled = true;
  else for (const id of ['p-name', 'p-id', 'p-key', 'p-url', 'p-models']) $(id).disabled = false;
}
$('preset').addEventListener('change', () => {
  const preset = $('preset').value;
  $('p-type').value = preset === 'remote-codex' ? 'nas-codex' : preset === 'claude-code' ? 'claude-code' : preset === 'grok-code' ? 'grok-code' : preset === 'grok-oauth' ? 'grok' : 'openai';
  if (preset === 'opencode-go') { syncOpenCodeGoPreset(); typeFields(); return; }
  syncOpenCodeGoPreset();
  const config = { custom: ['', '', '', 'chat'], deepseek: ['DeepSeek', 'deepseek', 'https://api.deepseek.com/v1', 'chat'], openai: ['OpenAI', 'openai', 'https://api.openai.com/v1', 'both'], 'remote-codex': [t('远程 Codex'), 'codex', '', 'chat'], 'claude-code': [t('Claude Code'), 'claude', '', 'chat'], 'grok-code': [t('Grok'), 'grok', '', 'chat'], 'grok-oauth': [t('Grok 订阅'), 'grokx', 'https://cli-chat-proxy.grok.com/v1', 'both'] }[preset];
  [$('p-name').value, $('p-id').value, $('p-url').value, $('p-protocol').value] = config;
  $('p-key').value = ''; $('p-models').value = '';
  if (preset === 'grok-oauth') {
    $('p-grok-auth-mode').value = 'oauth';
    $('p-models').value = 'grok-4.5\ngrok-4.3\ngrok-4.20-0309-reasoning';
    $('p-url').value = 'https://cli-chat-proxy.grok.com/v1';
  } else if (preset === 'grok-code') {
    $('p-execution').value = 'ssh-docker';
    $('p-container').value = 'claude-linux';
    $('p-codex').value = 'grok';
    $('p-ssh-key').value = '/home/node/.ssh/id_ed25519';
    $('p-ssh-port').value = '22';
    $('p-docker-path').value = '/usr/local/bin/docker';
    $('p-models').value = 'grok-4.7\ngrok-4.7-build-fast\ngrok-4.6\ngrok-4.5';
  } else if (preset === 'claude-code') {
    $('p-execution').value = 'ssh-docker';
    $('p-container').value = 'claude-linux';
    $('p-codex').value = 'claude';
    $('p-ssh-key').value = '/home/node/.ssh/id_ed25519';
    $('p-ssh-port').value = '22';
    $('p-docker-path').value = '/usr/local/bin/docker';
    $('p-models').value = 'sonnet\nopus\nhaiku';
  } else if (preset === 'remote-codex') {
    $('p-execution').value = 'ssh-docker';
    $('p-container').value = 'codex-linux';
    $('p-codex').value = 'codex';
    $('p-timeout').value = '600';
  }
  typeFields();
});
$('og-preset-open').addEventListener('click', event => {
  event.preventDefault(); openOpenCodeGo();
});
$('add-proxy').addEventListener('click', () => openProxyEditor());
$('proxy-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const input = { id: $('px-id').value.trim(), name: $('px-name').value, url: $('px-url').value.trim(),
    username: $('px-user').value.trim(), password: $('px-password').value, clearPassword: $('px-clear').checked,
    noProxy: $('px-no-proxy').value.split(/[\n,，\s]+/).map(v => v.trim()).filter(Boolean), enabled: $('px-enabled').checked };
  busy = true; $('save-proxy').disabled = true; errorBox('proxy-editor-error');
  try {
    await api('/proxies' + (proxyEditing ? '/' + proxyEditing : ''), { method: proxyEditing ? 'PUT' : 'POST', body: JSON.stringify(input) });
    $('proxy-dialog').close(); await load(); toast(t('代理已保存'));
  } catch (e) { errorBox('proxy-editor-error', e.message); }
  finally { busy = false; $('save-proxy').disabled = false; }
});
$('provider-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || $('preset').value === 'opencode-go') return;
  const input = { id: $('p-id').value.trim(), name: $('p-name').value, type: $('p-type').value, baseUrl: $('p-url').value.trim(), protocol: $('p-protocol').value, apiKey: $('p-key').value, clearApiKey: $('p-clear-key').checked, enabled: $('p-enabled').checked,
    models: $('p-models').value.split(/[\n,，]/).map(m => m.trim()).filter(Boolean), timeout: Number($('p-timeout').value), sshHost: $('p-host').value.trim(), sshUser: $('p-user').value.trim(), sshPort: Number($('p-ssh-port').value || 22), sshKeyPath: $('p-ssh-key').value.trim(), container: $('p-container').value.trim(), dockerPath: $('p-docker-path').value.trim(), execution: $('p-execution').value, codexPath: $('p-type').value === 'nas-codex' ? $('p-codex').value.trim() : undefined, claudePath: $('p-type').value === 'claude-code' ? $('p-codex').value.trim() : undefined, proxyEnabled: $('p-proxy-enabled').checked, proxyUrl: $('p-proxy-url').value.trim(), proxyUsername: $('p-proxy-user').value.trim(), proxyPassword: $('p-proxy-password').value, clearProxyPassword: $('p-clear-proxy-password').checked, grokAuthMode: $('p-grok-auth-mode').value, proxyId: $('p-proxy-id').value === '__custom' ? '' : $('p-proxy-id').value, noProxy: $('p-no-proxy').value.split(/[\n,，\s]+/).map(v => v.trim()).filter(Boolean) };
  if (input.type === 'openai') input.tokenOptimization = { ...(state.providers.find(p => p.id === editing)?.tokenOptimization || {}), enabled: $('p-token-enabled').checked, captureStreamUsage: $('p-token-usage').checked };
  busy = true; saving = true; $('save-provider').disabled = true; $('save-provider').textContent = t('正在保存…'); errorBox('editor-error');
  try {
    await api('/providers' + (editing ? '/' + editing : ''), { method: editing ? 'PUT' : 'POST', body: JSON.stringify(input) });
    usageById.delete(input.id);
    $('provider-dialog').close(); await load(); toast('供应商已保存，可点击「刷新模型」获取模型列表');
  } catch (e) { errorBox('editor-error', e.message); }
  finally { busy = false; saving = false; $('save-provider').disabled = false; $('save-provider').textContent = t('保存供应商'); renderProviders(); renderModels(); }
});
let ogAttempt = null, ogGeneration = 0, ogTimer = null;
function stopOpenCodeGo() {
  ogGeneration++; clearTimeout(ogTimer);
  const id = ogAttempt; ogAttempt = null;
  if (id) api('/opencode-go/auth/' + id + '/cancel', { method: 'POST' }).catch(() => {});
}
function openOpenCodeGo() {
  stopOpenCodeGo();
  $('opencode-go-form').reset(); $('og-prefix').value = 'ocgo'; $('og-prefix').disabled = false;
  $('og-auth').hidden = true; $('og-result').hidden = true; $('og-result').textContent = '';
  errorBox('og-error');
  $('og-submit').disabled = false; $('og-submit').textContent = t('浏览器授权并接入');
  $('opencode-go-dialog').showModal();
}
$('opencode-go-dialog').addEventListener('close', stopOpenCodeGo);
function showOpenCodeGoResult(result) {
  const skipped = Object.values(result.groups?.skipped || {}).flat();
  const lines = [t('已接入 {count} 个供应商。', {count: result.providers.length})];
  const chatCount = result.groups?.chat?.length || 0, responsesCount = result.groups?.responses?.length || 0;
  for (const provider of result.providers) lines.push('• ' + provider.name + ': ' + t('{count} 个模型', {count: provider.models.length}) + ' (' + t('Chat {chat} · Responses {responses}', {chat: chatCount, responses: responsesCount}) + ')');
  if (skipped.length) lines.push(t('已跳过 {count} 个仅 Anthropic/Google 或未识别的模型。', {count: skipped.length}) + '\n' + skipped.join(', '));
  $('og-result').textContent = lines.join('\n'); $('og-result').hidden = false;
}
async function pollOpenCodeGo(generation, delay) {
  ogTimer = setTimeout(async () => {
    if (generation !== ogGeneration || !ogAttempt) return;
    try {
      const response = await api('/opencode-go/auth/' + ogAttempt + '/poll', { method: 'POST' });
      if (generation !== ogGeneration) return;
      if (response.status === 'pending') return pollOpenCodeGo(generation, Math.max(5, response.interval || 5) * 1000);
      if (response.status !== 'complete') throw new Error(t('授权被取消、拒绝或已过期，请重新授权。'));
      ogAttempt = null; $('og-auth').hidden = true;
      showOpenCodeGoResult(response.result); await load(); toast(t('OpenCode Go 已接入'));
      $('og-prefix').disabled = false; $('og-submit').disabled = false; $('og-submit').textContent = t('浏览器授权并接入');
    } catch (error) {
      if (generation !== ogGeneration) return;
      stopOpenCodeGo(); errorBox('og-error', error.message); $('og-auth').hidden = true;
      $('og-prefix').disabled = false; $('og-submit').disabled = false; $('og-submit').textContent = t('浏览器授权并接入');
    }
  }, delay);
}
$('opencode-go-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('og-submit').disabled) return;
  stopOpenCodeGo(); const generation = ogGeneration;
  // Open synchronously so popup blockers do not discard the official login tab.
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  $('og-submit').disabled = true; $('og-prefix').disabled = true;
  $('og-submit').textContent = t('正在创建授权…'); errorBox('og-error'); $('og-result').hidden = true;
  try {
    const attempt = await api('/opencode-go/auth/start', { method: 'POST', body: JSON.stringify({ prefix: $('og-prefix').value.trim() }) });
    if (generation !== ogGeneration) {
      api('/opencode-go/auth/' + attempt.attemptId + '/cancel', { method: 'POST' }).catch(() => {});
      popup?.close(); return;
    }
    ogAttempt = attempt.attemptId;
    $('og-code').textContent = attempt.userCode; $('og-link').href = attempt.url;
    $('og-auth').hidden = false; $('og-submit').textContent = t('等待浏览器授权…');
    if (popup) popup.location.replace(attempt.url);
    pollOpenCodeGo(generation, attempt.interval * 1000);
  } catch (error) {
    popup?.close();
    if (generation !== ogGeneration) return;
    errorBox('og-error', error.message); $('og-prefix').disabled = false;
    $('og-submit').disabled = false; $('og-submit').textContent = t('浏览器授权并接入');
  }
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
let grokTarget = null;
function grokStatusText(p) {
  const g = p?.grok || {};
  if (g.mode !== 'oauth') return t('API Key 模式无需授权');
  if (g.authorized) return g.email ? t('已授权账号：{email}', { email: g.email }) : t('已授权');
  return g.expired ? t('授权已失效，请重新授权') : t('尚未授权');
}
function openGrokOAuth(id) {
  const p = state.providers.find(item => item.id === id);
  if (!p) return;
  grokTarget = id;
  errorBox('grok-oauth-error');
  $('grok-oauth-pending').hidden = true;
  $('grok-oauth-callback').value = '';
  $('grok-oauth-provider').textContent = `${p.name} · ${p.baseUrl}`;
  const status = $('grok-oauth-status'); status.hidden = false; status.textContent = grokStatusText(p);
  $('grok-oauth-revoke').hidden = !p.grok?.authorized;
  $('grok-oauth-start').textContent = t('开始授权');
  $('grok-oauth-dialog').showModal();
}
$('grok-oauth-start').addEventListener('click', async () => {
  if (!grokTarget || busy) return;
  errorBox('grok-oauth-error'); busy = true; $('grok-oauth-start').disabled = true;
  try {
    const result = await api('/providers/' + grokTarget + '/grok/oauth/start', { method: 'POST', body: '{}' });
    $('grok-oauth-link').href = result.url;
    $('grok-oauth-pending').hidden = false;
    $('grok-oauth-start').textContent = t('重新获取授权链接');
  } catch (e) { errorBox('grok-oauth-error', e.message); }
  finally { busy = false; $('grok-oauth-start').disabled = false; }
});
$('grok-oauth-finish').addEventListener('click', async () => {
  if (!grokTarget || busy) return;
  errorBox('grok-oauth-error'); busy = true; $('grok-oauth-finish').disabled = true;
  try {
    await api('/providers/' + grokTarget + '/grok/oauth/exchange', { method: 'POST', body: JSON.stringify({ callback: $('grok-oauth-callback').value.trim() }) });
    $('grok-oauth-dialog').close(); await load(); toast(t('Grok 授权完成'));
  } catch (e) { errorBox('grok-oauth-error', e.message); }
  finally { busy = false; $('grok-oauth-finish').disabled = false; }
});
$('grok-oauth-revoke').addEventListener('click', async () => {
  if (!grokTarget || busy) return;
  errorBox('grok-oauth-error'); busy = true;
  try {
    await api('/providers/' + grokTarget + '/grok/oauth/revoke', { method: 'POST', body: '{}' });
    $('grok-oauth-dialog').close(); await load(); toast(t('已解除 Grok 授权'));
  } catch (e) { errorBox('grok-oauth-error', e.message); }
  finally { busy = false; }
});
document.addEventListener('click', async event => {
  const el = event.target.closest('button'); if (!el) return;
  if (el.dataset.view) view(el.dataset.view);
  if (el.classList.contains('close-dialog')) el.closest('dialog').close();
  if (el.dataset.edit) openEditor(el.dataset.edit);
  if (el.dataset.grokOauth) openGrokOAuth(el.dataset.grokOauth);
  if (el.dataset.proxyEdit) openProxyEditor(el.dataset.proxyEdit);
  if (el.dataset.proxyTest && !busy) {
    busy = true; renderProxies();
    try {
      const result = await api('/proxies/' + el.dataset.proxyTest + '/test', { method: 'POST', body: '{}' });
      toast(result.ok ? t('代理可用（HTTP {status}，{ms} ms）', { status: result.status, ms: result.ms }) : t('代理不可用：{message}', { message: result.message || t('连接失败') }));
    } catch (e) { errorBox('global-error', e.message); }
    finally { busy = false; renderProxies(); }
  }
  if (el.dataset.proxyDelete && !busy) {
    const px = (state.proxies || []).find(item => item.id === el.dataset.proxyDelete);
    if (!px || !confirm(t('删除代理「{name}」？', { name: px.name }))) return;
    busy = true;
    try { await api('/proxies/' + px.id, { method: 'DELETE' }); await load(); toast(t('代理已删除')); }
    catch (e) { errorBox('global-error', e.message); }
    finally { busy = false; renderProxies(); }
  }
  if (el.dataset.groupEdit) openGroupEditor(el.dataset.groupEdit);
  if (el.dataset.groupSync) syncGroup(el.dataset.groupSync);
  if (el.dataset.groupClear) clearGroupCooldowns(el.dataset.groupClear);
  if (el.dataset.groupUp) moveGroupMember(el.dataset.group, el.dataset.groupUp, -1);
  if (el.dataset.groupDown) moveGroupMember(el.dataset.group, el.dataset.groupDown, 1);
  if (el.dataset.groupDelete && !busy) {
    const g = groupById(el.dataset.groupDelete);
    if (!g || !confirm(t('删除账号组「{name}」？组内供应商不会被删除。', { name: g.name }))) return;
    busy = true;
    try { await api('/groups/' + g.id, { method: 'DELETE' }); await load(); toast(t('账号组已删除')); }
    catch (e) { errorBox('global-error', e.message); }
    finally { busy = false; renderProviders(); }
  }
  if (el.dataset.usage) loadUsage(el.dataset.usage, true);
  if (el.dataset.resetUsage) openReset(el.dataset.resetUsage);
  if (el.dataset.refresh) refresh([el.dataset.refresh]);
  if (el.dataset.test) { $('test-model').value = el.dataset.test; capability(); $('test-prompt').focus(); }
  if (el.dataset.toolCheck !== undefined) checkToolUpdate();
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
function apiBase(protocol) { return protocol === 'anthropic' ? (state.baseUrl || '').replace(/\/v1\/?$/, '') : state.baseUrl || ''; }
function connectionURL() { return apiBase(connectionProtocol); }
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
$('copy-url-openai').addEventListener('click', () => copy(apiBase('openai')));
$('copy-url-anthropic').addEventListener('click', () => copy(apiBase('anthropic')));
$('connect-copy-url').addEventListener('click', () => copy(connectionURL()));
['add-btn', 'empty-add'].forEach(id => $(id).addEventListener('click', () => openEditor()));
$('add-group').addEventListener('click', () => openGroupEditor());
$('g-choices').addEventListener('change', event => {
  const id = event.target.dataset.gm; if (!id) return;
  if (event.target.checked) { if (!groupMemberIds.includes(id)) groupMemberIds.push(id); }
  else groupMemberIds = groupMemberIds.filter(m => m !== id);
  renderGroupChoices();
});
$('g-choices').addEventListener('click', event => {
  const el = event.target.closest('button[data-gmove]'); if (!el) return;
  const id = el.dataset.gmove, delta = Number(el.dataset.delta);
  const i = groupMemberIds.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= groupMemberIds.length) return;
  [groupMemberIds[i], groupMemberIds[j]] = [groupMemberIds[j], groupMemberIds[i]];
  renderGroupChoices();
});
$('group-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!groupMemberIds.length) return errorBox('group-error', t('请至少选择一个 Codex 供应商'));
  const payload = { id: $('g-id').value.trim(), name: $('g-name').value.trim(), members: groupMemberIds, enabled: $('g-enabled').checked, hideMembers: $('g-hide').checked };
  try {
    await api(groupEditing ? '/groups/' + groupEditing : '/groups', { method: groupEditing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    $('group-dialog').close(); await load(); toast(t('账号组已保存'));
  } catch (e) { errorBox('group-error', e.message); }
});
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
  videoUI.render();
  document.title = t('Model Harbor · 模型港');
  const en = getLanguage() === 'en';
  $('language-toggle').textContent = en ? '中文' : 'EN';
  $('language-toggle').setAttribute('aria-label', en ? 'Switch to Chinese' : '切换到英文');
  $('language-toggle').title = en ? 'Switch to Chinese' : '切换到英文';
  view(currentView);
  for (const [id, message] of errorsById) $(id).textContent = translateError(message) || '';
  renderTestOutput();
  renderSelectors(); renderModels(); renderProviders(); renderLogs(); capability();
  if ($('provider-dialog').open) typeFields();
  $('editor-title').textContent = t(editing ? '编辑供应商' : '添加供应商');
  $('key-help').textContent = t(editing && state.providers.find(p => p.id === editing)?.hasApiKey ? '已保存密钥，留空保持原值；输入新密钥可替换。' : '密钥在服务端加密保存。');
  $('save-provider').textContent = t(saving ? '正在保存…' : '保存供应商');
  if ($('opencode-go-dialog').open) $('og-submit').textContent = t(ogAttempt ? '等待浏览器授权…' : '浏览器授权并接入');
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
