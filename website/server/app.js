// HTTP layer (Express 5). Business rules live in sync-service.js, conflict.js,
// attachments.js and reports.js; this file maps URLs to them and checks permissions.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import {
  hashPassword, checkPassword, signAccess, issueRefresh, requireAuth, requireRole, sha256, can, ROLES, ACCESS_TTL_SECONDS,
} from './auth.js';
import { pushBatch, pullChanges, writeFields, loadRecord, publicRecord, attachmentsFor } from './sync-service.js';
import { validateFields, sanitizeRules, sanitizeCustomFields, getField, RULE_CHOICES } from './conflict.js';
import { initUpload, appendChunk, readAttachment, deleteAttachment, HttpError, MAX_CHUNK } from './attachments.js';
import { summary, exportRows, toCSV, toXLSX, toPDF } from './reports.js';
import { createBus } from './bus.js';
import { createMetrics } from './metrics.js';
import { compact } from './jobs.js';
import { suggestMerge } from '../public/js/ai.js';
import { loadDoc, setText, encode } from '../public/js/textcrdt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const MAX_BATCH = 100;
const MAX_PULL = 500;
export const VERSION = '2.0.0';

function loadSecret(dataDir) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!dataDir) return crypto.randomBytes(32).toString('hex');
  const file = path.join(dataDir, '.jwt-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  fs.mkdirSync(dataDir, { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret);
  return secret;
}

