// Pure helpers shared by the browser, the Android app and the Node tests.
// No DOM, no IndexedDB, no network.

export const STATUSES = ['Pending', 'Visited', 'Follow-up', 'Closed'];
export const PRIORITIES = ['Low', 'Medium', 'High'];
export const BASIC_FIELDS = ['title', 'location', 'status', 'priority', 'notes', 'geo', 'assigned_to', 'due_date'];

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** Client-side validation mirrors the server rules (the server re-checks everything). */
export function validateRecord(r, customFields = [], { create = false } = {}) {
  const errors = [];
  if (!r.title || !String(r.title).trim()) errors.push({ key: 'err.title_required' });
  if (String(r.title || '').length > 120) errors.push({ key: 'err.title_long' });
  if (String(r.location || '').length > 120) errors.push({ key: 'err.location_long' });
  if (String(r.notes || '').length > 5000) errors.push({ key: 'err.notes_long' });
  if (r.status && !STATUSES.includes(r.status)) errors.push({ key: 'err.status', vars: { list: STATUSES.join(', ') } });
  if (r.priority && !PRIORITIES.includes(r.priority)) errors.push({ key: 'err.priority', vars: { list: PRIORITIES.join(', ') } });
  if (r.due_date && !isDate(r.due_date)) errors.push({ key: 'err.due_date' });
  for (const d of customFields) {
    const v = r.custom?.[d.key];
    if (create && d.required && (v === undefined || v === null || v === '')) errors.push({ key: 'err.custom_required', vars: { label: d.label } });
    if (v === undefined || v === null || v === '') continue;
    if (d.type === 'number' && !Number.isFinite(v)) errors.push({ key: 'err.custom_invalid', vars: { label: d.label } });
    if (d.type === 'select' && !d.options.includes(v)) errors.push({ key: 'err.custom_invalid', vars: { label: d.label } });
    if (d.type === 'date' && !isDate(v)) errors.push({ key: 'err.custom_invalid', vars: { label: d.label } });
  }
  return errors;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Which fields changed between a stored record and an edited copy (custom is per key). */
export function diffRecord(before, after) {
  const fields = {};
  for (const f of BASIC_FIELDS) {
    if (f in after && !same(before?.[f], after[f])) fields[f] = after[f];
  }
  const custom = {};
  for (const [k, v] of Object.entries(after.custom || {})) {
    if (!same(before?.custom?.[k], v)) custom[k] = v;
  }
  for (const k of Object.keys(before?.custom || {})) {
    if (!(k in (after.custom || {}))) custom[k] = null;
  }
  if (Object.keys(custom).length) fields.custom = custom;
  return fields;
}

const mergeFields = (a, b) => {
  const out = { ...a, ...b };
  if (a.custom || b.custom) out.custom = { ...(a.custom || {}), ...(b.custom || {}) };
  return out;
};

/**
 * Add a new operation to the outbox, merging it into an unsent operation for the
 * same record when possible. Operations already attempted are never modified:
 * the server may have applied them, and changing them would break idempotency.
 * @returns { put: [ops to write], remove: [seqs to delete], dropRecord: bool }
 */
export function coalesce(pending, op) {
  const last = pending[pending.length - 1];
  const mergeable = last && !last.attempts && !last.inflight;

  if (op.type === 'update' && mergeable && last.type !== 'delete') {
    return { put: [{ ...last, fields: mergeFields(last.fields, op.fields), notes_state: op.notes_state ?? last.notes_state }], remove: [], dropRecord: false };
  }
  if (op.type === 'delete' && mergeable) {
    const neverSent = pending.every((p) => !p.attempts && !p.inflight);
    if (neverSent && pending.some((p) => p.type === 'create')) {
      return { put: [], remove: pending.map((p) => p.seq), dropRecord: true };
    }
    if (last.type === 'update') {
      return { put: [{ ...last, type: 'delete', fields: {}, notes_state: undefined }], remove: [], dropRecord: false };
    }
  }
  return { put: [op], remove: [], dropRecord: false };
}

/** Exponential backoff with jitter: 1 s, 2 s, 4 s … capped at 60 s, plus up to 1 s random. */
export function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(60, 2 ** Math.max(0, attempt - 1));
  return Math.round((base + random()) * 1000);
}

/**
 * Small random wait before the first sync after reconnecting, so thousands of devices that
 * regain network at the same moment (e.g. a cell tower comes back) don't all hit the server at once.
 */
export function reconnectJitter(random = Math.random, maxMs = 3000) {
  return Math.round(random() * maxMs);
}

/** Minimal CSV parser (quoted fields, commas and newlines inside quotes). */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const isOverdue = (r) => !!r.due_date && r.status !== 'Closed' && r.due_date < todayISO();
