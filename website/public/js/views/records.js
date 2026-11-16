// Records tab: search, filters, list, CSV import.
import { $, $$, esc, toast, when, day, statusLabel, priorityLabel } from '../ui.js';
import { parseCSV, validateRecord, isOverdue, STATUSES, PRIORITIES } from '../core.js';
import { importRecords } from '../repository.js';

export function createRecordsView(ctx, root) {
  const { t, store } = ctx;
  const state = { q: '', status: '', sync: '', who: '', overdue: false };
  const LIMIT = 300;

  function shell() {
    root.innerHTML = `
      <div class="toolbar">
        <input id="r-search" type="search" placeholder="${esc(t('records.search'))}" value="${esc(state.q)}">
        <select id="r-status"><option value="">${esc(t('records.all_status'))}</option>${STATUSES.map((s) => `<option value="${s}">${esc(statusLabel(s))}</option>`).join('')}</select>
        <select id="r-who">
          <option value="">${esc(t('records.everyone'))}</option>
          <option value="me">${esc(t('records.assigned_me'))}</option>
          <option value="unassigned">${esc(t('records.unassigned'))}</option>
        </select>
        <select id="r-sync"><option value="">${esc(t('records.any_sync'))}</option>
          <option value="pending">${esc(t('sync.pending'))}</option><option value="conflict">${esc(t('sync.conflict'))}</option><option value="rejected">${esc(t('sync.rejected'))}</option></select>
        <label class="switch"><input type="checkbox" id="r-overdue"><span>${esc(t('records.overdue_only'))}</span></label>
        <span class="spacer"></span>
        ${ctx.canEdit() ? `<label class="secondary file-btn">${esc(t('records.import'))}<input type="file" id="r-import" accept=".csv,text/csv" hidden></label>
        <button id="r-new" class="primary">+ ${esc(t('records.new'))}</button>` : ''}
      </div>
      <div id="r-count" class="muted small"></div>
      <div id="r-list" class="record-list"></div>`;
    $('#r-status', root).value = state.status;
    $('#r-sync', root).value = state.sync;
    $('#r-who', root).value = state.who;
    $('#r-overdue', root).checked = state.overdue;
    $('#r-search', root).addEventListener('input', (e) => { state.q = e.target.value; list(); });
    $('#r-status', root).addEventListener('change', (e) => { state.status = e.target.value; list(); });
    $('#r-sync', root).addEventListener('change', (e) => { state.sync = e.target.value; list(); });
    $('#r-who', root).addEventListener('change', (e) => { state.who = e.target.value; list(); });
    $('#r-overdue', root).addEventListener('change', (e) => { state.overdue = e.target.checked; list(); });
    $('#r-new', root)?.addEventListener('click', () => ctx.openEditor(null));
    $('#r-import', root)?.addEventListener('change', importCSV);
  }

  function list() {
    const me = ctx.user()?.id;
    const q = state.q.trim().toLowerCase();
    const deleting = new Set([...store.files.values()].filter((f) => f.status === 'delete').map((f) => f.id));
    const all = [...store.records.values()].filter((r) => !r.is_deleted);
    const rows = all
      .filter((r) => !q || [r.title, r.location, r.notes, ...Object.values(r.custom || {})].some((v) => String(v ?? '').toLowerCase().includes(q)))
      .filter((r) => !state.status || r.status === state.status)
      .filter((r) => !state.sync || r.sync_state === state.sync)
      .filter((r) => !state.who || (state.who === 'me' ? r.assigned_to === me : !r.assigned_to))
      .filter((r) => !state.overdue || isOverdue(r))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    $('#r-count', root).textContent = t('records.count', { shown: rows.length, total: all.length })
      + (rows.length > LIMIT ? ` · ${t('records.limited', { n: LIMIT })}` : '');
    const localFiles = [...store.files.values()];
    $('#r-list', root).innerHTML = rows.length ? rows.slice(0, LIMIT).map((r) => {
      const photos = (r.attachments || []).filter((a) => !deleting.has(a.id)).length + localFiles.filter((f) => f.record_id === r.id && (f.status === 'pending' || f.status === 'uploading')).length;
      const overdue = isOverdue(r);
      return `
      <button class="record" data-id="${esc(r.id)}">
        <div>
          <div class="title">${esc(r.title)}</div>
          <div class="sub">${esc(r.location || t('records.no_location'))} · ${esc(t('records.updated', { when: when(r.updated_at), who: r.updated_by || '' }))}</div>
          ${r.assigned_to || r.due_date ? `<div class="sub">${r.assigned_to ? `👤 ${esc(ctx.memberName(r.assigned_to) || '?')}` : ''}${r.due_date ? ` · <span class="${overdue ? 'overdue' : ''}">📅 ${esc(day(r.due_date))}${overdue ? ` (${esc(t('records.overdue'))})` : ''}</span>` : ''}</div>` : ''}
          ${r.error ? `<div class="error-line">${esc(r.error)}</div>` : ''}
        </div>
        <div class="tags">
          ${r.flagged ? `<span class="tag flag" title="${esc(t('records.restored_help'))}">${esc(t('records.restored'))}</span>` : ''}
          ${photos ? `<span class="tag" title="${esc(t('records.photos'))}">📷 ${photos}</span>` : ''}
          ${r.geo ? `<span class="tag" title="${esc(t('records.has_gps'))}">📍</span>` : ''}
          <span class="tag">${esc(statusLabel(r.status))}</span>
          <span class="tag ${esc(r.priority)}">${esc(priorityLabel(r.priority))}</span>
          <span class="tag sync-${esc(r.sync_state)}">${esc(t(`sync.${r.sync_state}`))}</span>
        </div>
      </button>`;
    }).join('') : `<div class="empty">${esc(all.length ? t('records.no_match') : t('records.empty'))}</div>`;
    $$('.record', root).forEach((el) => el.addEventListener('click', () => ctx.openEditor(el.dataset.id)));
  }

  async function importCSV(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const defs = ctx.customFields();
    const rows = parseCSV(await file.text()).map((r) => {
      const custom = {};
      for (const d of defs) {
        const raw = r[d.key] ?? r[d.label.toLowerCase()];
        if (raw === undefined || raw === '') continue;
        custom[d.key] = d.type === 'number' ? Number(raw) : d.type === 'checkbox' ? /^(1|yes|true|y)$/i.test(raw) : raw;
      }
      return {
        title: r.title || '', location: r.location || '',
        status: r.status || 'Pending', priority: r.priority || 'Medium', notes: r.notes || '',
        due_date: r.due_date || null, custom,
        geo: r.lat && r.lng && Number.isFinite(+r.lat) && Number.isFinite(+r.lng) ? { lat: +r.lat, lng: +r.lng, accuracy: null } : null,
      };
    });
    const good = [];
    const bad = [];
    rows.forEach((r, i) => {
      const errs = validateRecord(r, defs, { create: true });
      if (errs.length) bad.push(`${t('records.row', { n: i + 2 })}: ${errs.map((x) => t(x.key, x.vars)).join(', ')}`);
      else good.push(r);
    });
    const n = await importRecords(store, good, ctx.user());
    list();
    toast(t('records.imported', { n, bad: bad.length }), bad.length ? 'warn' : 'ok', 8000);
    bad.slice(0, 5).forEach((line) => toast(`${t('records.skipped')} ${line}`, 'error', 12000));
    ctx.engine.soon();
  }

  return {
    render() { shell(); list(); },
  };
}
