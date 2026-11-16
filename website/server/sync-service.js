// Sync service: applies pushed operations and serves pulls.
// Each batch is one database transaction; each operation inside it is its own SAVEPOINT,
// so one bad operation never undoes the others. Every operation is remembered by its
// op_id, so a retried request returns the first result instead of applying twice.
import {
  planOperation, validateFields, flattenFields, getField, sameValue, CORE_FIELDS, ruleFor,
} from './conflict.js';
import { can } from './auth.js';
import { isUniqueViolation } from './db.js';
import { loadDoc, setText, mergeState, getText, encode, toB64, fromB64 } from '../public/js/textcrdt.js';

const toDate = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
const iso = (d) => (d instanceof Date ? d.toISOString() : d);

export function publicAttachment(a) {
  return { id: a.id, record_id: a.record_id, name: a.name, mime: a.mime, size: a.size, uploaded: !!a.uploaded, is_deleted: !!a.is_deleted };
}

export function publicRecord(row, attachments = []) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    location: row.location,
    status: row.status,
    priority: row.priority,
    notes: row.notes,
    notes_state: row.notes_state ? toB64(row.notes_state) : null,
    geo: row.lat == null ? null : { lat: row.lat, lng: row.lng, accuracy: row.accuracy ?? null },
    assigned_to: row.assigned_to ?? null,
    due_date: toDate(row.due_date),
    custom: row.custom || {},
    version: row.version,
    is_deleted: !!row.is_deleted,
    flagged: !!row.flagged,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by_name,
    updated_at: iso(row.updated_at),
    created_at: iso(row.created_at),
    attachments: attachments.filter((a) => !a.is_deleted).map(publicAttachment),
  };
}

