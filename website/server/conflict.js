// Field model, validation and conflict decisions (Strategy pattern).
// Pure functions: no database, no network, so they are easy to unit test.

export const STATUSES = ['Pending', 'Visited', 'Follow-up', 'Closed'];
export const PRIORITIES = ['Low', 'Medium', 'High'];
export const CORE_FIELDS = ['title', 'location', 'status', 'priority', 'notes', 'geo', 'assigned_to', 'due_date'];
export const CUSTOM_TYPES = ['text', 'number', 'date', 'select', 'checkbox'];

// How each field is handled when two devices change it before seeing each other's change.
//   lww    = last write wins (server arrival order)
//   manual = a person decides on the Conflicts screen
//   merge  = (notes only) both texts are merged automatically, character by character (CRDT)
export const DEFAULT_RULES = {
  title: 'lww', location: 'lww', status: 'manual', priority: 'lww', notes: 'manual',
  geo: 'lww', assigned_to: 'manual', due_date: 'lww', custom: 'lww',
};
export const RULE_CHOICES = {
  title: ['lww', 'manual'], location: ['lww', 'manual'], status: ['lww', 'manual'], priority: ['lww', 'manual'],
  notes: ['lww', 'manual', 'merge'], geo: ['lww', 'manual'], assigned_to: ['lww', 'manual'],
  due_date: ['lww', 'manual'], custom: ['lww', 'manual'],
};

export const ruleKey = (field) => (field.startsWith('custom.') ? 'custom' : field);
export const ruleFor = (rules, field) => ({ ...DEFAULT_RULES, ...(rules || {}) })[ruleKey(field)];

export function sanitizeRules(input) {
  const out = { ...DEFAULT_RULES };
  for (const [k, v] of Object.entries(input || {})) {
    if (RULE_CHOICES[k]?.includes(v)) out[k] = v;
  }
  return out;
}

/** Op fields as sent by a device -> flat map ({custom: {size: 3}} becomes {'custom.size': 3}). */
export function flattenFields(fields) {
  const flat = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (k === 'custom' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [ck, cv] of Object.entries(v)) flat[`custom.${ck}`] = cv;
    } else flat[k] = v;
  }
  return flat;
}

/** Current value of a (flat) field on a record row. */
export function getField(record, field) {
  if (field === 'geo') return record.lat == null ? null : { lat: record.lat, lng: record.lng, accuracy: record.accuracy ?? null };
  if (field.startsWith('custom.')) return (record.custom || {})[field.slice(7)] ?? null;
  if (field === 'due_date') return record.due_date ? String(record.due_date).slice(0, 10) : null;
  return record[field] ?? null;
}

export const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export function sanitizeCustomFields(list) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(list) ? list.slice(0, 20) : []) {
    let key = String(f?.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
    if (!/[a-z0-9]/.test(key)) key = `field_${out.length + 1}`;          // labels in Telugu/Hindi get a plain key
    while (seen.has(key)) key = `${key}_2`;
    if (!CUSTOM_TYPES.includes(f.type)) continue;
    seen.add(key);
    out.push({
      key,
      label: String(f.label || key).slice(0, 60),
      type: f.type,
      required: !!f.required,
      options: f.type === 'select' ? [...new Set((f.options || []).map((o) => String(o).trim()).filter(Boolean))].slice(0, 30) : [],
    });
  }
  return out;
}

/**
 * Validate flat fields. Returns a list of human-readable errors (empty = OK).
 * ctx: { create, customFields: [...], memberIds: Set<number> }
 */
