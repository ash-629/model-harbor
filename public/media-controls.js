import { t } from './i18n.js';
const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const active = job => ['queued', 'running'].includes(job.status);
export function createMediaControls({ kind, api, reload, error, toast }) {
  let offset = 0, total = 0, storage, busy = false;
  const selected = new Set(), panel = document.createElement('div');
  panel.className = 'panel media-management';
  document.getElementById(kind + '-jobs').before(panel);
  const dialog = document.createElement('dialog'); document.body.append(dialog);
  function render() {
    panel.innerHTML = `<p>${h(t('存储占用'))}: ${((storage?.bytes || 0) / 1048576).toFixed(1)} MiB · ${total} ${h(t('个任务'))} · ${storage?.active || 0} ${h(t('进行中'))}</p>
      <div class="media-toolbar"><button class="button ghost" data-page="prev" ${offset === 0 || busy ? 'disabled' : ''}>${t('上一页')}</button><span>${Math.floor(offset / 20) + 1} / ${Math.max(1, Math.ceil(total / 20))}</span><button class="button ghost" data-page="next" ${offset + 20 >= total || busy ? 'disabled' : ''}>${t('下一页')}</button><button class="button ghost danger" data-selected ${!selected.size || busy ? 'disabled' : ''}>${t('删除选中')} (${selected.size})</button></div>
      <div class="media-toolbar"><label>${t('清理早于天数')} <input type="number" data-days min="0" max="3650" value="30"></label><label>${t('目标容量 MiB（可选）')} <input type="number" data-cap min="0" placeholder="—"></label><button class="button secondary" data-preview ${busy ? 'disabled' : ''}>${t('预览清理')}</button></div><p class="muted small">${t('保留的作品不会被清理。新任务参考图保存 7 天；保留任务的参考图不自动过期。')}</p>`;
  }
  async function run(work) {
    if (busy) return; busy = true;
    try { await work(); await reload(true); }
    catch (e) { error(kind + '-error', e.message); }
    finally { busy = false; render(); }
  }
  panel.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || busy) return;
    if (button.dataset.page) { offset = Math.max(0, offset + (button.dataset.page === 'next' ? 20 : -20)); void reload(true); }
    if (button.hasAttribute('data-selected') && confirm(t('永久删除选中的任务与文件？'))) void run(async () => {
      for (const id of [...selected]) { await api(`/${kind}/jobs/${id}`, { method: 'DELETE' }); selected.delete(id); }
    });
    if (button.hasAttribute('data-preview')) {
      const olderDays = Number(panel.querySelector('[data-days]').value), cap = panel.querySelector('[data-cap]').value;
      void run(async () => {
        const plan = await api(`/${kind}/cleanup`, { method: 'POST', body: JSON.stringify({ olderDays, maxMiB: cap === '' ? null : Number(cap) }) });
        dialog.innerHTML = `<div class="dialog-body"><h2>${t('清理预览')}</h2><p>${plan.jobs.length} ${t('个任务')} · ${(plan.bytes / 1048576).toFixed(1)} MiB</p><div class="cleanup-list">${plan.jobs.map(j => `<p><code>${h(j.id)}</code><br>${h(new Date(j.createdAt).toLocaleString())} · ${(j.bytes / 1048576).toFixed(1)} MiB</p>`).join('')}</div><div class="media-toolbar"><button class="button secondary" data-close>${t('取消')}</button><button class="button danger" data-confirm ${!plan.jobs.length ? 'disabled' : ''}>${t('确认删除')}</button></div></div>`;
        dialog.querySelector('[data-close]').onclick = () => dialog.close();
        dialog.querySelector('[data-confirm]').onclick = () => { dialog.close(); void run(async () => { await api(`/${kind}/cleanup`, { method: 'POST', body: JSON.stringify({ token: plan.token }) }); selected.clear(); toast(t('清理完成')); }); };
        dialog.showModal();
      });
    }
  });
  document.getElementById(kind + '-jobs').addEventListener('change', event => {
    const id = event.target.dataset.mediaSelect;
    if (id) { if (event.target.checked) selected.add(id); else selected.delete(id); render(); }
  });
  document.getElementById(kind + '-jobs').addEventListener('click', event => {
    const button = event.target.closest('[data-media-action]'); if (!button || busy) return;
    const { mediaAction: action, jobId: id } = button.dataset;
    if (action === 'retry' && !confirm(t('重试会创建新任务。上次执行可能已消耗额度，确认继续？'))) return;
    if (action === 'delete' && !confirm(t('永久删除此任务与文件？'))) return;
    void run(async () => {
      await api(`/${kind}/jobs/${id}${action === 'delete' ? '' : '/' + action}`, { method: action === 'delete' ? 'DELETE' : 'POST', ...(action === 'pin' ? { body: JSON.stringify({ pinned: button.dataset.pinned !== 'true' }) } : {}) });
      selected.delete(id);
    });
  });
  return {
    render,
    query: () => `?offset=${offset}&limit=20`,
    renderPage(page) { total = page.total ?? page.jobs.length; storage = page.storage; if (offset > 0 && offset >= total) { offset = Math.max(0, Math.floor((total - 1) / 20) * 20); setTimeout(() => reload(true), 0); } render(); },
    get active() { return storage?.active || 0; },
    actions(job) { return `<div class="media-toolbar">${!active(job) && !job.pinned ? `<label><input type="checkbox" data-media-select="${h(job.id)}" ${selected.has(job.id) ? 'checked' : ''}>${t('选择')}</label>` : ''}<button class="button ghost" data-media-action="pin" data-job-id="${h(job.id)}" data-pinned="${!!job.pinned}">${t(job.pinned ? '取消保留' : '保留作品')}</button>${active(job) ? `<button class="button ghost" data-media-action="cancel" data-job-id="${h(job.id)}">${t('取消任务')}</button>` : `${['failed', 'cancelled'].includes(job.status) ? `<button class="button secondary" data-media-action="retry" data-job-id="${h(job.id)}">${t('重试任务')}</button>` : ''}${!job.pinned ? `<button class="button ghost danger" data-media-action="delete" data-job-id="${h(job.id)}">${t('删除')}</button>` : ''}`}</div>`; }
  };
}
