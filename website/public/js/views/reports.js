// Reports tab: team summary charts and exports (CSV, Excel, PDF).
import { $, $$, esc, toast, day, barChart, seriesChart, statusLabel, priorityLabel } from '../ui.js';
import { STATUSES, PRIORITIES, isOverdue } from '../core.js';
import { saveFile } from '../native.js';

export function createReportsView(ctx, root) {
  const { t, api, store } = ctx;

  /** Offline fallback: the same numbers from this device's own copy. */
  function localSummary() {
    const recs = [...store.records.values()].filter((r) => !r.is_deleted);
    const count = (fn) => Object.entries(recs.reduce((m, r) => { const k = fn(r); m[k] = (m[k] || 0) + 1; return m; }, {})).map(([key, n]) => ({ key, n }));
    return {
      total: recs.length, overdue: recs.filter(isOverdue).length, due_week: null, open_conflicts: recs.filter((r) => r.sync_state === 'conflict').length,
      with_location: recs.filter((r) => r.geo).length, with_photos: recs.filter((r) => (r.attachments || []).length).length,
      by_status: count((r) => r.status), by_priority: count((r) => r.priority), by_assignee: count((r) => ctx.memberName(r.assigned_to) || t('records.unassigned')),
      created_per_day: [], overdue_list: recs.filter(isOverdue).map((r) => ({ ...r, assignee: ctx.memberName(r.assigned_to) })), local: true,
    };
  }

  async function render() {
    root.innerHTML = `<h2>${esc(t('reports.title'))}</h2><div id="rp-body" class="muted">${esc(t('common.loading'))}</div>`;
    let s;
    try { s = api.online ? await api.get('/api/reports/summary') : localSummary(); } catch { s = localSummary(); }
    const order = (rows, keys) => keys.map((k) => rows.find((r) => r.key === k) || { key: k, n: 0 });
    $('#rp-body', root).className = '';
    $('#rp-body', root).innerHTML = `
      ${s.local ? `<div class="hint">${esc(t('reports.local'))}</div>` : ''}
      <div class="tiles">
        ${[[t('reports.records'), s.total], [t('reports.overdue'), s.overdue], ...(s.due_week != null ? [[t('reports.due_week'), s.due_week]] : []),
    [t('reports.open_conflicts'), s.open_conflicts], [t('reports.with_gps'), s.with_location], [t('reports.with_photos'), s.with_photos]]
    .map(([l, n]) => `<div class="tile"><div class="num">${n}</div><div class="lbl">${esc(l)}</div></div>`).join('')}
      </div>
      <div class="chart-grid">
        <div class="card"><h3>${esc(t('reports.by_status'))}</h3>${barChart(order(s.by_status, STATUSES), { label: (r) => statusLabel(r.key) })}</div>
        <div class="card"><h3>${esc(t('reports.by_priority'))}</h3>${barChart(order(s.by_priority, PRIORITIES), { label: (r) => priorityLabel(r.key) })}</div>
        <div class="card"><h3>${esc(t('reports.by_assignee'))}</h3>${barChart(s.by_assignee.map((r) => ({ ...r, key: r.key === 'Unassigned' ? t('records.unassigned') : r.key })))}</div>
        ${s.created_per_day.length ? `<div class="card"><h3>${esc(t('reports.created_14'))}</h3>${seriesChart(s.created_per_day.map((d) => ({ label: day(d.day).replace(/,? \d{4}$/, ''), created: d.created })), [{ key: 'created', name: t('reports.created'), cls: 'a' }], { height: 140, width: 420 })}</div>` : ''}
      </div>
      <h3>${esc(t('reports.overdue_list'))}</h3>
      ${s.overdue_list.length ? `<table><thead><tr><th>${esc(t('field.title'))}</th><th>${esc(t('field.due_date'))}</th><th>${esc(t('field.assigned_to'))}</th><th>${esc(t('field.status'))}</th></tr></thead><tbody>
        ${s.overdue_list.map((r) => `<tr class="link-row" data-id="${esc(r.id)}"><td>${esc(r.title)}</td><td class="overdue">${esc(day(r.due_date))}</td><td>${esc(r.assignee || '')}</td><td>${esc(statusLabel(r.status))}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">${esc(t('reports.no_overdue'))}</div>`}
      <h3>${esc(t('reports.export'))}</h3>
      <div class="toolbar">
        <select id="rp-status"><option value="">${esc(t('records.all_status'))}</option>${STATUSES.map((x) => `<option value="${x}">${esc(statusLabel(x))}</option>`).join('')}</select>
        <select id="rp-priority"><option value="">${esc(t('reports.all_priorities'))}</option>${PRIORITIES.map((x) => `<option value="${x}">${esc(priorityLabel(x))}</option>`).join('')}</select>
        <label class="switch"><input type="checkbox" id="rp-overdue"><span>${esc(t('records.overdue_only'))}</span></label>
        <button class="secondary" data-format="csv">CSV</button>
        <button class="secondary" data-format="xlsx">Excel</button>
        <button class="secondary" data-format="pdf">PDF</button>
      </div>
      <p class="muted small">${esc(t('reports.export_help'))}</p>`;
    $$('.link-row', root).forEach((tr) => tr.addEventListener('click', () => { if (store.records.get(tr.dataset.id)) ctx.openEditor(tr.dataset.id); }));
    $$('[data-format]', root).forEach((b) => b.addEventListener('click', async () => {
      if (!api.online) { toast(t('reports.export_offline'), 'warn'); return; }
      const q = new URLSearchParams({ format: b.dataset.format });
      if ($('#rp-status', root).value) q.set('status', $('#rp-status', root).value);
      if ($('#rp-priority', root).value) q.set('priority', $('#rp-priority', root).value);
      if ($('#rp-overdue', root).checked) q.set('overdue', '1');
      b.disabled = true;
      try {
        const blob = await api.blob(`/api/reports/export?${q}`);
        await saveFile(blob, `syncsafe-report-${new Date().toISOString().slice(0, 10)}.${b.dataset.format}`);
      } catch (err) { toast(err.message, 'error'); } finally { b.disabled = false; }
    }));
  }

  return { render };
}