const inviteCode = () => `${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

export async function createApp({ databaseUrl = process.env.DATABASE_URL || null, dbDir = null, dataDir = null } = {}) {
  const db = await openDatabase({ url: databaseUrl, dir: dbDir });
  const secret = loadSecret(dataDir);
  const bus = await createBus(db);
  const metrics = createMetrics();
  const fault = { rate: Number(process.env.FAULT_RATE || 0), mode: process.env.FAULT_MODE || 'before' };

  // A new id every time the database is created; devices notice a reset and reload.
  let instance = await db.one(`SELECT value FROM schema_meta WHERE key = 'instance_id'`);
  if (!instance) {
    await db.query(`INSERT INTO schema_meta (key, value) VALUES ('instance_id', $1) ON CONFLICT (key) DO NOTHING`, [crypto.randomUUID()]);
    instance = await db.one(`SELECT value FROM schema_meta WHERE key = 'instance_id'`);
  }
  const instanceId = instance.value;

  const app = express();
  app.disable('x-powered-by');
  app.use(metrics.middleware);

  // CORS: the Android app runs from its own origin. Identity travels in the Authorization
  // header, never in cookies, so allowing any origin does not expose sessions.
  app.use('/api', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Device-Name',
      'Access-Control-Expose-Headers': 'Content-Disposition',
      'Access-Control-Max-Age': '600',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api', express.json({ limit: '2mb' }));

  const auth = requireAuth(db, secret);
  const admin = requireRole('admin');
  const supervisor = requireRole('supervisor');

  const deviceNameOf = (req) => {
    const raw = req.get('x-device-name');
    if (!raw) return null;
    try { return decodeURIComponent(raw).slice(0, 80); } catch { return raw.slice(0, 80); }
  };
  const deviceIdOf = (req) => {
    const id = req.get('x-device-id');
    return id && id.length >= 8 && id.length <= 64 ? id : null;
  };

  async function touchDevice(user, deviceId, name) {
    await db.query(
      `INSERT INTO devices (id, user_id, name, last_seen_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, name = COALESCE(EXCLUDED.name, devices.name), last_seen_at = now()`,
      [deviceId, user.id, name || null],
    );
  }

  async function teamPayload(user) {
    const ws = await db.one('SELECT id, name, invite_code, settings FROM workspaces WHERE id = $1', [user.workspace_id]);
    const members = await db.query('SELECT id, name, role FROM users WHERE workspace_id = $1 AND NOT disabled ORDER BY name', [user.workspace_id]);
    const s = ws.settings || {};
    return {
      id: ws.id,
      name: ws.name,
      invite_code: user.role === 'admin' ? ws.invite_code : undefined,
      rules: sanitizeRules(s.rules),
      custom_fields: s.customFields || [],
      retention_days: s.retentionDays || 30,
      members,
    };
  }

  async function issueSession(user, deviceId, deviceName) {
    await db.query('UPDATE devices SET revoked = false, wipe = false WHERE id = $1', [deviceId]);
    auth.forget(deviceId);
    await touchDevice(user, deviceId, deviceName);
    return {
      access_token: signAccess(user, secret),
      refresh_token: await issueRefresh(db, user.id, deviceId),
      expires_in: ACCESS_TTL_SECONDS,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, workspace_id: user.workspace_id },
      team: await teamPayload(user),
    };
  }

  // ---------- health ----------
  app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION, instanceId, time: new Date().toISOString() }));

  // ---------- auth ----------
  app.post('/api/auth/register', async (req, res) => {
    const { name, email, password, team_name: teamName, invite_code: invite } = req.body || {};
    const deviceId = deviceIdOf(req);
    if (!deviceId) return res.status(400).json({ error: 'X-Device-Id header is required' });
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!teamName && !invite) return res.status(400).json({ error: 'Create a team or enter an invite code' });
    const clean = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (await db.one('SELECT id FROM users WHERE email = $1', [clean])) return res.status(409).json({ error: 'An account with this email already exists' });
    const user = await db.tx(async (t) => {
      let wsId;
      let role;
      if (invite) {
        const ws = await t.one('SELECT id FROM workspaces WHERE upper(invite_code) = upper($1)', [String(invite).trim()]);
        if (!ws) throw new HttpError(404, 'That invite code does not match any team');
        wsId = ws.id;
        role = 'field';
      } else {
        const ws = await t.one('INSERT INTO workspaces (name, invite_code, settings) VALUES ($1, $2, $3) RETURNING id',
          [String(teamName).trim().slice(0, 60), inviteCode(), { rules: sanitizeRules({}), customFields: [], retentionDays: 30 }]);
        wsId = ws.id;
        role = 'admin';
      }
      return t.one('INSERT INTO users (email, name, password_hash, role, workspace_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, workspace_id',
        [clean, String(name).trim().slice(0, 60), hashPassword(String(password)), role, wsId]);
    });
    res.status(201).json(await issueSession(user, deviceId, deviceNameOf(req)));
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    const deviceId = deviceIdOf(req);
    if (!deviceId) return res.status(400).json({ error: 'X-Device-Id header is required' });
    const user = await db.one('SELECT * FROM users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
    if (!user || !checkPassword(String(password || ''), user.password_hash)) return res.status(401).json({ error: 'Wrong email or password', code: 'bad_credentials' });
    if (user.disabled) return res.status(403).json({ error: 'This account is disabled', code: 'account_disabled' });
    res.json(await issueSession(user, deviceId, deviceNameOf(req)));
  });

  app.post('/api/auth/refresh', async (req, res) => {
    const token = String(req.body?.refresh_token || '');
    const deviceId = deviceIdOf(req);
    const row = await db.one('SELECT * FROM refresh_tokens WHERE token_hash = $1', [sha256(token)]);
    if (!row || row.device_id !== deviceId) return res.status(401).json({ error: 'Please log in again', code: 'refresh_invalid' });
    const device = await db.one('SELECT revoked, wipe FROM devices WHERE id = $1', [deviceId]);
    if (device?.revoked) return res.status(401).json({ error: 'This device was signed out remotely', code: 'device_revoked', wipe: device.wipe });
    if (row.revoked) {
      // An already-used token came back: someone may have copied it. Sign this device out.
      await db.query('UPDATE refresh_tokens SET revoked = true WHERE device_id = $1', [deviceId]);
      return res.status(401).json({ error: 'Please log in again', code: 'refresh_reused' });
    }
    if (new Date(row.expires_at) < new Date()) return res.status(401).json({ error: 'Please log in again', code: 'refresh_expired' });
    const user = await db.one('SELECT * FROM users WHERE id = $1', [row.user_id]);
    if (!user || user.disabled) return res.status(401).json({ error: 'This account is disabled', code: 'account_disabled' });
    await db.query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [row.token_hash]);
    await touchDevice(user, deviceId, null);
    res.json({
      access_token: signAccess(user, secret),
      refresh_token: await issueRefresh(db, user.id, deviceId),
      expires_in: ACCESS_TTL_SECONDS,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, workspace_id: user.workspace_id },
    });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = String(req.body?.refresh_token || '');
    await db.query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [sha256(token)]);
    res.json({ ok: true });
  });

  app.get('/api/me', auth, async (req, res) => {
    res.json({ user: req.user, team: await teamPayload(req.user) });
  });

  // ---------- devices: list, remote sign-out, partial sync ----------
  app.get('/api/devices', auth, async (req, res) => {
    const all = req.user.role === 'admin';
    const rows = await db.query(
      `SELECT d.id, d.name, d.last_seen_at, d.last_cursor, d.scope, d.revoked, d.wipe, u.name AS user_name, u.id AS user_id
       FROM devices d JOIN users u ON u.id = d.user_id
       WHERE u.workspace_id = $1 ${all ? '' : 'AND u.id = $2'} ORDER BY d.last_seen_at DESC NULLS LAST`,
      all ? [req.user.workspace_id] : [req.user.workspace_id, req.user.id],
    );
    res.json({ devices: rows });
  });

  app.post('/api/devices/:id/revoke', auth, async (req, res) => {
    const d = await db.one('SELECT d.id, d.user_id, u.workspace_id FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = $1', [req.params.id]);
    if (!d || d.workspace_id !== req.user.workspace_id) return res.status(404).json({ error: 'Device not found' });
    if (d.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can sign out other people\'s devices' });
    const wipe = !!req.body?.wipe;
    await db.query('UPDATE devices SET revoked = true, wipe = $2 WHERE id = $1', [d.id, wipe]);
    await db.query('UPDATE refresh_tokens SET revoked = true WHERE device_id = $1', [d.id]);
    auth.forget(d.id);
    bus.publish({ type: 'revoked', workspace_id: req.user.workspace_id, device_id: d.id, wipe });
    res.json({ ok: true });
  });

  app.post('/api/devices/me/scope', auth, async (req, res) => {
    const deviceId = deviceIdOf(req);
    const mode = ['all', 'mine', 'area'].includes(req.body?.mode) ? req.body.mode : 'all';
    const area = String(req.body?.area || '').trim().slice(0, 60);
    if (mode === 'area' && !area) return res.status(400).json({ error: 'Type the area (part of the location) to sync' });
    await db.query('UPDATE devices SET scope = $1, last_cursor = 0 WHERE id = $2 AND user_id = $3', [{ mode, area }, deviceId, req.user.id]);
    res.json({ scope: { mode, area } });
  });

  // ---------- fault injection (chaos testing and the demo) ----------
  const faults = (req, res, next) => {
    if (fault.rate > 0 && Math.random() < fault.rate) {
      metrics.fault();
      db.query(`INSERT INTO sync_events (workspace_id, user_id, device_id, direction) VALUES ($1, $2, $3, 'fault')`,
        [req.user?.workspace_id ?? null, req.user?.id ?? null, req.get('x-device-id') ?? null]).catch(() => {});
      if (fault.mode === 'after') {
        res.json = () => res.status(503).type('application/json').end(JSON.stringify({ error: 'Injected fault: reply dropped after processing' }));
        return next();
      }
      return res.status(503).json({ error: 'Injected fault: request dropped' });
    }
    next();
  };

  const device = async (req, res, next) => {
    const id = deviceIdOf(req);
    if (!id) return res.status(400).json({ error: 'X-Device-Id header is required' });
    req.deviceId = id;
    await touchDevice(req.user, id, deviceNameOf(req));
    next();
  };

  // ---------- sync ----------
  app.post('/api/sync/push', auth, device, faults, async (req, res) => {
    const ops = req.body?.ops;
    if (!Array.isArray(ops)) return res.status(400).json({ error: 'Body must be { ops: [...] }' });
    if (ops.length > MAX_BATCH) return res.status(413).json({ error: `At most ${MAX_BATCH} operations per batch` });
    const { results, notifications, changed } = await pushBatch(db, req.user, req.deviceId, ops);
    metrics.syncResults(results);
    if (changed) bus.publish({ type: 'changed', workspace_id: req.user.workspace_id, device_id: req.deviceId });
    for (const n of notifications) bus.publish({ type: 'notification', workspace_id: req.user.workspace_id, user_id: n.userId });
    res.json({ results, serverTime: new Date().toISOString() });
  });

  app.get('/api/sync/pull', auth, device, faults, async (req, res) => {
    const cursor = Math.max(0, parseInt(req.query.cursor, 10) || 0);
    const limit = Math.min(MAX_PULL, Math.max(1, parseInt(req.query.limit, 10) || MAX_PULL));
    res.json({ ...(await pullChanges(db, req.user, req.deviceId, cursor, limit)), instanceId });
  });

  app.get('/api/sync/history', auth, async (req, res) => {
    const rows = await db.query(
      `SELECT e.*, d.name AS device_name FROM sync_events e LEFT JOIN devices d ON d.id = e.device_id
       WHERE e.user_id = $1 ORDER BY e.id DESC LIMIT 50`, [req.user.id]);
    res.json({ events: rows });
  });

  // ---------- record history (undo is a normal edit back to an old version) ----------
  app.get('/api/records/:id/history', auth, async (req, res) => {
    const r = await db.one('SELECT workspace_id FROM records WHERE id = $1', [req.params.id]);
    if (!r || r.workspace_id !== req.user.workspace_id) return res.status(404).json({ error: 'Record not found' });
    const rows = await db.query(
      'SELECT version, snapshot, changed_fields, kind, user_name, created_at FROM record_versions WHERE record_id = $1 ORDER BY version DESC LIMIT 50',
      [req.params.id]);
    res.json({ versions: rows });
  });

  // ---------- conflicts ----------
  app.get('/api/conflicts', auth, async (req, res) => {
    const status = req.query.status === 'resolved' ? 'resolved' : 'open';
    const rows = await db.query(
      `SELECT c.*, r.title AS record_title, r.version AS record_version, u.name AS user_name FROM conflicts c
       LEFT JOIN records r ON r.id = c.record_id LEFT JOIN users u ON u.id = c.user_id
       WHERE c.workspace_id = $1 AND c.status = $2 ORDER BY c.id DESC LIMIT 100`,
      [req.user.workspace_id, status]);
    const recs = new Map();
    for (const c of rows) if (!recs.has(c.record_id)) recs.set(c.record_id, await loadRecord(db, c.record_id));
    res.json({
      conflicts: rows.map((c) => {
        const rec = recs.get(c.record_id);
        const current = Object.fromEntries(c.fields.map((f) => [f, rec ? getField(rec, f) : null]));
        const suggested = {};
        for (const f of c.fields) {
          if (typeof current[f] === 'string' && typeof c.local_value[f] === 'string' && ['notes', 'title', 'location'].includes(f)) {
            suggested[f] = suggestMerge(current[f], c.local_value[f]);
          }
        }
        return {
          id: c.id, record_id: c.record_id, record_title: c.record_title, raised_by: c.user_name, raised_by_id: c.user_id,
          fields: c.fields, local_value: c.local_value, server_value: c.server_value, current_value: current, suggested_value: suggested,
          record_version: c.record_version, status: c.status, resolution: c.resolution,
          can_resolve: can.resolveConflict(req.user, c), created_at: c.created_at, resolved_at: c.resolved_at,
        };
      }),
    });
  });

  app.post('/api/conflicts/:id/resolve', auth, async (req, res) => {
    const c = await db.one('SELECT * FROM conflicts WHERE id = $1 AND workspace_id = $2', [Number(req.params.id), req.user.workspace_id]);
    if (!c) return res.status(404).json({ error: 'Conflict not found' });
    if (c.status !== 'open') return res.status(409).json({ error: 'Conflict already resolved' });
    if (!can.resolveConflict(req.user, c)) return res.status(403).json({ error: 'Only supervisors, admins or the person who raised it can resolve this conflict' });
    const { choice, values, seen_version: seen } = req.body || {};
    const fields = c.fields;
    let chosen;
    if (choice === 'mine') chosen = c.local_value;
    else if (choice === 'theirs') chosen = {};
    else if (choice === 'custom') chosen = Object.fromEntries(fields.filter((f) => values && f in values).map((f) => [f, values[f]]));
    else return res.status(400).json({ error: 'choice must be mine, theirs or custom' });

    const ws = await db.one('SELECT settings FROM workspaces WHERE id = $1', [req.user.workspace_id]);
    const members = new Set((await db.query('SELECT id FROM users WHERE workspace_id = $1', [req.user.workspace_id])).map((m) => m.id));
    const errors = validateFields(chosen, { customFields: ws.settings?.customFields || [], memberIds: members });
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const deviceId = deviceIdOf(req);
    const result = await db.tx(async (t) => {
      let current = await loadRecord(t, c.record_id, { lock: true });
      // The person chose while looking at version N. If someone saved again since, their
      // choice could overwrite an edit they never saw: refuse and let them look again.
      if (choice !== 'theirs' && seen != null && current && Number(seen) !== current.version) return { stale: true };
      if (current && Object.keys(chosen).length) {
        let notes = null;
        if ('notes' in chosen) {
          const doc = loadDoc(current.notes_state, current.notes);
          setText(doc, chosen.notes);
          notes = { text: chosen.notes, state: Buffer.from(encode(doc)) };
        }
        current = await writeFields(t, current, chosen, { opId: null, deviceId, user: req.user, kind: 'resolve', notes });
      }
      await t.query(`UPDATE conflicts SET status = 'resolved', resolution = $1, resolved_by = $2, resolved_at = now() WHERE id = $3`,
        [choice, req.user.id, c.id]);
      const att = current ? (await attachmentsFor(t, [current.id])).get(current.id) || [] : [];
      return { record: publicRecord(current, att) };
    });
    if (result.stale) return res.status(409).json({ error: 'This record changed again while you were deciding. The latest version is now shown; please choose again.', stale: true });
    bus.publish({ type: 'changed', workspace_id: req.user.workspace_id });
    res.json(result);
  });

  // ---------- attachments (photos, files) ----------
  app.post('/api/attachments/:id/init', auth, async (req, res) => {
    res.json(await initUpload(db, req.user, { ...req.body, id: req.params.id }));
  });
  app.put('/api/attachments/:id/chunk', auth, faults, express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK + 1024 }), async (req, res) => {
    const out = await appendChunk(db, req.user, req.params.id, Number(req.query.offset), req.body);
    if (out.done) bus.publish({ type: 'changed', workspace_id: req.user.workspace_id });
    res.json({ received: out.received, uploaded: out.uploaded });
  });
  app.get('/api/attachments/:id', auth, async (req, res) => {
    const a = await readAttachment(db, req.user, req.params.id);
    res.set('Content-Type', a.mime).set('Cache-Control', 'private, max-age=86400').send(a.data);
  });
  app.delete('/api/attachments/:id', auth, async (req, res) => {
    await deleteAttachment(db, req.user, req.params.id);
    bus.publish({ type: 'changed', workspace_id: req.user.workspace_id });
    res.json({ ok: true });
  });

  // ---------- notifications ----------
  app.get('/api/notifications', auth, async (req, res) => {
    const rows = await db.query('SELECT id, kind, record_id, message, read, created_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [req.user.id]);
    const unread = await db.one('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT read', [req.user.id]);
    res.json({ notifications: rows, unread: unread.n });
  });
  app.post('/api/notifications/read', auth, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
    if (ids) await db.query('UPDATE notifications SET read = true WHERE user_id = $1 AND id = ANY($2)', [req.user.id, ids]);
    else await db.query('UPDATE notifications SET read = true WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  });

  // ---------- reports ----------
  app.get('/api/reports/summary', auth, async (req, res) => {
    res.json(await summary(db, req.user.workspace_id));
  });
  app.get('/api/reports/export', auth, async (req, res) => {
    const format = ['csv', 'xlsx', 'pdf'].includes(req.query.format) ? req.query.format : 'csv';
    const filters = { status: req.query.status || null, priority: req.query.priority || null, overdue: req.query.overdue === '1' };
    const team = await teamPayload(req.user);
    const rows = await exportRows(db, req.user.workspace_id, filters);
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `syncsafe-report-${stamp}.${format}`;
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    if (format === 'csv') return res.type('text/csv').send(toCSV(rows, team.custom_fields));
    const sum = await summary(db, req.user.workspace_id);
    if (format === 'xlsx') return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await toXLSX(rows, sum, team.name, team.custom_fields));
    return res.type('application/pdf').send(await toPDF(rows, sum, team.name));
  });

  // ---------- admin ----------
  app.get('/api/admin/sync-health', auth, supervisor, async (req, res) => {
    const ws = req.user.workspace_id;
    const devices = await db.query(
      `SELECT d.id, d.name, d.last_cursor, d.last_seen_at, d.scope, d.revoked, u.name AS user_name FROM devices d
       JOIN users u ON u.id = d.user_id WHERE u.workspace_id = $1 ORDER BY d.last_seen_at DESC NULLS LAST`, [ws]);
    const totals = await db.one(
      `SELECT count(*) FILTER (WHERE NOT is_deleted)::int AS records, count(*) FILTER (WHERE is_deleted)::int AS deleted,
         count(*) FILTER (WHERE flagged AND NOT is_deleted)::int AS flagged FROM records WHERE workspace_id = $1`, [ws]);
    const conflicts = await db.one(
      `SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'resolved')::int AS resolved
       FROM conflicts WHERE workspace_id = $1`, [ws]);
    const days = await db.query(
      `SELECT to_char(at, 'YYYY-MM-DD') AS day,
         count(*) FILTER (WHERE direction = 'push')::int AS pushes, count(*) FILTER (WHERE direction = 'pull')::int AS pulls,
         coalesce(sum(applied), 0)::int AS applied, coalesce(sum(conflicts), 0)::int AS conflicts, coalesce(sum(rejected), 0)::int AS rejected,
         coalesce(sum(duplicates), 0)::int AS duplicates, count(*) FILTER (WHERE direction = 'fault')::int AS failures,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE direction = 'push') AS p95_push_ms
       FROM sync_events WHERE workspace_id = $1 GROUP BY 1 ORDER BY 1 DESC LIMIT 7`, [ws]);
    const settings = (await db.one('SELECT settings FROM workspaces WHERE id = $1', [ws])).settings || {};
    res.json({ devices, totals, conflicts, days, fault, live_connections: live?.count() ?? 0, database: db.kind,
      last_compaction: settings.lastCompaction || null, compacted_through: settings.compactedThrough || 0 });
  });

  app.get('/api/admin/users', auth, admin, async (req, res) => {
    const users = await db.query('SELECT id, name, email, role, disabled, created_at FROM users WHERE workspace_id = $1 ORDER BY name', [req.user.workspace_id]);
    res.json({ users });
  });
  app.post('/api/admin/users/:id', auth, admin, async (req, res) => {
    const id = Number(req.params.id);
    const u = await db.one('SELECT id, workspace_id FROM users WHERE id = $1', [id]);
    if (!u || u.workspace_id !== req.user.workspace_id) return res.status(404).json({ error: 'User not found' });
    if (id === req.user.id && (req.body.role && req.body.role !== 'admin' || req.body.disabled)) {
      return res.status(400).json({ error: 'You cannot remove your own admin access' });
    }
    if (req.body.role && !ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Unknown role' });
    if (req.body.role) await db.query('UPDATE users SET role = $1 WHERE id = $2', [req.body.role, id]);
    if (typeof req.body.disabled === 'boolean') {
      await db.query('UPDATE users SET disabled = $1 WHERE id = $2', [req.body.disabled, id]);
      if (req.body.disabled) await db.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [id]);
    }
    res.json({ user: await db.one('SELECT id, name, email, role, disabled FROM users WHERE id = $1', [id]) });
  });

  app.get('/api/admin/settings', auth, admin, async (req, res) => {
    res.json({ ...(await teamPayload(req.user)), rule_choices: RULE_CHOICES });
  });
  app.post('/api/admin/settings', auth, admin, async (req, res) => {
    const ws = await db.one('SELECT settings FROM workspaces WHERE id = $1', [req.user.workspace_id]);
    const s = { ...(ws.settings || {}) };
    if (req.body.rules) s.rules = sanitizeRules(req.body.rules);
    if (req.body.custom_fields) s.customFields = sanitizeCustomFields(req.body.custom_fields);
    if (req.body.retention_days != null) {
      const d = Number(req.body.retention_days);
      if (!(d >= 1 && d <= 3650)) return res.status(400).json({ error: 'Retention must be 1 to 3650 days' });
      s.retentionDays = d;
    }
    if (req.body.team_name) await db.query('UPDATE workspaces SET name = $1 WHERE id = $2', [String(req.body.team_name).slice(0, 60), req.user.workspace_id]);
    await db.query('UPDATE workspaces SET settings = $1 WHERE id = $2', [s, req.user.workspace_id]);
    bus.publish({ type: 'settings', workspace_id: req.user.workspace_id });
    res.json(await teamPayload(req.user));
  });
  app.post('/api/admin/invite/regenerate', auth, admin, async (req, res) => {
    const code = inviteCode();
    await db.query('UPDATE workspaces SET invite_code = $1 WHERE id = $2', [code, req.user.workspace_id]);
    res.json({ invite_code: code });
  });
  app.post('/api/admin/fault', auth, admin, (req, res) => {
    const rate = Number(req.body?.rate);
    if (!(rate >= 0 && rate <= 0.9)) return res.status(400).json({ error: 'rate must be between 0 and 0.9' });
    fault.rate = rate;
    fault.mode = req.body?.mode === 'after' ? 'after' : 'before';
    res.json({ fault });
  });
  app.post('/api/admin/compact', auth, admin, async (req, res) => {
    res.json(await compact(db, req.user.workspace_id));
  });
  app.get('/api/admin/metrics/live', auth, supervisor, (req, res) => res.json(metrics.live()));

  // Prometheus scraping: from this computer, with METRICS_TOKEN, or as a signed-in admin.
  app.get('/metrics', async (req, res, next) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const tokenOk = process.env.METRICS_TOKEN && req.query.token === process.env.METRICS_TOKEN;
    if (!local && !tokenOk) return auth(req, res, () => (req.user.role === 'admin' ? next() : res.status(403).end()));
    next();
  }, async (req, res) => {
    const counts = await db.one(`SELECT count(*) FILTER (WHERE NOT is_deleted)::int AS records, (SELECT count(*)::int FROM conflicts WHERE status = 'open') AS conflicts FROM records`);
    metrics.gauge('syncsafe_records', counts.records);
    metrics.gauge('syncsafe_open_conflicts', counts.conflicts);
    res.type('text/plain; version=0.0.4').send(metrics.prometheus());
  });

  // ---------- static client (PWA) ----------
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });

  let live = null;
  return {
    app, db, bus, fault, metrics, instanceId, secret,
    setLive(l) { live = l; },
  };
}