export async function loadRecord(t, id, { lock = false } = {}) {
  return t.one(`SELECT * FROM records WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
}

export async function attachmentsFor(t, ids) {
  if (!ids.length) return new Map();
  const rows = await t.query(
    'SELECT id, record_id, name, mime, size, uploaded, is_deleted FROM attachments WHERE record_id = ANY($1) ORDER BY created_at',
    [ids],
  );
  const map = new Map();
  for (const a of rows) {
    if (!map.has(a.record_id)) map.set(a.record_id, []);
    map.get(a.record_id).push(a);
  }
  return map;
}

/** Bump the change sequence so devices pull this record again (no new version). */
export async function touchRecord(t, record, kind, deviceId, opId = null) {
  const { last_seq: seq } = await t.one(
    `WITH c AS (INSERT INTO change_log (record_id, workspace_id, version, op_id, kind, device_id) VALUES ($1, $2, $3, $5, $4, $6) RETURNING seq)
     UPDATE records SET last_seq = (SELECT seq FROM c) WHERE id = $1 RETURNING last_seq`,
    [record.id, record.workspace_id, record.version, kind, opId, deviceId ?? null],
  );
  return seq;
}

/** Notes text + Yjs state to store, given what the device sent. */
function resolveNotes(current, flat, op, merge) {
  if (!('notes' in flat)) return null;
  const doc = loadDoc(current?.notes_state ?? null, current?.notes ?? '');
  const incoming = fromB64(op.notes_state);
  if (merge && incoming) {
    mergeState(doc, incoming);                  // CRDT merge: both edits survive
  } else {
    setText(doc, flat.notes ?? '');             // plain write: make the document hold this text
  }
  return { text: getText(doc), state: Buffer.from(encode(doc)) };
}

/** Write fields onto a record as one new version. */
export async function writeFields(t, current, flat, { opId, deviceId, user, kind = 'update', extra = {}, notes = null }) {
  const version = current.version + 1;
  const meta = { ...(current.field_meta || {}) };
  const next = { ...current, custom: { ...(current.custom || {}) } };
  const changed = [];
  for (const [f, v] of Object.entries(flat)) {
    if (f === 'geo') {
      next.lat = v?.lat ?? null; next.lng = v?.lng ?? null; next.accuracy = v?.accuracy ?? null;
    } else if (f.startsWith('custom.')) {
      if (v === null) delete next.custom[f.slice(7)]; else next.custom[f.slice(7)] = v;
    } else if (f === 'notes') {
      next.notes = notes ? notes.text : v;
      if (notes) next.notes_state = notes.state;
    } else {
      next[f] = typeof v === 'string' && f === 'title' ? v.trim() : v;
    }
    meta[f] = { v: version, d: deviceId };
    changed.push(f);
  }
  Object.assign(next, extra);
  const saved = await t.one(
    `WITH c AS (INSERT INTO change_log (record_id, workspace_id, version, op_id, kind, device_id)
                VALUES ($21, $22, $13, $23, $24, $18) RETURNING seq)
     UPDATE records SET title=$1, location=$2, status=$3, priority=$4, notes=$5, notes_state=$6, lat=$7, lng=$8, accuracy=$9,
       assigned_to=$10, due_date=$11, custom=$12, version=$13, field_meta=$14, is_deleted=$15, deleted_at=$16, flagged=$17,
       updated_by_device=$18, updated_by_user=$19, updated_by_name=$20, updated_at=now(), last_seq=(SELECT seq FROM c)
     WHERE id=$21 RETURNING *`,
    [next.title, next.location, next.status, next.priority, next.notes, next.notes_state ?? null, next.lat ?? null, next.lng ?? null,
      next.accuracy ?? null, next.assigned_to ?? null, toDate(next.due_date), next.custom, version, meta, !!next.is_deleted,
      next.is_deleted ? (current.deleted_at || new Date()) : null, !!next.flagged, deviceId ?? null, user.id, user.name, current.id,
      current.workspace_id, opId ?? null, kind],
  );
  await saveVersion(t, saved, changed, kind, user, deviceId);
  return saved;
}

async function saveVersion(t, row, changed, kind, user, deviceId) {
  const snap = publicRecord(row);
  delete snap.notes_state;
  delete snap.attachments;
  await t.query(
    `INSERT INTO record_versions (record_id, version, snapshot, changed_fields, kind, user_name, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (record_id, version) DO NOTHING`,
    [row.id, row.version, snap, JSON.stringify(changed), kind, user?.name ?? null, deviceId ?? null],
  );
}

// A device that sends a newer value for a field it was in conflict over has moved on:
// its older conflicting value is out of date, so that conflict closes by itself.
async function closeSupersededConflicts(t, recordId, deviceId, fieldNames) {
  if (!deviceId || !fieldNames.length) return [];
  const open = await t.query(`SELECT id, fields FROM conflicts WHERE record_id = $1 AND device_id = $2 AND status = 'open'`, [recordId, deviceId]);
  const closed = [];
  for (const c of open) {
    if (c.fields.every((f) => fieldNames.includes(f))) {
      await t.query(`UPDATE conflicts SET status = 'resolved', resolution = 'superseded', resolved_at = now() WHERE id = $1`, [c.id]);
      closed.push(c.id);
    }
  }
  return closed;
}

function checkShape(op) {
  if (!op || typeof op !== 'object') return 'operation must be an object';
  if (typeof op.op_id !== 'string' || op.op_id.length < 8 || op.op_id.length > 64) return 'op_id is required';
  if (typeof op.record_id !== 'string' || op.record_id.length < 8 || op.record_id.length > 64) return 'record_id is required';
  if (!['create', 'update', 'delete'].includes(op.type)) return 'type must be create, update or delete';
  if (op.notes_state != null && (typeof op.notes_state !== 'string' || op.notes_state.length > 400_000)) return 'notes_state is too large';
  return null;
}

/** Team context shared by every operation in a batch. */
export async function teamContext(t, user) {
  const ws = await t.one('SELECT id, name, settings FROM workspaces WHERE id = $1', [user.workspace_id]);
  const members = await t.query('SELECT id, name, role FROM users WHERE workspace_id = $1', [user.workspace_id]);
  const settings = ws?.settings || {};
  return {
    workspace: ws,
    rules: settings.rules || {},
    customFields: settings.customFields || [],
    memberIds: new Set(members.map((m) => m.id)),
    members,
  };
}

async function applyOne(t, ctx, op) {
  const { user, deviceId, team, notify } = ctx;
  const shapeError = checkShape(op);
  if (shapeError) return { op_id: op?.op_id ?? null, status: 'rejected', reason: shapeError };

  const seen = ctx.applied ? ctx.applied.get(op.op_id) : await t.one('SELECT result FROM applied_ops WHERE op_id = $1', [op.op_id]);
  if (seen) {
    const latest = await loadRecord(t, op.record_id);
    const att = latest ? (await attachmentsFor(t, [latest.id])).get(latest.id) : [];
    return { ...seen.result, duplicate: true, record: latest ? publicRecord(latest, att) : seen.result.record };
  }

  if (ctx.fast) {
    // Fast path: no savepoint per operation. Any error aborts the batch and pushBatch
    // retries it in safe mode (one savepoint per operation), so results are identical.
    const res = await applyFresh(t, ctx, op);
    await t.query('INSERT INTO applied_ops (op_id, result) VALUES ($1, $2)', [op.op_id, { ...res, record: res.record ? { id: res.record.id, version: res.record.version } : null }]);
    if (res.status !== 'rejected') ctx.touched = true;
    return res;
  }
  await t.query('SAVEPOINT op');
  try {
    const res = await applyFresh(t, ctx, op);
    await t.query('INSERT INTO applied_ops (op_id, result) VALUES ($1, $2)', [op.op_id, { ...res, record: res.record ? { id: res.record.id, version: res.record.version } : null }]);
    await t.query('RELEASE SAVEPOINT op');
    if (res.status !== 'rejected') ctx.touched = true;
    return res;
  } catch (err) {
    await t.query('ROLLBACK TO SAVEPOINT op');
    await t.query('RELEASE SAVEPOINT op');
    if (isUniqueViolation(err)) {
      // Another server or request applied the same op_id at the same moment.
      const again = await t.one('SELECT result FROM applied_ops WHERE op_id = $1', [op.op_id]);
      if (again) return { ...again.result, duplicate: true };
    }
    throw err;
  }

  async function applyFresh(tt, c, o) {
    const current = await loadRecord(tt, o.record_id, { lock: true });
    const base = { op_id: o.op_id, record_id: o.record_id };
    const reject = (reason, code) => ({ ...base, status: 'rejected', reason, code, record: current ? publicRecord(current) : null });

    if (current && current.workspace_id !== user.workspace_id) return reject('Not allowed', 'forbidden');
    if (!can.editRecords(user)) return reject(`Your role (${user.role}) can only view records`, 'forbidden');
    const flat = flattenFields(o.fields);
    if (o.type === 'delete' && current && !can.deleteRecord(user, current)) {
      return reject('Only supervisors, admins or the person who created a record can delete it', 'forbidden');
    }
    if (o.type !== 'delete') {
      if ('assigned_to' in flat && !can.assign(user) && !sameValue(flat.assigned_to, current ? current.assigned_to : null)) {
        return reject('Only supervisors and admins can assign records', 'forbidden');
      }
      const errors = validateFields(flat, { create: o.type === 'create', customFields: team.customFields, memberIds: team.memberIds });
      if (errors.length) return reject(errors.join('; '), 'invalid');
    }

    const plan = planOperation(current, { ...o, fields: flat, device_id: deviceId }, team.rules);

    switch (plan.action) {
      case 'create': {
        const d = { title: '', location: '', status: 'Pending', priority: 'Medium', notes: '', ...plan.fields };
        const notes = resolveNotes(null, { notes: d.notes }, o, true);
        const meta = {};
        for (const f of [...CORE_FIELDS, ...Object.keys(flat).filter((k) => k.startsWith('custom.'))]) meta[f] = { v: 1, d: deviceId };
        const custom = {};
        for (const [k, v] of Object.entries(flat)) if (k.startsWith('custom.') && v !== null) custom[k.slice(7)] = v;
        const created = await tt.one(
          `WITH c AS (INSERT INTO change_log (record_id, workspace_id, version, op_id, kind, device_id) VALUES ($1, $2, 1, $19, 'create', $17) RETURNING seq)
           INSERT INTO records (id, workspace_id, title, location, status, priority, notes, notes_state, lat, lng, accuracy,
             assigned_to, due_date, custom, version, field_meta, created_by, updated_by_device, updated_by_user, updated_by_name, last_seq)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$17,$16,$18,(SELECT seq FROM c)) RETURNING *`,
          [o.record_id, user.workspace_id, d.title.trim(), d.location, d.status, d.priority, notes.text, notes.state,
            d.geo?.lat ?? null, d.geo?.lng ?? null, d.geo?.accuracy ?? null, d.assigned_to ?? null, d.due_date ?? null,
            custom, meta, user.id, deviceId, user.name, o.op_id],
        );
        await saveVersion(tt, created, Object.keys(flat), 'create', user, deviceId);
        if (created.assigned_to && created.assigned_to !== user.id) notify(created.assigned_to, 'assigned', created.id, `${user.name} assigned you "${created.title}"`);
        return { ...base, status: 'applied', record: publicRecord(created) };
      }
      case 'apply':
      case 'merge':
      case 'restore': {
        const notes = resolveNotes(current, plan.fields, o, plan.mergedNotes);
        const extra = plan.action === 'restore' ? { is_deleted: false, flagged: true, deleted_at: null } : {};
        const saved = await writeFields(tt, current, plan.fields, {
          opId: o.op_id, deviceId, user, notes, extra, kind: plan.action === 'restore' ? 'restore' : 'update',
        });
        const resolved = await closeSupersededConflicts(tt, o.record_id, deviceId, Object.keys(plan.fields));
        if ('assigned_to' in plan.fields && saved.assigned_to && saved.assigned_to !== user.id && saved.assigned_to !== current.assigned_to) {
          notify(saved.assigned_to, 'assigned', saved.id, `${user.name} assigned you "${saved.title}"`);
        }
        const att = (await attachmentsFor(tt, [saved.id])).get(saved.id) || [];
        const status = plan.action === 'restore' ? 'restored' : plan.action === 'apply' ? 'applied' : 'merged';
        return {
          ...base, status, strategy: plan.action, merged_notes: !!plan.mergedNotes, overwritten: plan.overwritten,
          resolved_conflicts: resolved, record: publicRecord(saved, att),
          ...(plan.action === 'restore' ? { reason: 'Record had been deleted elsewhere; your edit restored it' } : {}),
        };
      }
      case 'conflict': {
        let saved = current;
        if (Object.keys(plan.fields).length) {
          const notes = resolveNotes(current, plan.fields, o, plan.mergedNotes);
          saved = await writeFields(tt, current, plan.fields, { opId: o.op_id, deviceId, user, notes });
        }
        const resolved = await closeSupersededConflicts(tt, o.record_id, deviceId, Object.keys(flat));
        const local = Object.fromEntries(plan.conflictFields.map((f) => [f, flat[f]]));
        const server = Object.fromEntries(plan.conflictFields.map((f) => [f, getField(current, f)]));
        const { id: conflictId } = await tt.one(
          `INSERT INTO conflicts (record_id, workspace_id, op_id, device_id, user_id, fields, local_value, server_value)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [o.record_id, user.workspace_id, o.op_id, deviceId, user.id, JSON.stringify(plan.conflictFields), local, server],
        );
        await touchRecord(tt, saved, 'conflict', deviceId);
        for (const m of team.members) {
          if (m.id !== user.id && (m.role === 'admin' || m.role === 'supervisor')) {
            notify(m.id, 'conflict', saved.id, `Conflict on "${saved.title}" (${plan.conflictFields.join(', ')}) needs a decision`);
          }
        }
        const att = (await attachmentsFor(tt, [saved.id])).get(saved.id) || [];
        return { ...base, status: 'conflict', conflict_id: conflictId, fields: plan.conflictFields, resolved_conflicts: resolved, record: publicRecord(saved, att) };
      }
      case 'delete': {
        const saved = await writeFields(tt, current, {}, { opId: o.op_id, deviceId, user, kind: 'delete', extra: { is_deleted: true } });
        return { ...base, status: 'applied', record: publicRecord(saved) };
      }
      case 'noop':
        return { ...base, status: 'applied', record: publicRecord(current) };
      case 'superseded': {
        const att = (await attachmentsFor(tt, [current.id])).get(current.id) || [];
        return { ...base, status: 'superseded', reason: plan.reason, record: publicRecord(current, att) };
      }
      default:
        return reject(plan.reason, 'invalid');
    }
  }
}

