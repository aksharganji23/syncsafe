// Admin tab: sync health and live charts (supervisors and admins), team, people and roles,
// devices, conflict rules, custom form fields, clean-up and fault injection (admins).
import { $, $$, esc, toast, when, seriesChart } from '../ui.js';

const FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox'];

export function createAdminView(ctx, root) {
  const { t, api } = ctx;
  let liveTimer = null;
  let fields = [];

  async function render() {
    clearInterval(liveTimer);
    if (!api.online) { root.innerHTML = `<div class="empty">${esc(t('admin.offline'))}</div>`; return; }
    const isAdmin = ctx.isAdmin();
    root.innerHTML = `
      <h2>${esc(t('admin.health'))}</h2><div id="ad-tiles" class="tiles"></div>
      <h3>${esc(t('admin.live'))}</h3><p class="muted small">${esc(t('admin.live_help'))}</p>
      <div class="chart-grid"><div class="card" id="ad-latency"></div><div class="card" id="ad-results"></div></div>
      <h3>${esc(t('admin.last7'))}</h3><div id="ad-days"></div>
      ${isAdmin ? `
      <h2>${esc(t('admin.team'))}</h2><div id="ad-team"></div>
      <h2>${esc(t('admin.people'))}</h2><div id="ad-users"></div>
      <h2>${esc(t('admin.devices'))}</h2><p class="muted small">${esc(t('admin.devices_help'))}</p><div id="ad-devices"></div>
      <h2>${esc(t('admin.rules'))}</h2><p class="muted small">${esc(t('admin.rules_help'))}</p><div id="ad-rules"></div>
      <h2>${esc(t('admin.forms'))}</h2><p class="muted small">${esc(t('admin.forms_help'))}</p><div id="ad-fields"></div>
      <h2>${esc(t('admin.cleanup'))}</h2><p class="muted small">${esc(t('admin.cleanup_help'))}</p><div id="ad-cleanup"></div>
      <h2>${esc(t('admin.fault'))}</h2><p class="muted small">${esc(t('admin.fault_help'))}</p>
      <div class="toolbar">
        <label>${esc(t('admin.fault_rate'))} <select id="ad-fault-rate"><option value="0">${esc(t('admin.off'))}</option><option value="0.3">30%</option><option value="0.5">50%</option><option value="0.8">80%</option></select></label>
        <label>${esc(t('admin.fault_mode'))} <select id="ad-fault-mode"><option value="before">${esc(t('admin.before'))}</option><option value="after">${esc(t('admin.after'))}</option></select></label>
        <button id="ad-fault-apply" class="secondary">${esc(t('common.apply'))}</button>
      </div>
      <h2>${esc(t('admin.monitoring'))}</h2><p class="muted small">${esc(t('admin.monitoring_help'))}</p>
      <p><a href="${esc((api.base || '') + '/metrics')}" target="_blank" rel="noopener">${esc((api.base || location.origin) + '/metrics')}</a></p>` : ''}`;
    await Promise.all([health(), live(), isAdmin ? adminSections() : null]);
    liveTimer = setInterval(() => { if (!root.hidden && api.online) live().catch(() => {}); else clearInterval(liveTimer); }, 10000);
  }

  async function health() {
    const h = await api.get('/api/admin/sync-health');
    const fails = h.days.reduce((n, d) => n + d.failures, 0);
    const pushes = h.days.reduce((n, d) => n + d.pushes, 0);
    const tiles = [
      [t('admin.records'), h.totals.records], [t('admin.devices_n'), h.devices.length], [t('admin.live_now'), h.live_connections],
      [t('reports.open_conflicts'), h.conflicts.open], [t('admin.resolved'), h.conflicts.resolved], [t('admin.restored'), h.totals.flagged],
      [t('admin.failure_rate'), pushes + fails ? `${Math.round((fails / (pushes + fails)) * 100)}%` : '0%'],
      [t('admin.database'), h.database === 'postgres' ? 'PostgreSQL' : 'PGlite'],
    ];
    $('#ad-tiles', root).innerHTML = tiles.map(([l, n]) => `<div class="tile"><div class="num">${esc(n)}</div><div class="lbl">${esc(l)}</div></div>`).join('');
    $('#ad-days', root).innerHTML = `<table><thead><tr><th>${esc(t('admin.day'))}</th><th>${esc(t('admin.pushes'))}</th><th>${esc(t('admin.pulls'))}</th><th>${esc(t('activity.applied'))}</th><th>${esc(t('activity.conflicts'))}</th><th>${esc(t('activity.rejected'))}</th><th>${esc(t('activity.duplicates'))}</th><th>${esc(t('admin.failures'))}</th><th>p95 ms</th></tr></thead><tbody>
      ${h.days.map((d) => `<tr><td>${esc(d.day)}</td><td>${d.pushes}</td><td>${d.pulls}</td><td>${d.applied}</td><td>${d.conflicts}</td><td>${d.rejected}</td><td>${d.duplicates}</td><td>${d.failures}</td><td>${d.p95_push_ms ?? ''}</td></tr>`).join('')}</tbody></table>`;
    if ($('#ad-fault-rate', root)) { $('#ad-fault-rate', root).value = String(h.fault.rate); $('#ad-fault-mode', root).value = h.fault.mode; }
    if ($('#ad-cleanup', root)) cleanup(h);
  }

  async function live() {
    const { minutes } = await api.get('/api/admin/metrics/live');
    const pts = minutes.map((m) => ({ ...m, label: m.minute }));
    $('#ad-latency', root).innerHTML = `<h3>${esc(t('admin.latency'))}</h3>${seriesChart(pts, [{ key: 'p50', name: 'p50 ms', cls: 'a' }, { key: 'p95', name: 'p95 ms', cls: 'b' }])}`;
    $('#ad-results', root).innerHTML = `<h3>${esc(t('admin.per_minute'))}</h3>${seriesChart(pts, [
      { key: 'applied', name: t('activity.applied'), cls: 'a' }, { key: 'conflicts', name: t('activity.conflicts'), cls: 'c' },
      { key: 'duplicates', name: t('activity.duplicates'), cls: 'b' }, { key: 'faults', name: t('admin.failures'), cls: 'd' }])}`;
  }

  async function adminSections() {
    const [settings, { users }, { devices }] = await Promise.all([api.get('/api/admin/settings'), api.get('/api/admin/users'), api.get('/api/devices')]);
    fields = settings.custom_fields.map((f) => ({ ...f }));
    team(settings);
    usersTable(users);
    devicesTable(devices);
    rules(settings);
    fieldsEditor();
    $('#ad-fault-apply', root).addEventListener('click', async () => {
      try {
        const { fault } = await api.post('/api/admin/fault', { rate: Number($('#ad-fault-rate', root).value), mode: $('#ad-fault-mode', root).value });
        toast(fault.rate ? t('admin.fault_on', { pct: fault.rate * 100, mode: t(`admin.${fault.mode}`) }) : t('admin.fault_off'), 'ok');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  function team(s) {
    $('#ad-team', root).innerHTML = `
      <div class="toolbar"><label>${esc(t('admin.team_name'))} <input id="ad-team-name" value="${esc(s.name)}" maxlength="60"></label>
        <button class="secondary" id="ad-team-save">${esc(t('common.save'))}</button></div>
      <div class="toolbar"><span>${esc(t('admin.invite'))}</span> <code class="invite" id="ad-invite">${esc(s.invite_code)}</code>
        <button class="ghost small-btn" id="ad-copy">${esc(t('admin.copy'))}</button>
        <button class="ghost small-btn" id="ad-regen">${esc(t('admin.regenerate'))}</button></div>
      <p class="muted small">${esc(t('admin.invite_help'))}</p>`;
    $('#ad-team-save', root).addEventListener('click', async () => {
      try { await api.post('/api/admin/settings', { team_name: $('#ad-team-name', root).value }); toast(t('admin.saved'), 'ok'); ctx.engine.dispatchEvent(new CustomEvent('team')); } catch (err) { toast(err.message, 'error'); }
    });
    $('#ad-copy', root).addEventListener('click', () => navigator.clipboard?.writeText($('#ad-invite', root).textContent).then(() => toast(t('admin.copied'), 'ok')).catch(() => {}));
    $('#ad-regen', root).addEventListener('click', async () => {
      if (!window.confirm(t('admin.regen_confirm'))) return;
      const { invite_code: code } = await api.post('/api/admin/invite/regenerate');
      $('#ad-invite', root).textContent = code;
    });
  }

  function usersTable(users) {
    $('#ad-users', root).innerHTML = `<table><thead><tr><th>${esc(t('auth.name'))}</th><th>${esc(t('auth.email'))}</th><th>${esc(t('admin.role'))}</th><th>${esc(t('admin.active'))}</th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
        <td><select data-role="${u.id}" ${u.id === ctx.user().id ? 'disabled' : ''}>${['admin', 'supervisor', 'field', 'viewer'].map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${esc(t(`role.${r}`))}</option>`).join('')}</select></td>
        <td><input type="checkbox" data-active="${u.id}" ${u.disabled ? '' : 'checked'} ${u.id === ctx.user().id ? 'disabled' : ''}></td></tr>`).join('')}</tbody></table>
      <p class="muted small">${esc(t('admin.roles_help'))}</p>`;
    $$('[data-role]', root).forEach((s) => s.addEventListener('change', async () => {
      try { await api.post(`/api/admin/users/${s.dataset.role}`, { role: s.value }); toast(t('admin.saved'), 'ok'); } catch (err) { toast(err.message, 'error'); }
    }));
    $$('[data-active]', root).forEach((c) => c.addEventListener('change', async () => {
      try { await api.post(`/api/admin/users/${c.dataset.active}`, { disabled: !c.checked }); toast(t('admin.saved'), 'ok'); } catch (err) { toast(err.message, 'error'); }
    }));
  }

  function devicesTable(devices) {
    $('#ad-devices', root).innerHTML = `<table><thead><tr><th>${esc(t('activity.device'))}</th><th>${esc(t('admin.user'))}</th><th>${esc(t('activity.last_seen'))}</th><th>${esc(t('admin.scope'))}</th><th></th></tr></thead><tbody>
      ${devices.map((d) => `<tr><td>${esc(d.name || d.id.slice(0, 8))}${d.revoked ? ` <span class="tag mini sync-rejected">${esc(t('activity.signed_out'))}</span>` : ''}</td><td>${esc(d.user_name)}</td><td>${esc(when(d.last_seen_at))}</td>
        <td>${esc(t(`scope.${d.scope?.mode || 'all'}`))}${d.scope?.area ? `: ${esc(d.scope.area)}` : ''}</td>
        <td>${!d.revoked && d.id !== api.deviceId ? `<button class="ghost small-btn" data-signout="${esc(d.id)}">${esc(t('admin.sign_out'))}</button> <button class="danger small-btn" data-wipe="${esc(d.id)}">${esc(t('admin.sign_out_wipe'))}</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
    const act = (attr, wipe) => $$(`[${attr}]`, root).forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm(t(wipe ? 'activity.revoke_confirm' : 'admin.signout_confirm'))) return;
      try { await api.post(`/api/devices/${b.getAttribute(attr)}/revoke`, { wipe }); toast(t('activity.revoked'), 'ok'); render(); } catch (err) { toast(err.message, 'error'); }
    }));
    act('data-signout', false);
    act('data-wipe', true);
  }

  function rules(s) {
    const names = Object.keys(s.rule_choices);
    $('#ad-rules', root).innerHTML = `<table><thead><tr><th>${esc(t('conflicts.field'))}</th><th>${esc(t('admin.when_both'))}</th></tr></thead><tbody>
      ${names.map((f) => `<tr><td>${esc(f === 'custom' ? t('admin.custom_fields') : t(`field.${f}`))}</td>
        <td><select data-rule="${f}">${s.rule_choices[f].map((c) => `<option value="${c}" ${s.rules[f] === c ? 'selected' : ''}>${esc(t(`rule.${c}`))}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table>
      <button class="secondary" id="ad-rules-save">${esc(t('admin.save_rules'))}</button>`;
    $('#ad-rules-save', root).addEventListener('click', async () => {
      const r = Object.fromEntries($$('[data-rule]', root).map((x) => [x.dataset.rule, x.value]));
      try { await api.post('/api/admin/settings', { rules: r }); toast(t('admin.saved'), 'ok'); ctx.engine.dispatchEvent(new CustomEvent('team')); } catch (err) { toast(err.message, 'error'); }
    });
  }

  function fieldsEditor() {
    const box = $('#ad-fields', root);
    box.innerHTML = `${fields.length ? `<table><thead><tr><th>${esc(t('admin.f_label'))}</th><th>${esc(t('admin.f_type'))}</th><th>${esc(t('admin.f_options'))}</th><th>${esc(t('admin.f_required'))}</th><th></th></tr></thead><tbody>
      ${fields.map((f, i) => `<tr>
        <td><input data-i="${i}" data-k="label" value="${esc(f.label)}" maxlength="60"></td>
        <td><select data-i="${i}" data-k="type">${FIELD_TYPES.map((ty) => `<option value="${ty}" ${ty === f.type ? 'selected' : ''}>${esc(t(`ftype.${ty}`))}</option>`).join('')}</select></td>
        <td><input data-i="${i}" data-k="options" value="${esc((f.options || []).join(', '))}" placeholder="${esc(t('admin.f_options_ph'))}" ${f.type === 'select' ? '' : 'disabled'}></td>
        <td><input type="checkbox" data-i="${i}" data-k="required" ${f.required ? 'checked' : ''}></td>
        <td><button class="ghost icon-btn" data-remove="${i}" aria-label="${esc(t('common.delete'))}">✕</button></td></tr>`).join('')}</tbody></table>` : `<div class="empty">${esc(t('admin.no_fields'))}</div>`}
      <div class="toolbar"><button class="ghost" id="ad-f-add">+ ${esc(t('admin.f_add'))}</button><span class="spacer"></span><button class="secondary" id="ad-f-save">${esc(t('admin.f_save'))}</button></div>`;
    $$('[data-k]', box).forEach((el) => el.addEventListener('change', () => {
      const f = fields[el.dataset.i];
      if (el.dataset.k === 'required') f.required = el.checked;
      else if (el.dataset.k === 'options') f.options = el.value.split(',').map((s) => s.trim()).filter(Boolean);
      else f[el.dataset.k] = el.value;
      if (el.dataset.k === 'label' && f.isNew) f.key = el.value;
      if (el.dataset.k === 'type') fieldsEditor();
    }));
    $$('[data-remove]', box).forEach((b) => b.addEventListener('click', () => { fields.splice(Number(b.dataset.remove), 1); fieldsEditor(); }));
    $('#ad-f-add', box).addEventListener('click', () => { fields.push({ key: t('admin.f_new'), label: t('admin.f_new'), type: 'text', options: [], required: false, isNew: true }); fieldsEditor(); });
    $('#ad-f-save', box).addEventListener('click', async () => {
      try {
        const s = await api.post('/api/admin/settings', { custom_fields: fields.map(({ isNew, ...f }) => ({ ...f, key: /^[a-z0-9_]+$/.test(f.key) ? f.key : `${f.key}`.replace(/[^\w]+/g, '_') || `field_${Date.now()}` })) });
        fields = s.custom_fields.map((f) => ({ ...f }));
        fieldsEditor();
        toast(t('admin.saved'), 'ok');
        ctx.engine.dispatchEvent(new CustomEvent('team'));
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  function cleanup(h) {
    const box = $('#ad-cleanup', root);
    box.innerHTML = `<div class="toolbar">
      <label>${esc(t('admin.retention'))} <input type="number" id="ad-ret" min="1" max="3650" value="${esc(ctx.team().retention_days || 30)}" style="width:6rem"></label>
      <button class="secondary" id="ad-ret-save">${esc(t('common.save'))}</button>
      <button class="ghost" id="ad-compact">${esc(t('admin.run_cleanup'))}</button></div>
      <p class="muted small">${esc(t('admin.last_cleanup', { when: h.last_compaction ? when(h.last_compaction) : t('admin.never') }))}</p>`;
    $('#ad-ret-save', box).addEventListener('click', async () => {
      try { await api.post('/api/admin/settings', { retention_days: Number($('#ad-ret', box).value) }); toast(t('admin.saved'), 'ok'); ctx.engine.dispatchEvent(new CustomEvent('team')); } catch (err) { toast(err.message, 'error'); }
    });
    $('#ad-compact', box).addEventListener('click', async () => {
      try {
        const r = await api.post('/api/admin/compact');
        toast(t('admin.cleanup_done', { n: r.tombstones_removed, log: r.log_rows_removed }), 'ok', 7000);
        health();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  return { render };
}
