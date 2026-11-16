// Integration tests for the v2 features.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { startServer, device, loginFull, client, newId, createOp, updateOp, deleteOp } from './helpers.js';
import { loadDoc, setText, encode, toB64, fromB64, getText } from '../public/js/textcrdt.js';

let srv, admin, meera, asha, ravi, guest;
before(async () => {
  srv = await startServer();
  admin = await device(srv.base, 'admin@syncsafe.test', 'Admin@123');
  meera = await device(srv.base, 'meera@syncsafe.test');
  asha = await device(srv.base, 'asha@syncsafe.test');
  ravi = await device(srv.base, 'ravi@syncsafe.test');
  guest = await device(srv.base, 'guest@syncsafe.test');
});
after(() => srv.close());

const post = (path, body, headers = {}) => fetch(`${srv.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// ---------- auth ----------
test('refresh tokens rotate; re-using an old one signs the device out', async () => {
  const s = await loginFull(srv.base, 'asha@syncsafe.test');
  const h = { 'x-device-id': s.deviceId };
  const r1 = await (await post('/api/auth/refresh', { refresh_token: s.refresh_token }, h)).json();
  assert.ok(r1.access_token && r1.refresh_token && r1.refresh_token !== s.refresh_token);
  const reuse = await post('/api/auth/refresh', { refresh_token: s.refresh_token }, h);
  assert.equal(reuse.status, 401);
  assert.equal((await reuse.json()).code, 'refresh_reused');
  const after = await post('/api/auth/refresh', { refresh_token: r1.refresh_token }, h);
  assert.equal(after.status, 401, 'the newer token was revoked too');
});

test('refresh token only works on the device it was issued to', async () => {
  const s = await loginFull(srv.base, 'ravi@syncsafe.test');
  const other = await post('/api/auth/refresh', { refresh_token: s.refresh_token }, { 'x-device-id': newId() });
  assert.equal(other.status, 401);
});

test('admin remote sign-out (with wipe) blocks the device immediately', async () => {
  const phone = await device(srv.base, 'ravi@syncsafe.test');
  assert.equal((await phone.pull(0)).status, 200);
  assert.equal((await admin.post(`/api/devices/${phone.deviceId}/revoke`, { wipe: true })).status, 200);
  const res = await phone.pull(0);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'device_revoked');
  assert.equal(res.body.wipe, true);
  const refresh = await post('/api/auth/refresh', { refresh_token: phone.session.refresh_token }, { 'x-device-id': phone.deviceId });
  assert.equal(refresh.status, 401);
  // Logging in again on that device works (a fresh start).
  const again = await loginFull(srv.base, 'ravi@syncsafe.test', 'Test@123', phone.deviceId);
  assert.equal(again.status, 200);
});

test('a field worker cannot sign out someone else\'s device', async () => {
  assert.equal((await asha.post(`/api/devices/${ravi.deviceId}/revoke`, {})).status, 403);
});

// ---------- roles ----------
test('viewer can read but not change; field worker cannot assign or delete others\' records', async () => {
  assert.equal((await guest.pull(0)).status, 200);
  const g = (await guest.push([createOp({ title: 'viewer try' })])).body.results[0];
  assert.equal(g.status, 'rejected');
  assert.match(g.reason, /view/);

  const raviId = ravi.session.user.id;
  const assign = (await asha.push([createOp({ title: 'Self assign?', assigned_to: raviId })])).body.results[0];
  assert.equal(assign.status, 'rejected');
  assert.match(assign.reason, /assign/);

  const op = createOp({ title: 'Ravi made this' });
  await ravi.push([op]);
  const del = (await asha.push([deleteOp(op.record_id, 1)])).body.results[0];
  assert.equal(del.status, 'rejected');
  assert.equal((await meera.push([deleteOp(op.record_id, 1)])).body.results[0].record.is_deleted, true);
});

test('admin manages roles; admin-only routes are protected', async () => {
  assert.equal((await asha.get('/api/admin/users')).status, 403);
  const users = (await admin.get('/api/admin/users')).body.users;
  const guestUser = users.find((u) => u.email === 'guest@syncsafe.test');
  assert.equal((await admin.post(`/api/admin/users/${guestUser.id}`, { role: 'field' })).body.user.role, 'field');
  assert.equal((await admin.post(`/api/admin/users/${guestUser.id}`, { role: 'viewer' })).body.user.role, 'viewer');
  assert.equal((await admin.post(`/api/admin/users/${admin.session.user.id}`, { role: 'field' })).status, 400);
});

// ---------- teams ----------
test('register a new team, then a teammate joins with its invite code', async () => {
  const d1 = newId();
  const boss = await (await post('/api/auth/register', { name: 'Lena', email: 'lena@example.com', password: 'secret1', team_name: 'Hill Survey' }, { 'x-device-id': d1 })).json();
  assert.equal(boss.user.role, 'admin');
  assert.ok(boss.team.invite_code);
  const mate = await (await post('/api/auth/register', { name: 'Omar', email: 'omar@example.com', password: 'secret1', invite_code: boss.team.invite_code.toLowerCase() }, { 'x-device-id': newId() })).json();
  assert.equal(mate.user.role, 'field');
  assert.equal(mate.user.workspace_id, boss.user.workspace_id);
  assert.equal(mate.team.invite_code, undefined, 'only admins see the invite code');
  const bad = await post('/api/auth/register', { name: 'X', email: 'x@example.com', password: 'secret1', invite_code: 'NOPE-0000' }, { 'x-device-id': newId() });
  assert.equal(bad.status, 404);
  const empty = (await client(srv.base, boss.access_token, d1).pull(0)).body;
  assert.equal(empty.changes.length, 0);
});

// ---------- conflict rules + CRDT notes ----------
test('admin switches notes to "merge": both offline edits are merged character by character', async () => {
  const set = await admin.post('/api/admin/settings', { rules: { notes: 'merge' } });
  assert.equal(set.body.rules.notes, 'merge');

  const op = createOp({ title: 'CRDT notes', notes: 'Pump broken.' });
  op.notes_state = toB64(encode(loadDoc(null, 'Pump broken.')));
  const created = (await asha.push([op])).body.results[0].record;
  const base = fromB64(created.notes_state);

  const edit = (text) => { const d = loadDoc(base); setText(d, text); return toB64(encode(d)); };
  const a = (await asha.push([updateOp(op.record_id, { notes: 'Pump broken. Crew booked Friday.' }, 1, { notes_state: edit('Pump broken. Crew booked Friday.') })])).body.results[0];
  assert.equal(a.status, 'applied');
  const b = (await ravi.push([updateOp(op.record_id, { notes: 'Water pump broken.' }, 1, { notes_state: edit('Water pump broken.') })])).body.results[0];
  assert.equal(b.status, 'merged');
  assert.equal(b.merged_notes, true);
  assert.equal(b.record.notes, 'Water pump broken. Crew booked Friday.');
  assert.equal(getText(loadDoc(fromB64(b.record.notes_state))), b.record.notes);
  const open = (await asha.get('/api/conflicts')).body.conflicts.filter((c) => c.record_id === op.record_id);
  assert.equal(open.length, 0, 'no conflict screen needed');
  await admin.post('/api/admin/settings', { rules: { notes: 'manual' } });
});

test('rule "lww" for status: the later write wins with no conflict', async () => {
  await admin.post('/api/admin/settings', { rules: { status: 'lww' } });
  const op = createOp({ title: 'LWW status' });
  await asha.push([op]);
  await asha.push([updateOp(op.record_id, { status: 'Visited' }, 1)]);
  const r = (await ravi.push([updateOp(op.record_id, { status: 'Closed' }, 1)])).body.results[0];
  assert.equal(r.status, 'merged');
  assert.equal(r.record.status, 'Closed');
  assert.deepEqual(r.overwritten, ['status']);
  await admin.post('/api/admin/settings', { rules: { status: 'manual' } });
});

test('custom form fields: admin defines them, validation follows, required on create', async () => {
  const fields = [
    { key: 'households', label: 'Households affected', type: 'number' },
    { key: 'Water Source', label: 'Water source', type: 'select', options: ['Well', 'Tap', 'River'], required: true },
  ];
  const s = (await admin.post('/api/admin/settings', { custom_fields: fields })).body;
  assert.deepEqual(s.custom_fields.map((f) => f.key), ['households', 'water_source']);
  const missing = (await asha.push([createOp({ title: 'No source' })])).body.results[0];
  assert.match(missing.reason, /Water source is required/);
  const ok = (await asha.push([createOp({ title: 'With source', custom: { water_source: 'Well', households: 3 } })])).body.results[0];
  assert.equal(ok.status, 'applied');
  assert.equal(ok.record.custom.water_source, 'Well');
  await admin.post('/api/admin/settings', { custom_fields: [] });
});

// ---------- history ----------
test('history lists every version; undo is an edit back to an old snapshot', async () => {
  const op = createOp({ title: 'History', priority: 'Low' });
  await asha.push([op]);
  await asha.push([updateOp(op.record_id, { priority: 'High' }, 1)]);
  await ravi.push([updateOp(op.record_id, { title: 'History (edited)' }, 2)]);
  const versions = (await asha.get(`/api/records/${op.record_id}/history`)).body.versions;
  assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
  assert.deepEqual(versions[0].changed_fields, ['title']);
  const v1 = versions[2].snapshot;
  const undo = (await asha.push([updateOp(op.record_id, { title: v1.title, priority: v1.priority }, 3)])).body.results[0];
  assert.equal(undo.record.title, 'History');
  assert.equal(undo.record.priority, 'Low');
  assert.equal(undo.record.version, 4);
  assert.equal((await client(srv.base, (await loginFull(srv.base, 'nurse@rivervalley.test')).access_token).get(`/api/records/${op.record_id}/history`)).status, 404);
});

// ---------- partial sync ----------
test('partial sync: "assigned to me" and "area" scopes; out-of-scope records are evicted', async () => {
  const me = ravi.session.user.id;
  await ravi.post('/api/devices/me/scope', { mode: 'mine' });
  let page = (await ravi.pull(0)).body;
  const kept = page.changes.filter((c) => !c.evicted && !c.is_deleted);
  assert.ok(kept.length > 0);
  assert.ok(kept.every((c) => c.assigned_to === me || c.created_by === me));
  assert.ok(page.changes.some((c) => c.evicted));
  await ravi.post('/api/devices/me/scope', { mode: 'area', area: 'Ward' });
  page = (await ravi.pull(0)).body;
  assert.ok(page.changes.filter((c) => !c.evicted && !c.is_deleted).every((c) => /ward/i.test(c.location)));
  assert.equal((await ravi.post('/api/devices/me/scope', { mode: 'area', area: '' })).status, 400);
  await ravi.post('/api/devices/me/scope', { mode: 'all' });
});

// ---------- compaction ----------
test('compaction removes old tombstones; devices that synced before must resync', async () => {
  const phone = await device(srv.base, 'asha@syncsafe.test');
  const op = createOp({ title: 'Old deleted' });
  await phone.push([op]);
  const { cursor: oldCursor } = (await phone.pull(0)).body;
  await meera.push([deleteOp(op.record_id, 1)]);
  await srv.db.query(`UPDATE records SET deleted_at = now() - interval '40 days' WHERE id = $1`, [op.record_id]);
  const res = (await admin.post('/api/admin/compact')).body;
  assert.ok(res.tombstones_removed >= 1);
  assert.equal(await srv.db.one('SELECT id FROM records WHERE id = $1', [op.record_id]), null);
  const stale = (await phone.pull(oldCursor)).body;
  assert.equal(stale.resync, true);
  const fresh = (await phone.pull(res.compacted_through)).body;
  assert.ok(!fresh.resync);
});

// ---------- attachments ----------
test('photo upload in chunks resumes after a dropped chunk; checksum enforced; others can download', async () => {
  const op = createOp({ title: 'Photo record' });
  await asha.push([op]);
  const bytes = crypto.randomBytes(700 * 1024);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const id = newId();
  const init = await asha.post(`/api/attachments/${id}/init`, { record_id: op.record_id, name: 'pump.jpg', mime: 'image/jpeg', size: bytes.length, sha256: sha });
  assert.equal(init.body.received, 0);
  const c1 = await asha.putChunk(id, 0, bytes.subarray(0, 400 * 1024));
  assert.equal(c1.body.received, 400 * 1024);
  const wrong = await asha.putChunk(id, 0, bytes.subarray(0, 1000));               // e.g. a retry after a lost reply
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.received, 400 * 1024);
  const again = await asha.post(`/api/attachments/${id}/init`, { record_id: op.record_id, name: 'pump.jpg', mime: 'image/jpeg', size: bytes.length, sha256: sha });
  assert.equal(again.body.received, 400 * 1024, 'resume point after reconnecting');
  const c2 = await asha.putChunk(id, 400 * 1024, bytes.subarray(400 * 1024));
  assert.equal(c2.body.uploaded, true);
  const rec = (await ravi.pull(0)).body.changes.find((r) => r.id === op.record_id);
  assert.equal(rec.attachments.length, 1);
  assert.equal(rec.attachments[0].uploaded, true);
  const dl = await ravi.get(`/api/attachments/${id}`);
  assert.equal(dl.status, 200);
  assert.ok(Buffer.compare(dl.body, bytes) === 0);
  assert.equal((await guest.post(`/api/attachments/${newId()}/init`, { record_id: op.record_id, name: 'x', mime: 'image/png', size: 5, sha256: sha })).status, 403);
  assert.equal((await asha.post(`/api/attachments/${newId()}/init`, { record_id: op.record_id, name: 'x.exe', mime: 'application/x-msdownload', size: 5, sha256: sha })).status, 400);
  assert.equal((await asha.del(`/api/attachments/${id}`)).status, 200);
  const after = (await ravi.pull(0)).body.changes.find((r) => r.id === op.record_id);
  assert.equal(after.attachments.length, 0);
});

test('damaged upload (wrong checksum) is reset so it is sent again', async () => {
  const op = createOp({ title: 'Bad photo' });
  await asha.push([op]);
  const bytes = crypto.randomBytes(1000);
  const id = newId();
  await asha.post(`/api/attachments/${id}/init`, { record_id: op.record_id, name: 'a.png', mime: 'image/png', size: 1000, sha256: 'a'.repeat(64) });
  const res = await asha.putChunk(id, 0, bytes);
  assert.equal(res.status, 422);
  assert.equal(res.body.received, 0);
});

// ---------- notifications ----------
test('assignment and conflict create notifications for the right people', async () => {
  const before = (await asha.get('/api/notifications')).body.unread;
  const op = createOp({ title: 'Assigned job', assigned_to: asha.session.user.id, due_date: '2030-01-15' });
  assert.equal((await meera.push([op])).body.results[0].status, 'applied');
  const n = (await asha.get('/api/notifications')).body;
  assert.equal(n.unread, before + 1);
  assert.match(n.notifications[0].message, /assigned you "Assigned job"/);
  await asha.post('/api/notifications/read', {});
  assert.equal((await asha.get('/api/notifications')).body.unread, 0);

  await asha.push([updateOp(op.record_id, { status: 'Visited' }, 1)]);
  await ravi.push([updateOp(op.record_id, { status: 'Closed' }, 1)]);
  const sup = (await meera.get('/api/notifications')).body.notifications;
  assert.ok(sup.some((x) => x.kind === 'conflict'));
});

// ---------- reports ----------
test('reports: summary numbers and CSV / Excel / PDF exports', async () => {
  const s = (await asha.get('/api/reports/summary')).body;
  assert.ok(s.total >= 24);
  assert.ok(s.overdue >= 1, 'sample data has overdue assignments');
  assert.ok(s.by_status.length >= 3);
  assert.equal(s.created_per_day.length, 14);
  const csv = await asha.get('/api/reports/export?format=csv&status=Pending');
  assert.equal(csv.status, 200);
  const text = csv.body.toString();
  assert.match(text.split('\n')[0], /^Title,Location,Status/);
  assert.ok(text.split('\n').slice(1).filter(Boolean).every((l) => l.includes('Pending')));
  const xlsx = await asha.get('/api/reports/export?format=xlsx');
  assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
  const pdf = await asha.get('/api/reports/export?format=pdf&overdue=1');
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.headers.get('content-disposition'), /syncsafe-report-.*\.pdf/);
});

// ---------- observability ----------
test('Prometheus metrics and live admin charts', async () => {
  const m = await fetch(`${srv.base}/metrics`);
  const text = await m.text();
  assert.match(text, /syncsafe_http_requests_total/);
  assert.match(text, /syncsafe_sync_operations_total\{result="applied"\}/);
  const live = (await meera.get('/api/admin/metrics/live')).body;
  assert.equal(live.minutes.length, 60);
  assert.ok(live.minutes.at(-1).requests > 0);
  const health = (await admin.get('/api/admin/sync-health')).body;
  assert.equal(health.database, process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite');
  assert.ok(health.days[0].p95_push_ms != null);
});

// ---------- live updates ----------
test('WebSocket: another device is told about a change within a moment', async () => {
  const ws = new WebSocket(srv.base.replace('http', 'ws') + '/api/live');
  const messages = [];
  await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: ravi.token, device_id: ravi.deviceId })));
    ws.on('message', (m) => { const msg = JSON.parse(m); messages.push(msg); if (msg.type === 'ready') resolve(); });
    ws.on('error', reject);
  });
  await asha.push([createOp({ title: 'Live!' })]);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(messages.some((m) => m.type === 'changed'));
  ws.close();
});

test('WebSocket rejects a bad token', async () => {
  const ws = new WebSocket(srv.base.replace('http', 'ws') + '/api/live');
  const code = await new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'nope' })));
    ws.on('close', (c) => resolve(c));
  });
  assert.equal(code, 4001);
});
