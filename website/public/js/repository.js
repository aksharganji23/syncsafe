// Repository: the screens save and delete records here and never touch the network.
// Every write updates the local record AND adds an outbox operation in the same
// store transaction, so a crash can never keep one without the other.
import { coalesce, uuid, diffRecord } from './core.js';
import { loadDoc, setText, encode, toB64, fromB64 } from './textcrdt.js';
import { sha256Hex } from './secure.js';

function enqueue(tx, op) {
  const plan = coalesce(tx.opsFor(op.record_id), op);
  for (const seq of plan.remove) tx.deleteOp(seq);
  for (const item of plan.put) tx.putOp(item);
  return plan;
}

/** New Yjs state for notes, starting from the record's last known state. */
function notesState(existing, newText) {
  const doc = existing?.notes_state ? loadDoc(fromB64(existing.notes_state)) : loadDoc(null, existing ? existing.notes || '' : '');
  setText(doc, newText || '');
  return toB64(encode(doc));
}

export function saveRecord(store, input, user) {
  return store.mutate((tx) => {
    const existing = input.id ? tx.record(input.id) : null;
    const id = existing?.id || input.id || uuid();
    const pendingCreate = tx.opsFor(id).some((o) => o.type === 'create');
    const isNew = !existing || (existing.version === 0 && !pendingCreate);
    const next = {
      title: '', location: '', status: 'Pending', priority: 'Medium', notes: '', geo: null, assigned_to: null, due_date: null, custom: {},
      version: 0, is_deleted: false, flagged: false, attachments: [],
      ...existing, ...input, id,
      custom: { ...(existing?.custom || {}), ...(input.custom || {}) },
      updated_by: user?.name || 'Me',
      updated_at: new Date().toISOString(),
      error: null,
    };
    for (const [k, v] of Object.entries(next.custom)) if (v === null || v === '' || v === undefined) delete next.custom[k];
    const fields = isNew ? diffRecord({}, next) : diffRecord(existing, next);
    if (isNew) {
      for (const f of ['title', 'location', 'status', 'priority', 'notes']) fields[f] = next[f];
    }
    if (!isNew && Object.keys(fields).length === 0) return existing;

    let state;
    if ('notes' in fields) {
      state = notesState(isNew ? null : existing, next.notes);
      next.notes_state = state;
    }
    next.sync_state = existing?.sync_state === 'conflict' ? 'conflict' : 'pending';
    if (!next.created_by && isNew) next.created_by = user?.id ?? null;
    tx.putRecord(next);
    enqueue(tx, {
      op_id: uuid(), record_id: id, type: isNew ? 'create' : 'update',
      fields, base_version: existing?.version || 0, notes_state: state,
      created_at: new Date().toISOString(), attempts: 0, inflight: false,
    });
    return next;
  });
}

export function deleteRecord(store, id) {
  return store.mutate((tx) => {
    const existing = tx.record(id);
    if (!existing) return;
    const plan = enqueue(tx, {
      op_id: uuid(), record_id: id, type: 'delete', fields: {}, base_version: existing.version || 0,
      created_at: new Date().toISOString(), attempts: 0, inflight: false,
    });
    if (plan.dropRecord) {
      tx.deleteRecord(id);
      for (const f of [...store.files.values()]) if (f.record_id === id) tx.deleteFile(f.id);
    } else {
      tx.putRecord({ ...existing, is_deleted: true, sync_state: 'pending' });
    }
  });
}

/** Undo: an ordinary edit back to the values of an older version. */
export function restoreVersion(store, record, snapshot, user) {
  const back = {
    id: record.id, title: snapshot.title, location: snapshot.location, status: snapshot.status, priority: snapshot.priority,
    notes: snapshot.notes, geo: snapshot.geo ?? null, assigned_to: snapshot.assigned_to ?? null, due_date: snapshot.due_date ?? null,
    custom: { ...Object.fromEntries(Object.keys(record.custom || {}).map((k) => [k, null])), ...(snapshot.custom || {}) },
  };
  return saveRecord(store, back, user);
}

export async function importRecords(store, rows, user) {
  let n = 0;
  for (const r of rows) {
    await saveRecord(store, r, user);
    n++;
  }
  return n;
}

// ---------- photos and files ----------

/** Shrink a photo to at most `max` px on its longest side, as JPEG. */
export async function compressImage(blob, max = 1600, quality = 0.82) {
  if (!/^image\/(jpeg|png|webp)$/.test(blob.type) || typeof createImageBitmap !== 'function') return blob;
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (scale === 1 && blob.type === 'image/jpeg' && blob.size < 600 * 1024) return blob;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res) => canvas.toBlob((b) => res(b || blob), 'image/jpeg', quality));
}

/** Add a photo/file to a record: saved encrypted on the device, uploaded later by the sync engine. */
export async function addAttachment(store, recordId, file) {
  const blob = file.type.startsWith('image/') ? await compressImage(file) : file;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > 10 * 1024 * 1024) throw new Error('too_large');
  const id = uuid();
  const meta = {
    id, record_id: recordId, name: (file.name || 'photo.jpg').replace(/\.(png|webp|heic)$/i, '.jpg').slice(0, 120),
    mime: blob.type || file.type || 'application/octet-stream', size: bytes.length, sha256: await sha256Hex(bytes),
    status: 'pending', offset: 0, local: true, created_at: new Date().toISOString(),
  };
  await store.putBlob(id, bytes);
  await store.mutate((tx) => tx.putFile(meta));
  return meta;
}

export async function removeAttachment(store, id) {
  await store.mutate((tx) => {
    const m = tx.file(id);
    if (m && m.status !== 'uploaded' && m.local) tx.deleteFile(id);          // never left the device
    else tx.putFile({ ...(m || { id }), status: 'delete' });                  // ask the server when online
  });
  await store.deleteBlob(id);
}
