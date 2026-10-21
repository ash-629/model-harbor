// G-04/G-05: video workspace for Grok subscription generation with up to 3 references.
import { t, translateError } from './i18n.js';
const $ = id => document.getElementById(id);
const h = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const active = job => ['queued', 'running'].includes(job.status);
export function createVideoUI({ api, toast }) {
  let providers = [], jobs = [], visible = false, loading = false, submitting = false, checking = false, poll;
  let references = [], uploading = false;
  const errorMessages = new Map();
  function error(id, message) {
    errorMessages.set(id, message || ''); $(id).hidden = !message; $(id).textContent = translateError(message || '');
  }
  async function load(force = false) {
    if (loading) { await loading; if (force) return load(); return; }
    loading = (async () => {
      try {
        const [p, j] = await Promise.all([api('/video/providers'), api('/video/jobs')]);
        providers = p.providers; jobs = j.jobs; render();
      } catch (e) { error('video-error', e.message); }
    })();
    try { await loading; } finally { loading = false; schedule(); }
  }
  function schedule() {
    clearTimeout(poll);
    if (visible && jobs.some(active)) poll = setTimeout(() => load(), 3000);
  }
  function setVisible(value) { visible = value; if (visible) load(); else clearTimeout(poll); }
  function provider() { return providers.find(p => p.id === $('video-provider').value); }
  function note() {
    const p = provider();
    $('video-provider-note').textContent = !p ? t('添加并启用一个视频服务商后即可开始。') : t('Grok 使用订阅视频工具生成，支持最多 3 张参考图；最终尺寸和编码由 Grok 决定。');
    $('video-submit').disabled = submitting || uploading || !p?.enabled;
  }
  function render() {
    const selected = $('video-provider').value, enabled = providers.filter(p => p.enabled);
    $('video-provider').innerHTML = enabled.length ? enabled.map(p => `<option value="${h(p.id)}">${h(p.name)}</option>`).join('') : `<option value="">${t('请先配置视频服务商')}</option>`;
    if (enabled.some(p => p.id === selected)) $('video-provider').value = selected;
    $('video-submit').textContent = t(submitting ? '正在提交…' : '生成视频 →');
    note();
    $('video-providers-empty').hidden = Boolean(providers.length);
    $('video-providers-list').innerHTML = providers.map(p => `<article class="image-provider-item"><div class="image-provider-top"><strong>${h(p.name)}</strong><span class="status-pill ${p.enabled ? '' : 'off'}">${t(p.enabled ? '已启用' : '已停用')}</span></div><p>Grok · ${h(p.model || 'grok-4.7')} · ${h(p.execution === 'ssh-docker' ? 'SSH + Docker' : p.execution === 'ssh' ? 'SSH' : 'Local')}</p><div class="image-provider-actions"><button class="button ghost" data-video-check="${h(p.id)}" ${checking ? 'disabled' : ''}>${t(checking ? '检查中…' : '检查配置')}</button></div></article>`).join('');
    $('video-jobs-empty').hidden = Boolean(jobs.length);
    $('video-jobs').innerHTML = jobs.map(job => {
      const status = { queued: t('排队中'), running: t('生成中'), completed: t('已完成'), failed: t('生成失败') }[job.status] || job.status;
      const elapsed = job.finishedAt && job.startedAt ? ` · ${Math.max(0, (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(0)} s` : '';
      const preview = job.videoUrl ? `<video src="${h(job.videoUrl)}" controls preload="metadata" aria-label="${h(job.prompt)}"></video>` : `<span aria-hidden="true">${job.status === 'failed' ? '×' : '▷'}</span><p>${h(status)}</p>${job.status === 'queued' ? `<small>${t('等待前面的任务完成')}</small>` : ''}`;
      return `<article class="panel image-job"><div class="image-job-preview ${active(job) ? 'image-in-progress' : ''}">${preview}</div><div class="image-job-body"><div class="image-job-heading"><strong>${h(status)}</strong><small>${h(job.aspect)} · ${job.duration}s · ${h(job.resolution)}${elapsed}</small></div><div class="image-job-prompt">${h(job.prompt)}</div>${job.error ? `<div class="notice error">${h(translateError(job.error))}</div>` : ''}<div class="image-job-actions"><span class="small">${h(job.providerName || '')} · ${job.referenceCount || 0} ${t('张参考图')}</span><div>${job.videoUrl ? `<a class="button ghost" href="${h(job.videoUrl)}?download=1" download>${t('下载视频')}</a>` : ''}<button class="button ghost" data-video-reuse="${h(job.id)}">${t('复用描述')}</button></div></div></div></article>`;
    }).join('');
    renderReferences();
  }
  function renderReferences() {
    $('video-reference-previews').innerHTML = references.map((r, i) => `<div class="image-reference"><img src="${r.data}" alt="${h(r.name)}"><small>${i + 1}. ${h(r.name)}</small><button type="button" class="button ghost" data-video-reference-remove="${i}">${t('移除')}</button></div>`).join('');
    $('video-reference-input').disabled = uploading || submitting || references.length >= 3;
  }
  $('video-form').addEventListener('submit', async event => {
    event.preventDefault(); if (submitting || uploading) return;
    submitting = true; error('video-error'); render();
    try {
      await api('/video/jobs', { method: 'POST', body: JSON.stringify({ providerId: $('video-provider').value, prompt: $('video-prompt').value, aspect: $('video-aspect').value, duration: Number($('video-duration').value), resolution: $('video-resolution').value, references: references.map(r => r.data) }) });
      await load(true); toast(t('视频任务已提交，可在生成记录中查看进度'));
    } catch (e) { error('video-error', e.message); }
    finally { submitting = false; render(); schedule(); }
  });
  $('video-reference-input').addEventListener('change', async event => {
    const files = [...event.target.files]; event.target.value = ''; error('video-error');
    if (references.length + files.length > 3) return error('video-error', '最多上传 3 张参考图');
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
    } catch (e) { error('video-error', e.message); }
    finally { uploading = false; render(); }
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.videoReferenceRemove !== undefined) { references.splice(Number(button.dataset.videoReferenceRemove), 1); renderReferences(); }
    if (button.dataset.videoReuse) {
      const job = jobs.find(j => j.id === button.dataset.videoReuse); if (!job) return;
      $('video-prompt').value = job.prompt; $('video-aspect').value = job.aspect; $('video-duration').value = String(job.duration); $('video-resolution').value = job.resolution;
      if (providers.some(p => p.id === job.providerId && p.enabled)) $('video-provider').value = job.providerId;
      note(); $('video-prompt').focus(); $('video-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    if (button.dataset.videoCheck) {
      if (checking) return; checking = true; render();
      try { const result = await api('/video/providers/' + button.dataset.videoCheck + '/check', { method: 'POST' }); toast(t(result.ok ? 'Grok 视频已就绪并已登录' : 'Grok 视频尚未登录，请先在目标环境登录')); }
      catch (e) { error('video-error', e.message); }
      finally { checking = false; render(); }
    }
  });
  $('video-provider').addEventListener('change', note);
  $('video-refresh').addEventListener('click', load);
  return { setVisible, render, load };
}