/** Apply a batch. Returns { results, notifications } (notifications are sent after commit). */
export async function pushBatch(db, user, deviceId, ops) {
  const started = Date.now();
  const pending = [];
  const ctx = { user, deviceId, touched: false, notify: (userId, kind, recordId, message) => pending.push({ userId, kind, recordId, message }) };
  const run = (fast) => db.tx(async (t) => {
    pending.length = 0;
    ctx.touched = false;
    ctx.fast = fast;
    ctx.team = await teamContext(t, user);
    const ids = ops.map((o) => o?.op_id).filter((x) => typeof x === 'string');
    ctx.applied = new Map((await t.query('SELECT op_id, result FROM applied_ops WHERE op_id = ANY($1)', [ids])).map((r) => [r.op_id, { result: r.result }]));
    const out = [];
    for (const op of ops) {
      const r = await applyOne(t, ctx, op);
      out.push(r);
      if (op?.op_id && !r.duplicate) ctx.applied.set(op.op_id, { result: { ...r, record: r.record ? { id: r.record.id, version: r.record.version } : null } });   // same op twice in one batch
    }
    for (const n of pending) {
      await t.query('INSERT INTO notifications (user_id, workspace_id, kind, record_id, message) VALUES ($1,$2,$3,$4,$5)',
        [n.userId, user.workspace_id, n.kind, n.recordId, n.message]);
    }
    return out;
  });
  let results;
  try { results = await run(true); } catch (e) { if (process.env.DEBUG_SYNC) console.error("fast path failed:", e.message); results = await run(false); }
  const fresh = results.filter((r) => !r.duplicate);
  await db.query(
    `INSERT INTO sync_events (workspace_id, user_id, device_id, direction, applied, conflicts, rejected, duplicates, latency_ms)
     VALUES ($1, $2, $3, 'push', $4, $5, $6, $7, $8)`,
    [user.workspace_id, user.id, deviceId,
      fresh.filter((r) => ['applied', 'merged', 'restored', 'superseded'].includes(r.status)).length,
      fresh.filter((r) => r.status === 'conflict').length, fresh.filter((r) => r.status === 'rejected').length,
      results.length - fresh.length, Date.now() - started],
  );
  return { results, notifications: pending, changed: ctx.touched };
}

