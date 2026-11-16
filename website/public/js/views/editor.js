// Record editor: fields, custom form fields, GPS, photos, assignment, AI suggestions,
// duplicate warning, voice input, history and undo.
import { $, $$, esc, toast, when, day, statusLabel, priorityLabel } from '../ui.js';
import { STATUSES, PRIORITIES, validateRecord, uuid } from '../core.js';
import { saveRecord, deleteRecord, restoreVersion, addAttachment, removeAttachment } from '../repository.js';
import { suggestPriority, suggestStatus, findDuplicates } from '../ai.js';
import { getLocation, takePhoto, NATIVE, speechSupported, listen, saveFile } from '../native.js';
import { lang } from '../i18n.js';

export function createEditor(ctx) {
  const { t, store, engine, api } = ctx;
  const dlg = $('#editor');
  const hist = $('#history-dialog');
  const photoDlg = $('#photo-dialog');
  let rec = null;           // record being edited (null = new)
  let draftId = null;       // id for a new record
  let geo = null;
  let newPhotos = [];       // files chosen before a new record is saved
  let stopVoice = null;
  const urls = [];

  const readOnly = () => !ctx.canEdit();

  function customInput(d, value) {
    const id = `cf-${d.key}`;
    const dis = readOnly() ? 'disabled' : '';
    if (d.type === 'checkbox') return `<label class="check"><input type="checkbox" id="${id}" data-custom="${esc(d.key)}" ${value ? 'checked' : ''} ${dis}> ${esc(d.label)}</label>`;
    if (d.type === 'select') {
      return `<label>${esc(d.label)}${d.required ? ' *' : ''}<select id="${id}" data-custom="${esc(d.key)}" ${dis}><option value=""></option>${d.options.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    }
    const type = d.type === 'number' ? 'number" step="any' : d.type === 'date' ? 'date' : 'text';
    return `<label>${esc(d.label)}${d.required ? ' *' : ''}<input type="${type}" id="${id}" data-custom="${esc(d.key)}" value="${esc(value ?? '')}" ${dis}></label>`;
  }

  function readCustom() {
    const out = {};
    for (const d of ctx.customFields()) {
      const el = $(`#cf-${d.key}`, dlg);
      if (!el) continue;
      if (d.type === 'checkbox') out[d.key] = el.checked ? true : null;
      else if (d.type === 'number') out[d.key] = el.value === '' ? null : Number(el.value);
      else out[d.key] = el.value === '' ? null : el.value;
    }
    return out;
  }

  function readForm() {
    const f = $('#ed-form', dlg);
    return {
      title: f.title.value, location: f.location.value, status: f.status.value, priority: f.priority.value,
      notes: f.notes.value, due_date: f.due_date.value || null,
      assigned_to: f.assigned_to?.value ? Number(f.assigned_to.value) : null,
      geo, custom: readCustom(),
    };
  }

  function geoText() {
    return geo ? `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}${geo.accuracy != null ? ` (±${Math.round(geo.accuracy)} m)` : ''}` : t('editor.no_gps');
  }

  async function open(id, { prefill } = {}) {
    rec = id ? store.records.get(id) : null;
    draftId = rec ? rec.id : uuid();
    geo = rec?.geo || null;
    newPhotos = [];
    const r = rec || { status: 'Pending', priority: 'Medium', custom: {}, ...(prefill || {}) };
    if (prefill?.geo) geo = prefill.geo;
    const members = ctx.members();
    const dis = readOnly() ? 'disabled' : '';
    dlg.innerHTML = `
      <form id="ed-form" method="dialog" class="stack">
        <div class="dialog-head"><h2>${esc(rec ? (readOnly() ? t('editor.view') : t('editor.edit')) : t('editor.new'))}</h2>
          <button type="button" class="ghost icon-btn" id="ed-x" aria-label="${esc(t('common.close'))}">✕</button></div>
        <div id="ed-error" class="error-box" hidden></div>
        ${rec?.sync_state === 'conflict' ? `<div class="hint warn">${esc(t('editor.conflict_hint'))}</div>` : ''}
        <label>${esc(t('field.title'))} *<input name="title" maxlength="120" required value="${esc(r.title || '')}" ${dis}></label>
        <div id="ed-dupes"></div>
        <label>${esc(t('field.location'))}<input name="location" maxlength="120" value="${esc(r.location || '')}" ${dis}></label>
        <div class="gps-row"><span>📍 <span id="ed-geo">${esc(geoText())}</span></span>
          ${readOnly() ? '' : `<button type="button" class="secondary small-btn" id="ed-gps">${esc(t('editor.use_gps'))}</button>
          <button type="button" class="ghost small-btn" id="ed-gps-clear" ${geo ? '' : 'hidden'}>${esc(t('common.clear'))}</button>`}
          ${geo ? `<button type="button" class="ghost small-btn" id="ed-gps-map">${esc(t('editor.show_map'))}</button>` : ''}</div>
        <div class="row2">
          <label>${esc(t('field.status'))}<select name="status" ${dis}>${STATUSES.map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${esc(statusLabel(s))}</option>`).join('')}</select></label>
          <label>${esc(t('field.priority'))}<select name="priority" ${dis}>${PRIORITIES.map((p) => `<option value="${p}" ${p === r.priority ? 'selected' : ''}>${esc(priorityLabel(p))}</option>`).join('')}</select></label>
        </div>
        <div id="ed-suggest" class="suggest"></div>
        <div class="row2">
          <label>${esc(t('field.due_date'))}<input type="date" name="due_date" value="${esc(r.due_date || '')}" ${dis}></label>
          <label>${esc(t('field.assigned_to'))}<select name="assigned_to" ${ctx.canAssign() ? '' : 'disabled'}>
            <option value="">${esc(t('records.unassigned'))}</option>
            ${members.filter((m) => m.role !== 'viewer').map((m) => `<option value="${m.id}" ${m.id === r.assigned_to ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
        </div>
        ${ctx.customFields().length ? `<fieldset class="custom-fields"><legend>${esc(t('editor.form_fields'))}</legend>${ctx.customFields().map((d) => customInput(d, r.custom?.[d.key])).join('')}</fieldset>` : ''}
        <label>${esc(t('field.notes'))}
          <textarea name="notes" rows="4" maxlength="5000" ${dis}>${esc(r.notes || '')}</textarea></label>
        <div class="notes-tools">
          ${!readOnly() && speechSupported() ? `<button type="button" class="ghost small-btn" id="ed-mic">🎤 ${esc(t('editor.dictate'))}</button>` : ''}
          ${!readOnly() && NATIVE ? `<span class="muted small">${esc(t('editor.keyboard_mic'))}</span>` : ''}
        </div>
        <fieldset class="photos"><legend>${esc(t('editor.photos'))}</legend>
          <div id="ed-photos" class="photo-grid"></div>
          ${readOnly() ? '' : `<div class="photo-actions">
            ${NATIVE ? `<button type="button" class="secondary small-btn" id="ed-camera">📷 ${esc(t('editor.add_photo'))}</button>` : ''}
            <label class="secondary file-btn small-btn">${NATIVE ? esc(t('editor.add_file')) : `📷 ${esc(t('editor.add_photo'))}`}
              <input type="file" id="ed-file" accept="image/*,application/pdf" ${NATIVE ? '' : 'capture="environment"'} multiple hidden></label></div>`}
        </fieldset>
        <div id="ed-meta" class="muted small">${rec ? esc(t('editor.meta', { v: rec.version || t('editor.not_on_server'), state: t(`sync.${rec.sync_state}`), who: rec.updated_by || '', when: when(rec.updated_at) })) : esc(t('editor.saved_first'))}</div>
        <div class="dialog-actions">
          ${rec ? `<button type="button" class="ghost" id="ed-history">${esc(t('editor.history'))}</button>` : ''}
          ${rec && ctx.canDelete(rec) ? `<button type="button" id="ed-delete" class="danger">${esc(t('common.delete'))}</button>` : ''}
          <span class="spacer"></span>
          <button type="button" id="ed-cancel" class="ghost">${esc(readOnly() ? t('common.close') : t('common.cancel'))}</button>
          ${readOnly() ? '' : `<button type="submit" class="primary">${esc(t('common.save'))}</button>`}
        </div>
      </form>`;
    wire();
    renderPhotos();
    updateSuggestions();
    dlg.showModal();
  }

  function wire() {
    const f = $('#ed-form', dlg);
    $('#ed-x', dlg).addEventListener('click', close);
    $('#ed-cancel', dlg).addEventListener('click', close);
    f.addEventListener('submit', submit);
    f.title.addEventListener('input', updateSuggestions);
    f.location.addEventListener('input', updateSuggestions);
    f.notes.addEventListener('input', updateSuggestions);
    $('#ed-gps', dlg)?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = t('editor.locating');
      try {
        geo = await getLocation();
        $('#ed-geo', dlg).textContent = geoText();
        $('#ed-gps-clear', dlg).hidden = false;
        updateSuggestions();
      } catch (err) {
        toast(['no_gps', 'gps_denied', 'gps_failed'].includes(err.message) ? t(`gps.${err.message}`) : err.message, 'error', 7000);
      } finally {
        e.target.disabled = false;
        e.target.textContent = t('editor.use_gps');
      }
    });
    $('#ed-gps-clear', dlg)?.addEventListener('click', (e) => { geo = null; $('#ed-geo', dlg).textContent = geoText(); e.target.hidden = true; });
    $('#ed-gps-map', dlg)?.addEventListener('click', () => { close(); ctx.switchTab('map'); setTimeout(() => ctx.engine.dispatchEvent(new CustomEvent('focus-map', { detail: rec?.id })), 50); });
    $('#ed-delete', dlg)?.addEventListener('click', async () => {
      if (!window.confirm(t('editor.delete_confirm'))) return;
      await deleteRecord(store, rec.id);
      close();
      ctx.rerender();
      engine.soon();
    });
    $('#ed-history', dlg)?.addEventListener('click', () => openHistory(rec));
    $('#ed-camera', dlg)?.addEventListener('click', async () => {
      try {
        const file = await takePhoto();
        if (file) await addPhotos([file]);
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#ed-file', dlg)?.addEventListener('change', async (e) => { await addPhotos([...e.target.files]); e.target.value = ''; });
    $('#ed-mic', dlg)?.addEventListener('click', (e) => {
      if (stopVoice) { stopVoice(); return; }
      const btn = e.target;
      btn.classList.add('recording');
      btn.textContent = `⏺ ${t('editor.listening')}`;
      stopVoice = listen(lang(), (text) => {
        const ta = $('#ed-form', dlg).notes;
        ta.value = `${ta.value}${ta.value && !/\s$/.test(ta.value) ? ' ' : ''}${text}`;
        updateSuggestions();
      }, () => { stopVoice = null; btn.classList.remove('recording'); btn.textContent = `🎤 ${t('editor.dictate')}`; });
    });
  }

  function close() {
    if (stopVoice) stopVoice();
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
    dlg.close();
  }

  function updateSuggestions() {
    if (readOnly()) return;
    const v = readForm();
    const box = $('#ed-suggest', dlg);
    const chips = [];
    const p = suggestPriority(v);
    if (p && p.value !== v.priority) chips.push({ field: 'priority', value: p.value, label: t('ai.priority', { value: priorityLabel(p.value), why: p.reason }) });
    const s = suggestStatus(v);
    if (s && s.value !== v.status) chips.push({ field: 'status', value: s.value, label: t('ai.status', { value: statusLabel(s.value), why: s.reason }) });
    box.innerHTML = chips.map((c, i) => `<button type="button" class="suggest-chip" data-i="${i}">✨ ${esc(c.label)}</button>`).join('');
    $$('.suggest-chip', box).forEach((b) => b.addEventListener('click', () => {
      const c = chips[b.dataset.i];
      $('#ed-form', dlg)[c.field].value = c.value;
      updateSuggestions();
    }));
    const others = [...store.records.values()].filter((x) => x.id !== draftId);
    const dupes = v.title.trim().length >= 4 && (!rec || v.title !== rec.title) ? findDuplicates({ ...v, id: draftId }, others) : [];
    $('#ed-dupes', dlg).innerHTML = dupes.length ? `<div class="hint warn">${esc(t('ai.duplicates'))}${dupes.map((d, i) => `
      <div class="dupe"><span><strong>${esc(d.record.title)}</strong> · ${esc(d.record.location || '')} <span class="muted small">(${esc(d.reason)})</span></span>
      <button type="button" class="ghost small-btn" data-dupe="${i}">${esc(t('common.open'))}</button></div>`).join('')}</div>` : '';
    $$('[data-dupe]', dlg).forEach((b) => b.addEventListener('click', () => open(dupes[b.dataset.dupe].record.id)));
  }

  async function addPhotos(files) {
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) { toast(t('editor.too_large', { name: file.name }), 'error'); continue; }
      if (!rec) { newPhotos.push(file); continue; }
      try {
        await addAttachment(store, rec.id, file);
      } catch (err) {
        toast(err.message === 'too_large' ? t('editor.too_large', { name: file.name }) : err.message, 'error');
      }
    }
    renderPhotos();
    if (rec) engine.soon();
  }

  async function renderPhotos() {
    const grid = $('#ed-photos', dlg);
    if (!grid) return;
    const deleting = new Set([...store.files.values()].filter((f) => f.status === 'delete').map((f) => f.id));
    const server = rec ? (rec.attachments || []).filter((a) => !deleting.has(a.id)) : [];
    const serverIds = new Set(server.map((a) => a.id));
    const local = rec ? [...store.files.values()].filter((f) => f.record_id === rec.id && !serverIds.has(f.id) && ['pending', 'uploading', 'failed'].includes(f.status)) : [];
    const items = [
      ...server.map((a) => ({ ...a, state: a.uploaded ? 'synced' : 'uploading' })),
      ...local.map((f) => ({ ...f, state: f.status })),
      ...newPhotos.map((f, i) => ({ id: `new-${i}`, name: f.name, mime: f.type, file: f, state: 'unsaved' })),
    ];
    if (!items.length) { grid.innerHTML = `<div class="muted small">${esc(t('editor.no_photos'))}</div>`; return; }
    grid.innerHTML = items.map((a) => `
      <div class="photo" data-id="${esc(a.id)}">
        <button type="button" class="photo-open" data-id="${esc(a.id)}"><span class="photo-ph">${a.mime?.startsWith('image/') ? '🖼️' : '📄'}</span></button>
        <div class="photo-cap"><span class="ellipsis">${esc(a.name)}</span><span class="tag mini sync-${a.state === 'synced' ? 'synced' : a.state === 'failed' ? 'rejected' : 'pending'}">${esc(t(`photo.${a.state}`))}</span></div>
        ${readOnly() ? '' : `<button type="button" class="ghost icon-btn photo-del" data-id="${esc(a.id)}" aria-label="${esc(t('common.delete'))}">✕</button>`}
      </div>`).join('');
    for (const a of items) {
      const el = $(`.photo[data-id="${CSS.escape(a.id)}"] .photo-open`, grid);
      el.addEventListener('click', () => viewPhoto(a));
      if (a.mime?.startsWith('image/')) {
        thumb(a).then((url) => { if (url) el.innerHTML = `<img src="${url}" alt="${esc(a.name)}">`; }).catch(() => {});
      }
    }
    $$('.photo-del', grid).forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      if (id.startsWith('new-')) newPhotos.splice(Number(id.slice(4)), 1);
      else {
        if (!window.confirm(t('editor.photo_delete'))) return;
        await removeAttachment(store, id);
        engine.soon();
      }
      renderPhotos();
    }));
  }

  async function bytesOf(a) {
    if (a.file) return new Uint8Array(await a.file.arrayBuffer());
    return engine.attachmentBytes({ ...a, record_id: rec?.id });
  }

  async function thumb(a) {
    const bytes = await bytesOf(a);
    if (!bytes) return null;
    const url = URL.createObjectURL(new Blob([bytes], { type: a.mime }));
    urls.push(url);
    return url;
  }

  async function viewPhoto(a) {
    let bytes;
    try { bytes = await bytesOf(a); } catch { bytes = null; }
    if (!bytes) { toast(t('editor.photo_offline'), 'warn'); return; }
    const blob = new Blob([bytes], { type: a.mime });
    if (!a.mime?.startsWith('image/')) { saveFile(blob, a.name); return; }
    const url = URL.createObjectURL(blob);
    urls.push(url);
    photoDlg.innerHTML = `<div class="dialog-head"><strong class="ellipsis">${esc(a.name)}</strong>
      <span><button class="ghost small-btn" id="ph-save">${esc(t('common.save_file'))}</button><button class="ghost icon-btn" id="ph-x">✕</button></span></div>
      <img src="${url}" alt="${esc(a.name)}">`;
    $('#ph-x', photoDlg).addEventListener('click', () => photoDlg.close());
    $('#ph-save', photoDlg).addEventListener('click', () => saveFile(blob, a.name));
    photoDlg.showModal();
  }

  async function submit(e) {
    e.preventDefault();
    const v = readForm();
    const errs = validateRecord(v, ctx.customFields(), { create: !rec });
    if (errs.length) {
      $('#ed-error', dlg).hidden = false;
      $('#ed-error', dlg).textContent = errs.map((x) => t(x.key, x.vars)).join('. ');
      return;
    }
    const saved = await saveRecord(store, { ...v, id: rec?.id || draftId }, ctx.user());
    for (const f of newPhotos) {
      try { await addAttachment(store, saved.id, f); } catch (err) { toast(err.message, 'error'); }
    }
    close();
    toast(api.online ? t('editor.saved_syncing') : t('editor.saved_offline'), 'ok', 2500);
    ctx.rerender();
    engine.soon();
  }

  // ---------- history and undo ----------
  async function openHistory(r) {
    hist.innerHTML = `<div class="dialog-head"><h2>${esc(t('history.title', { title: r.title }))}</h2><button class="ghost icon-btn" id="hi-x">✕</button></div>
      <div id="hi-body" class="muted">${esc(t('common.loading'))}</div>`;
    $('#hi-x', hist).addEventListener('click', () => hist.close());
    hist.showModal();
    if (!api.online) { $('#hi-body', hist).textContent = t('history.offline'); return; }
    try {
      const { versions } = await api.get(`/api/records/${r.id}/history`);
      const field = (k) => t(`field.${k}`);
      $('#hi-body', hist).innerHTML = `<p class="small">${esc(t('history.help'))}</p>` + versions.map((v, i) => {
        const s = v.snapshot;
        const changed = v.kind === 'create' ? t('history.created') : v.kind === 'delete' ? t('history.deleted')
          : (v.changed_fields || []).map((k) => (k.startsWith('custom.') ? (ctx.customFields().find((d) => `custom.${d.key}` === k)?.label || k) : field(k))).join(', ') || t(`history.kind_${v.kind}`);
        return `<div class="version">
          <div><strong>v${v.version}</strong> · ${esc(changed)} <span class="muted small">· ${esc(v.user_name || '')} · ${esc(when(v.created_at))}</span></div>
          <div class="small muted">${esc(s.title)} · ${esc(statusLabel(s.status))} · ${esc(priorityLabel(s.priority))}${s.due_date ? ` · 📅 ${esc(day(s.due_date))}` : ''}${s.notes ? ` · “${esc(s.notes.slice(0, 80))}${s.notes.length > 80 ? '…' : ''}”` : ''}</div>
          ${i > 0 && ctx.canEdit() ? `<button class="secondary small-btn" data-restore="${i}">${esc(t('history.restore'))}</button>` : ''}
        </div>`;
      }).join('');
      $$('[data-restore]', hist).forEach((b) => b.addEventListener('click', async () => {
        const v = versions[b.dataset.restore];
        if (!window.confirm(t('history.restore_confirm', { v: v.version }))) return;
        await restoreVersion(store, store.records.get(r.id), v.snapshot, ctx.user());
        hist.close();
        close();
        toast(t('history.restored', { v: v.version }), 'ok');
        ctx.rerender();
        engine.soon();
      }));
    } catch (err) {
      $('#hi-body', hist).textContent = err.message;
    }
  }

  return { open };
}
