// Sync activity tab: outbox, sync history, this device, what it keeps (partial sync),
// and the user's own devices (sign out a lost phone).
import { $, $$, esc, toast, when } from '../ui.js';

export function createActivityView(ctx, root) {
  const { t, api, store, engine } = ctx;

  function renderOutbox() {
    const box = $('#a-outbox', root);
    if (!box) return;
    const ops = [...store.outbox.values()].sort((a, b) => a.seq - b.seq);
    const uploads = [...store.files.values()].filter((f) => ['pending', 'uploading', 'failed', 'delete'].includes(f.status));
    const title = (id) => store.records.get(id)?.title || id.slice(0, 8);
    box.innerHTML = (ops.length || uploads.length) ? `
      <table><thead><tr><th>#</th><th>${esc(t('activity.type'))}</th><th>${esc(t('activity.record'))}</th><th>${esc(t('activity.fields'))}</th><th>${esc(t('activity.saved'))}</th><th>${esc(t('activity.attempts'))}</th></tr></thead><tbody>
      ${ops.map((o) => `<tr><td>${o.seq}</td><td>${esc(t(`op.${o.type}`))}</td><td>${esc(title(o.record_id))}</td>
        <td>${esc(Object.keys(o.fields || {}).map((k) => (k === 'custom' ? Object.keys(o.fields.custom).join(', ') : t(`field.${k}`))).join(', ') || '—')}</td>
        <td>${esc(when(o.created_at))}</td><td>${o.attempts || 0}${o.inflight ? ` (${esc(t('activity.sending'))})` : ''}</td></tr>`).join('')}
      ${uploads.map((f) => `<tr><td>📷</td><td>${esc(t(f.status === 'delete' ? 'op.photo_delete' : 'op.photo'))}</td><td>${esc(title(f.record_id || ''))}</td>
        <td>${esc(f.name || '')}</td><td>${esc(when(f.created_at))}</td><td>${f.size ? `${Math.round(((f.offset || 0) / f.size) * 100)}%` : ''}${f.error ? ` · ${esc(f.error)}` : ''}</td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">${esc(t('activity.outbox_empty'))}</div>`;
  }

  async function render() {
    const scope = store.secure.scope || { mode: 'all' };
    root.innerHTML = `
      <h2>${esc(t('activity.outbox'))}</h2><p class="muted">${esc(t('activity.outbox_help'))}</p><div id="a-outbox"></div>
      <h2>${esc(t('activity.scope'))}</h2>
      <p class="muted small">${esc(t('activity.scope_help'))}</p>
      <form id="a-scope" class="toolbar">
        <select name="mode">
          <option value="all" ${scope.mode === 'all' ? 'selected' : ''}>${esc(t('scope.all'))}</option>
          <option value="mine" ${scope.mode === 'mine' ? 'selected' : ''}>${esc(t('scope.mine'))}</option>
          <option value="area" ${scope.mode === 'area' ? 'selected' : ''}>${esc(t('scope.area'))}</option>
        </select>
        <input name="area" placeholder="${esc(t('scope.area_placeholder'))}" value="${esc(scope.area || '')}" ${scope.mode === 'area' ? '' : 'hidden'}>
        <button class="secondary">${esc(t('common.apply'))}</button>
      </form>
      <h2>${esc(t('activity.history'))}</h2><div id="a-history"></div>
      <h2>${esc(t('activity.devices'))}</h2><p class="muted small">${esc(t('activity.devices_help'))}</p><div id="a-devices"></div>
      <h2>${esc(t('activity.this_device'))}</h2>
      <div class="muted small">${esc(t('activity.device_info', { name: api.deviceName, id: api.deviceId, cursor: store.secure.cursor || 0, server: api.base || location.origin }))}</div>
      <p class="muted small">🔒 ${esc(t('activity.encrypted'))}</p>`;
    renderOutbox();
    const form = $('#a-scope', root);
    form.mode.addEventListener('change', () => { form.area.hidden = form.mode.value !== 'area'; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!api.online) { toast(t('activity.scope_offline'), 'warn'); return; }
      try {
        const { scope: s } = await api.post('/api/devices/me/scope', { mode: form.mode.value, area: form.area.value });
        await store.mutate((tx) => { tx.setSecure('scope', s); tx.setSecure('cursor', 0); });
        toast(t('activity.scope_saved'), 'ok');
        await engine.sync('scope changed');
        render();
      } catch (err) { toast(err.message, 'error'); }
    });
    if (!api.online) {
      $('#a-history', root).innerHTML = `<div class="empty">${esc(t('activity.history_offline'))}</div>`;
      $('#a-devices', root).innerHTML = '';
      return;
    }
    try {
      const { events } = await api.get('/api/sync/history');
      $('#a-history', root).innerHTML = events.length ? `<table><thead><tr><th>${esc(t('activity.when'))}</th><th>${esc(t('activity.device'))}</th><th>${esc(t('activity.type'))}</th><th>${esc(t('activity.applied'))}</th><th>${esc(t('activity.received'))}</th><th>${esc(t('activity.conflicts'))}</th><th>${esc(t('activity.rejected'))}</th><th>${esc(t('activity.duplicates'))}</th><th>ms</th></tr></thead><tbody>
        ${events.map((e) => `<tr><td>${esc(when(e.at))}</td><td>${esc(e.device_name || '')}</td><td>${esc(e.direction)}</td><td>${e.applied}</td><td>${e.received}</td><td>${e.conflicts}</td><td>${e.rejected}</td><td>${e.duplicates}</td><td>${e.latency_ms ?? ''}</td></tr>`).join('')}</tbody></table>`
        : `<div class="empty">${esc(t('activity.no_history'))}</div>`;
      const { devices } = await api.get('/api/devices');
      $('#a-devices', root).innerHTML = deviceTable(devices.filter((d) => d.user_id === ctx.user().id));
      wireDevices();
    } catch { /* optional sections */ }
  }

  function deviceTable(devices) {
    return `<table><thead><tr><th>${esc(t('activity.device'))}</th><th>${esc(t('activity.last_seen'))}</th><th></th></tr></thead><tbody>
      ${devices.map((d) => `<tr><td>${esc(d.name || d.id.slice(0, 8))}${d.id === api.deviceId ? ` <span class="tag mini">${esc(t('activity.this'))}</span>` : ''}${d.revoked ? ` <span class="tag mini sync-rejected">${esc(t('activity.signed_out'))}</span>` : ''}</td>
        <td>${esc(when(d.last_seen_at))}</td>
        <td>${d.id !== api.deviceId && !d.revoked ? `<button class="danger small-btn" data-revoke="${esc(d.id)}">${esc(t('activity.sign_out_wipe'))}</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  }

  function wireDevices() {
    $$('[data-revoke]', root).forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm(t('activity.revoke_confirm'))) return;
      try {
        await api.post(`/api/devices/${b.dataset.revoke}/revoke`, { wipe: true });
        toast(t('activity.revoked'), 'ok');
        render();
      } catch (err) { toast(err.message, 'error'); }
    }));
  }

  return { render, renderOutbox };
}