export function validateFields(flat, ctx = {}) {
  const errors = [];
  if (!flat || typeof flat !== 'object' || Array.isArray(flat)) return ['fields must be an object'];
  const defs = new Map((ctx.customFields || []).map((d) => [d.key, d]));
  const text = (k, max) => {
    if (k in flat && (typeof flat[k] !== 'string' || flat[k].length > max)) errors.push(`${k} must be text of at most ${max} characters`);
  };
  for (const k of Object.keys(flat)) {
    if (!CORE_FIELDS.includes(k) && !(k.startsWith('custom.') && defs.has(k.slice(7)))) errors.push(`unknown field "${k}"`);
  }
  text('title', 120);
  text('location', 120);
  text('notes', 5000);
  if ('title' in flat && typeof flat.title === 'string' && !flat.title.trim()) errors.push('title cannot be empty');
  if (ctx.create && !(typeof flat.title === 'string' && flat.title.trim())) errors.push('title is required');
  if ('status' in flat && !STATUSES.includes(flat.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`);
  if ('priority' in flat && !PRIORITIES.includes(flat.priority)) errors.push(`priority must be one of ${PRIORITIES.join(', ')}`);
  if ('geo' in flat && flat.geo !== null) {
    const g = flat.geo;
    const ok = g && typeof g === 'object' && Number.isFinite(g.lat) && Number.isFinite(g.lng)
      && Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180 && (g.accuracy == null || (Number.isFinite(g.accuracy) && g.accuracy >= 0));
    if (!ok) errors.push('geo must be { lat, lng, accuracy } with valid numbers');
  }
  if ('assigned_to' in flat && flat.assigned_to !== null) {
    if (!Number.isInteger(flat.assigned_to) || (ctx.memberIds && !ctx.memberIds.has(flat.assigned_to))) errors.push('assigned_to must be a member of this team');
  }
  if ('due_date' in flat && flat.due_date !== null && !isDate(flat.due_date)) errors.push('due_date must be a date like 2026-12-31');
  for (const [k, v] of Object.entries(flat)) {
    if (!k.startsWith('custom.') || v === null) continue;
    const d = defs.get(k.slice(7));
    if (!d) continue;
    const bad = (d.type === 'text' && (typeof v !== 'string' || v.length > 500))
      || (d.type === 'number' && !Number.isFinite(v))
      || (d.type === 'date' && !isDate(v))
      || (d.type === 'select' && !d.options.includes(v))
      || (d.type === 'checkbox' && typeof v !== 'boolean');
    if (bad) errors.push(`${d.label} has an invalid value`);
  }
  if (ctx.create) {
    for (const d of defs.values()) {
      const v = flat[`custom.${d.key}`];
      if (d.required && (v === undefined || v === null || v === '')) errors.push(`${d.label} is required`);
    }
  }
  return errors;
}

/** Fields someone else changed after the version this device last saw. */
export function changedByOthersSince(current, baseVersion, deviceId) {
  const meta = current.field_meta || {};
  return Object.keys(meta).filter((f) => meta[f] && meta[f].v > baseVersion && meta[f].d !== deviceId);
}

/**
 * Decide what to do with one incoming operation.
 * @param current  record row (field_meta parsed) or null
 * @param op       { type, fields (flat), base_version, device_id }
 * @param rules    workspace conflict rules
 * @returns { action, fields, conflictFields, mergedNotes, overwritten, reason }
 *   action: create | apply | merge | conflict | restore | delete | superseded | noop | reject
 */
export function planOperation(current, op, rules = DEFAULT_RULES) {
  const fields = op.fields || {};
  const base = Number(op.base_version) || 0;

  if (op.type === 'create') {
    if (current) return { action: 'reject', reason: 'A record with this id already exists' };
    return { action: 'create', fields, conflictFields: [] };
  }

  if (op.type === 'update') {
    if (!current) return { action: 'reject', reason: 'Record not found' };
    if (current.is_deleted) return { action: 'restore', fields, conflictFields: [] };

    const touched = changedByOthersSince(current, base, op.device_id);
    const overlap = Object.keys(fields).filter((f) => touched.includes(f) && !sameValue(fields[f], getField(current, f)));
    if (overlap.length === 0) {
      return { action: current.version === base ? 'apply' : 'merge', fields, conflictFields: [] };
    }
    const manual = overlap.filter((f) => ruleFor(rules, f) === 'manual');
    const mergedNotes = overlap.includes('notes') && ruleFor(rules, 'notes') === 'merge';
    const overwritten = overlap.filter((f) => ruleFor(rules, f) === 'lww');
    const autoFields = Object.fromEntries(Object.entries(fields).filter(([f]) => !manual.includes(f)));
    if (manual.length > 0) {
      return { action: 'conflict', fields: autoFields, conflictFields: manual, mergedNotes, overwritten };
    }
    return { action: 'merge', fields, conflictFields: [], mergedNotes, overwritten };
  }

  if (op.type === 'delete') {
    if (!current || current.is_deleted) return { action: 'noop', fields: {}, conflictFields: [] };
    if (changedByOthersSince(current, base, op.device_id).length > 0) {
      return { action: 'superseded', reason: 'Edited on another device after you deleted it; the edit was kept' };
    }
    return { action: 'delete', fields: {}, conflictFields: [] };
  }

  return { action: 'reject', reason: `Unknown operation type "${op.type}"` };
}