/** Does this record belong in the device's partial-sync scope? */
export function inScope(row, scope, user) {
  const mode = scope?.mode || 'all';
  if (mode === 'mine') return row.assigned_to === user.id || row.created_by === user.id;
  if (mode === 'area') return String(row.location || '').toLowerCase().includes(String(scope.area || '').toLowerCase());
  return true;
}

export async function pullChanges(db, user, deviceId, cursor, limit) {
  const started = Date.now();
  const ws = await db.one('SELECT settings FROM workspaces WHERE id = $1', [user.workspace_id]);
  const compactedThrough = Number(ws?.settings?.compactedThrough || 0);
  if (cursor > 0 && cursor < compactedThrough) {
    // Old tombstones were cleaned up after this device last synced: it must start over.
    return { changes: [], cursor: 0, hasMore: false, resync: true };
  }
  const device = await db.one('SELECT scope FROM devices WHERE id = $1', [deviceId]);
  const scope = device?.scope || { mode: 'all' };
  const rows = await db.query(
    'SELECT * FROM records WHERE workspace_id = $1 AND last_seq > $2 ORDER BY last_seq LIMIT $3',
    [user.workspace_id, cursor, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const next = page.length ? Number(page[page.length - 1].last_seq) : cursor;
  const att = await attachmentsFor(db, page.map((r) => r.id));
  const changes = page.map((r) => (r.is_deleted || inScope(r, scope, user)
    ? publicRecord(r, att.get(r.id) || [])
    : { id: r.id, evicted: true }));
  await db.query('UPDATE devices SET last_cursor = $1 WHERE id = $2', [next, deviceId]);
  if (page.length) {
    await db.query(
      `INSERT INTO sync_events (workspace_id, user_id, device_id, direction, received, latency_ms) VALUES ($1,$2,$3,'pull',$4,$5)`,
      [user.workspace_id, user.id, deviceId, page.length, Date.now() - started],
    );
  }
  return { changes, cursor: next, hasMore, scope };
}
