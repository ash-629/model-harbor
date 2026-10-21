// I-01/I-02/I-05/I-06: natural-language image workspace, provider editor and durable history.
import { t, getLanguage, translateError } from './i18n.js';
const $ = id => document.getElementById(id);
const h = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const typeName = p => p.type === 'codex' ? 'Codex' : p.type === 'grok' ? 'Grok' : p.type === 'minimax' ? 'MiniMax API' : 'Images API';
const providerDisplayName = name => String(name || '').replace(/\bNAS\b/gi, t('远程主机'));
const active = job => ['queued', 'running'].includes(job.status);

export function createImageUI({ api, toast }) {
  let providers = [], jobs = [], visible = false, loading = false, submitting = false, saving = false, editing = null, poll;
  let references = [], uploading = false;
  const checks = new Set();
  const errorMessages = new Map();
  function error(id, message) {
    errorMessages.set(id, message || ''); $(id).hidden = !message; $(id).textContent = translateError(message || '');
  }
  async function load(force = false) {
    if (loading) { await loading; if (force) return load(); return; }
    loading = (async () => {
      try {
        const [p, j] = await Promise.all([api('/image/providers'), api('/image/jobs')]);
        providers = p.providers; jobs = j.jobs; render();
      } catch (e) { error('image-error', e.message); }
    })();
    try { await loading; } finally { loading = false; schedule(); }
  }
  function schedule() {
    clearTimeout(poll);
    if (visible && jobs.some(active)) poll = setTimeout(() => load(), 2500);
  }
  function setVisible(value) { visible = value; if (visible) load(); else clearTimeout(poll); }
  function providerNote() {
    const p = providers.find(p => p.id === $('image-provider').value);
    $('image-provider-note').textContent = !p ? t('添加并启用一个生图服务商后即可开始。') :
      `${typeName(p)} · ${p.model || t('Codex 默认模型')} · ${p.type === 'codex' ? t('比例作为提示，最终尺寸由生图工具决定。') : t('图片由服务商生成，原图保存在模型港。')}`;
    $('image-reference-section').hidden = !p?.supportsImageInput;
    $('image-reference-help').textContent = t(p?.type === 'minimax' ? 'MiniMax 使用人物主体参考；支持 PNG、JPEG、WebP，每张最多 5 MB。' : '支持 PNG、JPEG、WebP，每张最多 5 MB；按上传顺序引用图片。');
    renderReferences();
    $('image-prompt').maxLength = p?.type === 'minimax' ? 1500 : 16000;
  }
  function render() {
    const selected = $('image-provider').value, enabled = providers.filter(p => p.enabled);
    $('image-provider').innerHTML = enabled.length ? enabled.map(p => `<option value="${h(p.id)}">${h(p.name)}</option>`).join('') : `<option value="">${t('请先配置生图服务商')}</option>`;
    if (enabled.some(p => p.id === selected)) $('image-provider').value = selected;
    $('image-submit').disabled = submitting || uploading || !enabled.length;
    $('image-submit').textContent = t(submitting ? '正在提交…' : '生成图像 →');
    providerNote();
    $('image-providers-empty').hidden = Boolean(providers.length);
    $('image-providers-list').innerHTML = providers.map(p => `<article class="image-provider-item"><div class="image-provider-top"><strong>${h(p.name)}</strong><span class="status-pill ${p.enabled ? '' : 'off'}">${t(p.enabled ? '已启用' : '已停用')}</span></div><p>${typeName(p)} · ${h(p.model || t('默认模型'))}</p><div class="image-provider-actions"><button class="button ghost" data-image-check="${h(p.id)}" ${checks.has(p.id) ? 'disabled' : ''}>${t(checks.has(p.id) ? '检查中…' : '检查配置')}</button><button class="button ghost" data-image-edit="${h(p.id)}">${t('编辑')}</button><button class="button ghost danger" data-image-delete="${h(p.id)}">${t('删除')}</button></div></article>`).join('');
    $('image-jobs-empty').hidden = Boolean(jobs.length);
    $('image-jobs').innerHTML = jobs.map(job => {
      const status = { queued: t('排队中'), running: t('生成中'), completed: t('已完成'), failed: t('生成失败') }[job.status] || job.status;
      const dimensions = job.width && job.height ? `${job.width} × ${job.height}` : '';
      const elapsed = job.finishedAt && job.startedAt ? ` · ${Math.max(0, (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(0)} s` : '';
      return `<article class="panel image-job"><div class="image-job-preview ${active(job) ? 'image-in-progress' : ''}">${job.imageUrl ? `<a href="${h(job.imageUrl)}" target="_blank" rel="noopener"><img src="${h(job.imageUrl)}" loading="lazy" alt="${h(job.prompt)}"></a>` : `<span aria-hidden="true">${job.status === 'failed' ? '×' : '▧'}</span><p>${h(status)}</p>${job.status === 'queued' ? `<small>${t('等待前面的任务完成')}</small>` : ''}`}</div><div class="image-job-body"><div class="image-job-heading"><span class="source-badge ${job.status === 'failed' ? 'bridge-badge' : ''}">${h(status)}</span><small>${h(new Date(job.createdAt).toLocaleString(getLanguage()))}</small></div><p class="image-job-prompt">${h(job.prompt)}</p><p class="muted small">${h(providerDisplayName(job.providerName))} · ${h(job.model || 'Codex')} · ${h(job.aspect)}${job.referenceCount ? ' · ' + h(t('{count} 张参考图', {count: job.referenceCount})) : ''}${dimensions ? ' · ' + dimensions : ''}${elapsed}</p>${job.error ? `<div class="notice error">${h(translateError(job.error))}</div>` : ''}<div class="image-job-actions">${job.imageUrl ? `<a class="button secondary" href="${h(job.imageUrl)}?download=1" download>${t('下载原图 ↓')}</a>` : ''}<button class="button ghost" data-image-reuse="${h(job.id)}">${t('复用描述')}</button></div></div></article>`;
    }).join('');
    for (const [id, message] of errorMessages) $(id).textContent = translateError(message);
    $('image-save-provider').textContent = t(saving ? '正在保存…' : '保存生图配置');
    $('image-editor-title').textContent = t(editing ? '编辑生图服务商' : '配置生图服务商');
    editorFields();
  }
  function editorFields() {
    const type = $('ip-type').value, codex = type === 'codex', grok = type === 'grok', cli = codex || grok;
    const ssh = cli && $('ip-execution').value !== 'local', docker = ssh && $('ip-execution').value === 'ssh-docker';
    $('ip-api-fields').hidden = cli; $('ip-codex-fields').hidden = !cli; $('ip-ssh-fields').hidden = !ssh; $('ip-docker-fields').hidden = !docker;
    $('ip-sandbox-label').hidden = !codex;
    $('ip-sandbox').querySelector('option[value="danger-full-access"]').disabled = !codex || !docker;
    if (!docker || !codex) $('ip-sandbox').value = 'workspace-write';
    $('ip-api-fields').querySelectorAll('input').forEach(el => el.disabled = cli);
    $('ip-codex-fields').querySelectorAll('input,select').forEach(el => el.disabled = !cli);
    $('ip-ssh-fields').querySelectorAll('input').forEach(el => el.disabled = !ssh);
    $('ip-docker-fields').querySelectorAll('input').forEach(el => el.disabled = !docker);
    $('ip-model').placeholder = t(cli ? '可留空，例如：grok-4.7' : '例如：gpt-image-2');
    $('ip-url').required = !cli; $('ip-model').required = !cli;
    for (const id of ['ip-host', 'ip-user', 'ip-ssh-key', 'ip-runner']) $(id).required = ssh;
    for (const id of ['ip-container', 'ip-docker']) $(id).required = docker;
    $('ip-model-help').textContent = t(cli ? '可留空，使用 CLI 默认模型；不是图像模型 ID。' : '填写该服务商支持的生图模型。');
    $('ip-cli-label-text').textContent = t(grok ? 'Grok 命令或路径' : 'Codex 命令或路径');
    $('ip-cli-help').textContent = t(grok ? '填写目标环境中的 Grok 命令或绝对路径。' : '填写目标环境中的 Codex 命令或绝对路径。');
    $('ip-cli-notice').textContent = t(grok
      ? '本机是模型港服务所在机器；Grok 订阅出图需要已登录官方 Grok CLI。其他机器还需放置 Grok 执行器。'
      : '本机是模型港服务所在机器；需要已安装并登录 Codex。其他机器还需放置 Codex 执行器。');
    $('ip-codex').placeholder = grok ? '/home/dev/.local/bin/grok' : 'codex';
  }
  function preset() {
    const kind = $('ip-type').value;
    $('ip-url').value = kind === 'minimax' ? 'https://api.minimax.cn/v1' : 'https://api.openai.com/v1';
    $('ip-model').value = kind === 'codex' ? '' : kind === 'grok' ? 'grok-4.7' : kind === 'minimax' ? 'image-01' : 'gpt-image-2';
    if (kind === 'grok') {
      $('ip-codex').value = 'grok';
      $('ip-execution').value = 'ssh-docker';
      $('ip-container').value = 'claude-linux';
      $('ip-runner').value = '/workspace/model-harbor/grok-image-runner.py';
      $('ip-ssh-key').value = '/home/node/.ssh/id_ed25519';
    } else if (kind === 'codex') {
      $('ip-codex').value = 'codex';
    }
    editorFields();
  }
  function openEditor(id) {
    editing = id || null; $('image-provider-form').reset(); error('image-editor-error');
    const p = editing && providers.find(p => p.id === editing);
    $('ip-type').disabled = Boolean(p);
    if (p) {
      const fields = { 'ip-name': 'name', 'ip-type': 'type', 'ip-url': 'baseUrl', 'ip-model': 'model', 'ip-timeout': 'timeout', 'ip-execution': 'execution', 'ip-host': 'sshHost', 'ip-user': 'sshUser', 'ip-port': 'sshPort', 'ip-ssh-key': 'sshKeyPath', 'ip-runner': 'runnerPath', 'ip-container': 'container', 'ip-docker': 'dockerPath', 'ip-python': 'pythonPath', 'ip-codex': 'codexPath', 'ip-sandbox': 'sandbox' };
      for (const [id, field] of Object.entries(fields)) if (p[field] !== undefined) $(id).value = p[field];
      if (p.type === 'grok' && p.grokPath) $('ip-codex').value = p.grokPath;
      $('ip-enabled').checked = p.enabled; $('ip-image-input').checked = Boolean(p.supportsImageInput);
    } else preset();
    $('ip-clear-key-label').hidden = !p?.hasApiKey;
    render(); $('image-provider-dialog').showModal();
  }
  $('image-provider-form').addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return;
    saving = true; $('image-save-provider').disabled = true; error('image-editor-error'); render();
    const value = id => $(id).value.trim();
    const input = { name: value('ip-name'), type: value('ip-type'), baseUrl: value('ip-url'), model: value('ip-model'), apiKey: value('ip-key'), clearApiKey: $('ip-clear-key').checked, enabled: $('ip-enabled').checked, supportsImageInput: $('ip-image-input').checked,
      timeout: Number(value('ip-timeout')), execution: value('ip-execution'), sshHost: value('ip-host'), sshUser: value('ip-user'), sshPort: Number(value('ip-port')), sshKeyPath: value('ip-ssh-key'), runnerPath: value('ip-runner'),
      container: value('ip-container'), dockerPath: value('ip-docker'), pythonPath: value('ip-python'), codexPath: value('ip-codex'), grokPath: value('ip-codex'), sandbox: value('ip-sandbox') };
    try {
      const p = await api('/image/providers' + (editing ? '/' + editing : ''), { method: editing ? 'PUT' : 'POST', body: JSON.stringify(input) });
      $('image-provider-dialog').close(); await load(true); $('image-provider').value = p.id; providerNote(); toast(t('生图配置已保存'));
    } catch (e) { error('image-editor-error', e.message); }
    finally { saving = false; $('image-save-provider').disabled = false; render(); }
  });
  $('image-form').addEventListener('submit', async event => {
    event.preventDefault(); if (submitting || uploading) return;
    submitting = true; error('image-error'); render();
    try {
      await api('/image/jobs', { method: 'POST', body: JSON.stringify({ providerId: $('image-provider').value, prompt: $('image-prompt').value, aspect: $('image-aspect').value, references: providers.find(p => p.id === $('image-provider').value)?.supportsImageInput ? references.map(r => r.data) : [] }) });
      await load(true); toast(t('生图任务已提交，可在生成记录中查看进度'));
    } catch (e) { error('image-error', e.message); }
    finally { submitting = false; render(); schedule(); }
  });
  function renderReferences() {
    $('image-reference-previews').innerHTML = references.map((r, i) => `<div class="image-reference"><img src="${r.data}" alt="${h(r.name)}"><small>${i + 1}. ${h(r.name)}</small><button type="button" class="button ghost" data-reference-remove="${i}">${t('移除')}</button></div>`).join('');
    $('image-reference-input').disabled = uploading || submitting || references.length >= 3;
  }
  $('image-reference-input').addEventListener('change', async event => {
    const files = [...event.target.files]; event.target.value = ''; error('image-error');
    if (references.length + files.length > 3) return error('image-error', '最多上传 3 张参考图');
    uploading = true; render();
    try {
      const additions = [];
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 5 * 1024 * 1024) throw new Error('参考图必须为 PNG、JPEG 或 WebP，每张不超过 5 MB');
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('参考图读取失败')); reader.readAsDataURL(file); });
        await new Promise((resolve, reject) => { const img = new Image(); img.onload = resolve; img.onerror = () => reject(new Error('参考图格式无效')); img.src = data; });
        additions.push({ name: file.name, data });
      }
      references.push(...additions);
    } catch (e) { error('image-error', e.message); }
    finally { uploading = false; render(); }
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.referenceRemove !== undefined) { references.splice(Number(button.dataset.referenceRemove), 1); renderReferences(); }
    if (button.dataset.imageEdit) openEditor(button.dataset.imageEdit);
    if (button.dataset.imageReuse) {
      const job = jobs.find(j => j.id === button.dataset.imageReuse);
      if (!job) return;
      $('image-prompt').value = job.prompt; $('image-aspect').value = job.aspect;
      if (providers.some(p => p.id === job.providerId && p.enabled)) $('image-provider').value = job.providerId;
      providerNote(); $('image-prompt').focus(); $('image-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    if (button.dataset.imageCheck) {
      const id = button.dataset.imageCheck; const p = providers.find(value => value.id === id); if (!p || checks.has(id)) return; checks.add(id); render();
      try {
        const result = await api('/image/providers/' + id + '/check', { method: 'POST' });
        toast(t(result.verified === false ? 'API 配置已保存，实际可用性将在生成时验证。' : result.ok ? (p.type === 'grok' ? 'Grok 已就绪并已登录' : 'Codex 已就绪并已登录') : (p.type === 'grok' ? 'Grok 尚未登录，请先在目标环境登录' : 'Codex 尚未登录，请先在目标环境登录')));
      } catch (e) { error('image-error', e.message); }
      finally { checks.delete(id); render(); }
    }
    if (button.dataset.imageDelete) {
      const p = providers.find(p => p.id === button.dataset.imageDelete);
      if (!p || !confirm(t('删除生图服务商「{name}」？生成记录和图片会保留。', { name: p.name }))) return;
      button.disabled = true;
      try { await api('/image/providers/' + p.id, { method: 'DELETE' }); await load(true); toast(t('生图服务商已删除')); }
      catch (e) { error('image-error', e.message); button.disabled = false; }
    }
  });
  $('image-add-provider').addEventListener('click', () => openEditor());
  $('ip-type').addEventListener('change', preset); $('ip-execution').addEventListener('change', editorFields);
  $('image-provider').addEventListener('change', providerNote); $('image-refresh').addEventListener('click', load);
  $('image-provider-dialog').addEventListener('close', () => { $('ip-key').value = ''; });
  return { setVisible, render, load };
}
