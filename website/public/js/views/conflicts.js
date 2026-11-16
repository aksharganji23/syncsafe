// Conflicts tab: two devices changed the same protected field; a person decides.
import { $, $$, esc, toast, when, statusLabel } from '../ui.js';
import { STATUSES } from '../core.js';

export function createConflictsView(ctx, root) {
  const { t, api, engine } = ctx;

  const fieldLabel = (f) => (f.startsWith('custom.') ? (ctx.customFields().find((d) => `custom.${d.key}` === f)?.label || f) : t(`field.${f}`));
  const show = (f, v) => {
    if (v === null || v === undefined || v === '') return `<em>${esc(t('conflicts.empty_value'))}</em>`;
    if (f === 'status') return esc(statusLabel(v));
    if (f === 'assigned_to') return esc(ctx.memberName(v) || v);
    if (f === 'geo') return esc(`${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}`);
    return esc(typeof v === 'object' ? JSON.stringify(v) : String(v));
  };

  function editorFor(c, f) {
    const cur = c.current_value[f];
    const mine = c.local_value[f];
    if (f === 'status') return `<label>${esc(fieldLabel(f))}<select data-field="status">${STATUSES.map((s) => `<option value="${s}" ${s === mine ? 'selected' : ''}>${esc(statusLabel(s))}</option>`).join('')}</select></label>`;
    if (f === 'assigned_to') return `<label>${esc(fieldLabel(f))}<select data-field="assigned_to" data-type="int"><option value="">${esc(t('records.unassigned'))}</option>${ctx.members().map((m) => `<option value="${m.id}" ${m.id === mine ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>`;
    if (typeof cur === 'string' || typeof mine === 'string') {
      const start = c.suggested_value?.[f] ?? [cur, mine].filter(Boolean).join('\n---\n');
      return `<label>${esc(fieldLabel(f))} <span class="muted small">${c.suggested_value?.[f] ? `✨ ${esc(t('conflicts.suggested'))}` : ''}</span>
        <textarea data-field="${esc(f)}" rows="4">${esc(start)}</textarea></label>`;
    }
    return `<p class="muted small">${esc(t('conflicts.pick_one', { field: fieldLabel(f) }))}</p>`;
  }

  async function render() {
    root.innerHTML = `<h2>${esc(t('conflicts.title'))}</h2><p class="muted">${esc(t('conflicts.help'))}</p><div id="c-list"></div>`;
    const box = $('#c-list', root);
    if (!api.online) { box.innerHTML = `<div class="empty">${esc(t('conflicts.offline'))}</div>`; return; }
    box.innerHTML = `<div class="muted">${esc(t('common.loading'))}</div>`;
    let conflicts;
    try { ({ conflicts } = await api.get('/api/conflicts')); } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    await engine.reconcileConflicts().catch(() => {});
    if (!conflicts.length) { box.innerHTML = `<div class="empty">${esc(t('conflicts.none'))}</div>`; return; }
    box.innerHTML = conflicts.map((c) => `
      <div class="conflict" data-id="${c.id}" data-version="${c.record_version}">
        <strong>${esc(c.record_title || '')}</strong>
        <div class="muted small">${esc(t('conflicts.raised', { who: c.raised_by || '', when: when(c.created_at) }))}</div>
        <div class="conflict-grid">
          <div class="hdr">${esc(t('conflicts.field'))}</div><div class="hdr">${esc(t('conflicts.edit_from', { who: c.raised_by || '' }))}</div><div class="hdr">${esc(t('conflicts.current'))}</div>
          ${c.fields.map((f) => `<div><strong>${esc(fieldLabel(f))}</strong></div><div class="val">${show(f, c.local_value[f])}</div><div class="val">${show(f, c.current_value[f])}</div>`).join('')}
        </div>
        ${c.can_resolve ? `<div class="conflict-actions">
          <button class="primary" data-choice="mine">${esc(t('conflicts.keep_edit'))}</button>
          <button class="secondary" data-choice="theirs">${esc(t('conflicts.keep_current'))}</button>
          <button class="ghost" data-choice="combine">${esc(t('conflicts.combine'))}</button>
        </div>
        <div class="custom-box" hidden>${c.fields.map((f) => editorFor(c, f)).join('')}
          <div><button class="primary" data-choice="custom">${esc(t('conflicts.save_combined'))}</button></div></div>`
        : `<p class="muted small">${esc(t('conflicts.no_permission'))}</p>`}
      </div>`).join('');

    $$('.conflict', box).forEach((el) => {
      el.querySelectorAll('button[data-choice]').forEach((b) => b.addEventListener('click', async () => {
        if (b.dataset.choice === 'combine') { el.querySelector('.custom-box').hidden = false; return; }
        const values = {};
        el.querySelectorAll('[data-field]').forEach((i) => {
          values[i.dataset.field] = i.dataset.type === 'int' ? (i.value ? Number(i.value) : null) : i.value;
        });
        try {
          const { record } = await api.post(`/api/conflicts/${el.dataset.id}/resolve`, { choice: b.dataset.choice, values, seen_version: Number(el.dataset.version) });
          await engine.markResolved(record);
          toast(t('conflicts.resolved'), 'ok');
          render();
        } catch (err) {
          toast(err.message, err.status === 409 ? 'warn' : 'error', 8000);
          if (err.status === 409) { await engine.sync('conflict changed'); render(); }
        }
      }));
    });
  }

  return { render };
}
