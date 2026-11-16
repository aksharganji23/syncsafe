// Photos and files, uploaded in chunks. If the connection drops, the device asks how
// much arrived (`received`) and continues from there instead of starting over.
import crypto from 'node:crypto';
import { can } from './auth.js';
import { touchRecord, loadRecord } from './sync-service.js';

export const MAX_SIZE = 10 * 1024 * 1024;
export const MAX_CHUNK = 512 * 1024;
const ALLOWED = /^(image\/(jpeg|png|webp|gif)|application\/pdf|text\/plain|audio\/(mpeg|mp4|webm|ogg|wav))$/;

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

async function ownAttachment(t, user, id) {
  const a = await t.one('SELECT id, record_id, workspace_id, name, mime, size, received, sha256, uploaded, is_deleted, created_by FROM attachments WHERE id = $1', [id]);
  if (!a || a.workspace_id !== user.workspace_id) throw new HttpError(404, 'Attachment not found');
  return a;
}

export async function initUpload(db, user, body) {
  const { id, record_id: recordId, name, mime, size, sha256 } = body || {};
  if (!can.editRecords(user)) throw new HttpError(403, 'Viewers cannot add photos');
  if (typeof id !== 'string' || id.length < 8 || id.length > 64) throw new HttpError(400, 'id is required');
  if (!Number.isInteger(size) || size <= 0 || size > MAX_SIZE) throw new HttpError(400, `Files must be 1 byte to ${MAX_SIZE / 1024 / 1024} MB`);
  if (!ALLOWED.test(String(mime))) throw new HttpError(400, 'Only photos (JPEG, PNG, WebP, GIF), PDF, text and audio files are allowed');
  if (!/^[a-f0-9]{64}$/.test(String(sha256))) throw new HttpError(400, 'sha256 is required');
  return db.tx(async (t) => {
    const existing = await t.one('SELECT * FROM attachments WHERE id = $1', [id]);
    if (existing) {
      if (existing.workspace_id !== user.workspace_id) throw new HttpError(404, 'Attachment not found');
      return { received: existing.received, uploaded: existing.uploaded };
    }
    const record = await loadRecord(t, recordId);
    if (!record || record.workspace_id !== user.workspace_id || record.is_deleted) {
      throw new HttpError(409, 'The record is not on the server yet', { retry: true });
    }
    await t.query(
      `INSERT INTO attachments (id, record_id, workspace_id, name, mime, size, sha256, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, recordId, user.workspace_id, String(name || 'photo').slice(0, 120), mime, size, sha256, user.id],
    );
    return { received: 0, uploaded: false };
  });
}

/** Append one chunk at `offset`. Returns { received, uploaded, record_id }. */
export async function appendChunk(db, user, id, offset, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'Empty chunk');
  if (buf.length > MAX_CHUNK) throw new HttpError(413, 'Chunk too large');
  return db.tx(async (t) => {
    const a = await ownAttachment(t, user, id);
    if (a.uploaded) return { received: a.size, uploaded: true, record_id: a.record_id, done: false };
    if (offset !== a.received) throw new HttpError(409, 'Wrong offset', { received: a.received });
    if (a.received + buf.length > a.size) throw new HttpError(400, 'Chunk goes past the declared size');
    await t.query('UPDATE attachments SET data = data || $1, received = received + $2 WHERE id = $3', [buf, buf.length, id]);
    const received = a.received + buf.length;
    if (received < a.size) return { received, uploaded: false, record_id: a.record_id, done: false };
    const { data } = await t.one('SELECT data FROM attachments WHERE id = $1', [id]);
    const hash = crypto.createHash('sha256').update(Buffer.from(data)).digest('hex');
    if (hash !== a.sha256) {
      await t.query(`UPDATE attachments SET data = ''::bytea, received = 0 WHERE id = $1`, [id]);
      throw new HttpError(422, 'File arrived damaged; it will be sent again', { received: 0 });
    }
    await t.query('UPDATE attachments SET uploaded = true WHERE id = $1', [id]);
    const record = await loadRecord(t, a.record_id);
    if (record) await touchRecord(t, record, 'attachment', null);
    return { received, uploaded: true, record_id: a.record_id, done: true };
  });
}

export async function readAttachment(db, user, id) {
  const a = await db.one('SELECT workspace_id, name, mime, size, uploaded, is_deleted, data FROM attachments WHERE id = $1', [id]);
  if (!a || a.workspace_id !== user.workspace_id || a.is_deleted) throw new HttpError(404, 'Attachment not found');
  if (!a.uploaded) throw new HttpError(409, 'Still uploading');
  return { name: a.name, mime: a.mime, data: Buffer.from(a.data) };
}

export async function deleteAttachment(db, user, id) {
  return db.tx(async (t) => {
    const a = await ownAttachment(t, user, id);
    if (!(can.editRecords(user) && (a.created_by === user.id || ['admin', 'supervisor'].includes(user.role)))) {
      throw new HttpError(403, 'Only the person who added it, a supervisor or an admin can remove this file');
    }
    if (a.is_deleted) return { record_id: a.record_id };
    await t.query(`UPDATE attachments SET is_deleted = true, data = ''::bytea WHERE id = $1`, [id]);
    const record = await loadRecord(t, a.record_id);
    if (record) await touchRecord(t, record, 'attachment', null);
    return { record_id: a.record_id };
  });
}

export { HttpError };
