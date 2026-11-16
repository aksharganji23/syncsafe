// Integration tests for the core sync protocol (real HTTP, real PostgreSQL in memory).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, device, createOp, updateOp, deleteOp } from './helpers.js';

let srv, asha, ravi;
before(async () => {
  srv = await startServer();
  asha = await device(srv.base, 'asha@syncsafe.test');
  ravi = await device(srv.base, 'ravi@syncsafe.test');
});
after(() => srv.close());

test('login rejects a wrong password and requires a device id', async () => {
  let res = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': 'abcdefgh-1' }, body: JSON.stringify({ email: 'asha@syncsafe.test', password: 'nope' }) });
  assert.equal(res.status, 401);
  res = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'asha@syncsafe.test', password: 'Test@123' }) });
  assert.equal(res.status, 400);
});

test('sync endpoints require login', async () => {
  const res = await fetch(`${srv.base}/api/sync/pull`, { headers: { 'x-device-id': 'abcdefgh-1234' } });
  assert.equal(res.status, 401);
});

test('first pull returns the 24 sample records with GPS, assignments and form values', async () => {
  const { body } = await asha.pull(0);
  assert.equal(body.changes.length, 24);
  const pump = body.changes.find((r) => r.title.startsWith('Hand pump'));
  assert.ok(pump.geo && pump.geo.lat > 38);
  assert.equal(pump.custom.ward, 'Ward 4');
  assert.ok(pump.assigned_to);
  assert.ok(pump.notes_state, 'notes come with their CRDT state');
});

test('teams are isolated: another team never sees Demo Team records', async () => {
  const nurse = await device(srv.base, 'nurse@rivervalley.test');
  const { body } = await nurse.pull(0);
  assert.equal(body.changes.length, 3);
  const demoId = (await asha.pull(0)).body.changes[0].id;
  const res = (await nurse.push([updateOp(demoId, { notes: 'hack' }, 1)])).body.results[0];
  assert.equal(res.status, 'rejected');
});

test('pull pages through results with a cursor', async () => {
  const first = (await asha.pull(0, 10)).body;
  assert.equal(first.changes.length, 10);
  assert.equal(first.hasMore, true);
  const second = (await asha.pull(first.cursor, 10)).body;
  assert.ok(second.changes.every((r) => !first.changes.some((f) => f.id === r.id)));
});

test('push creates a record and other devices pull it', async () => {
  const { cursor } = (await ravi.pull(0)).body;
  const op = createOp({ title: 'New well survey', location: 'Ward 9', geo: { lat: 38.76, lng: -93.73, accuracy: 8 }, custom: { households: 5 } });
  const r = (await asha.push([op])).body.results[0];
  assert.equal(r.status, 'applied');
  assert.equal(r.record.version, 1);
  const pulled = (await ravi.pull(cursor)).body.changes;
  const got = pulled.find((x) => x.id === op.record_id);
  assert.equal(got.title, 'New well survey');
  assert.equal(got.custom.households, 5);
  assert.equal(got.geo.accuracy, 8);
});

test('retrying the same batch never creates duplicates (idempotency)', async () => {
  const op = createOp({ title: 'Retry me' });
  const r1 = (await asha.push([op])).body.results[0];
  const r2 = (await asha.push([op])).body.results[0];
  const r3 = (await asha.push([op])).body.results[0];
  assert.equal(r1.status, 'applied');
  assert.equal(r2.duplicate, true);
  assert.equal(r3.duplicate, true);
  assert.equal(r3.record.title, 'Retry me');
  assert.equal(r2.op_id, op.op_id);                 // the device needs the op_id to clear its outbox
  assert.equal(r2.status, 'applied');
  const [x, y] = (await asha.push([op, op])).body.results;   // same op twice inside one batch
  assert.equal(x.op_id, op.op_id); assert.equal(y.op_id, op.op_id);
  const rows = await srv.db.query('SELECT count(*)::int AS n FROM change_log WHERE op_id = $1', [op.op_id]);
  assert.equal(rows[0].n, 1);
});

test('two devices edit different fields: both edits survive', async () => {
  const op = createOp({ title: 'Merge test', status: 'Pending' });
  await asha.push([op]);
  const ra = (await asha.push([updateOp(op.record_id, { title: 'Merge test (renamed)' }, 1)])).body.results[0];
  const rb = (await ravi.push([updateOp(op.record_id, { status: 'Visited' }, 1)])).body.results[0];
  assert.equal(ra.status, 'applied');
  assert.equal(rb.status, 'merged');
  assert.equal(rb.record.title, 'Merge test (renamed)');
  assert.equal(rb.record.status, 'Visited');
});

test('same important field: conflict, resolved by the person who raised it', async () => {
  const op = createOp({ title: 'Conflict test', notes: 'original' });
  await asha.push([op]);
  await asha.push([updateOp(op.record_id, { notes: 'from Asha' }, 1)]);
  const rb = (await ravi.push([updateOp(op.record_id, { notes: 'from Ravi', priority: 'High' }, 1)])).body.results[0];
  assert.equal(rb.status, 'conflict');
  assert.deepEqual(rb.fields, ['notes']);
  assert.equal(rb.record.notes, 'from Asha');
  assert.equal(rb.record.priority, 'High');

  const list = (await ravi.get('/api/conflicts')).body.conflicts;
  const open = list.find((c) => c.id === rb.conflict_id);
  assert.equal(open.local_value.notes, 'from Ravi');
  assert.equal(open.current_value.notes, 'from Asha');
  assert.ok(open.suggested_value.notes.includes('from Asha') && open.suggested_value.notes.includes('from Ravi'));
  assert.equal(open.can_resolve, true);

  const resolved = (await ravi.post(`/api/conflicts/${rb.conflict_id}/resolve`, { choice: 'custom', values: { notes: 'from Asha + from Ravi' }, seen_version: open.record_version })).body;
  assert.equal(resolved.record.notes, 'from Asha + from Ravi');
  assert.equal((await ravi.post(`/api/conflicts/${rb.conflict_id}/resolve`, { choice: 'mine' })).status, 409);
});

test('edit vs delete: the edit wins and the record is restored', async () => {
  const meera = await device(srv.base, 'meera@syncsafe.test');
  const op = createOp({ title: 'Delete race' });
  await asha.push([op]);
  assert.equal((await meera.push([deleteOp(op.record_id, 1)])).body.results[0].record.is_deleted, true);
  const rb = (await ravi.push([updateOp(op.record_id, { notes: 'still needed' }, 1)])).body.results[0];
  assert.equal(rb.status, 'restored');
  assert.equal(rb.record.is_deleted, false);
  assert.equal(rb.record.flagged, true);
});

test('delete is cancelled if another device edited after', async () => {
  const op = createOp({ title: 'Superseded delete' });
  await asha.push([op]);
  await ravi.push([updateOp(op.record_id, { notes: 'edited' }, 1)]);
  const ra = (await asha.push([deleteOp(op.record_id, 1)])).body.results[0];
  assert.equal(ra.status, 'superseded');
  assert.equal(ra.record.is_deleted, false);
});

test('invalid data is rejected with a reason', async () => {
  const bad = [
    createOp({ title: 'x', status: 'Done' }),
    createOp({ title: 'x', geo: { lat: 200, lng: 0 } }),
    createOp({ title: 'x', due_date: '31-12-2026' }),
    createOp({ title: 'x', custom: { ward: 'Ward 99' } }),
    createOp({ title: 'x', custom: { nope: 1 } }),
  ];
  const { results } = (await asha.push(bad)).body;
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
  assert.match(results[0].reason, /status/);
});

test('batches over 100 operations are refused', async () => {
  const ops = Array.from({ length: 101 }, () => createOp({ title: 'bulk' }));
  assert.equal((await asha.push(ops)).status, 413);
});

test('fault "after": change applied, reply dropped, retry is recognised as a duplicate', async () => {
  srv.fault.rate = 0.99; srv.fault.mode = 'after';
  const op = createOp({ title: 'Lost reply' });
  const first = await asha.push([op]);
  srv.fault.rate = 0;
  assert.equal(first.status, 503);
  const retry = (await asha.push([op])).body.results[0];
  assert.equal(retry.duplicate, true);
  assert.equal(retry.record.title, 'Lost reply');
});

test('back-and-forth edits of the same notes: one open conflict, stale choices refused', async () => {
  const op = createOp({ title: 'Ping-pong notes', notes: 'v0' });
  await ravi.push([op]);
  await ravi.push([updateOp(op.record_id, { notes: 'laptop 1' }, 1)]);
  const r1 = (await asha.push([updateOp(op.record_id, { notes: 'phone 1' }, 1)])).body.results[0];
  assert.equal(r1.status, 'conflict');
  await ravi.push([updateOp(op.record_id, { notes: 'laptop 2' }, 2)]);
  const r2 = (await asha.push([updateOp(op.record_id, { notes: 'phone 2' }, 1)])).body.results[0];
  assert.deepEqual(r2.resolved_conflicts, [r1.conflict_id]);
  let open = (await asha.get('/api/conflicts')).body.conflicts.filter((c) => c.record_id === op.record_id);
  assert.equal(open.length, 1);
  assert.equal(open[0].current_value.notes, 'laptop 2');
  await ravi.push([updateOp(op.record_id, { notes: 'laptop 3' }, 3)]);
  assert.equal((await asha.post(`/api/conflicts/${open[0].id}/resolve`, { choice: 'mine', seen_version: open[0].record_version })).status, 409);
  open = (await asha.get('/api/conflicts')).body.conflicts.filter((c) => c.record_id === op.record_id);
  const ok = await asha.post(`/api/conflicts/${open[0].id}/resolve`, { choice: 'mine', seen_version: open[0].record_version });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.record.notes, 'phone 2');
});

test('CORS: the Android app (another origin) may call the API', async () => {
  const pre = await fetch(`${srv.base}/api/sync/push`, { method: 'OPTIONS', headers: { origin: 'http://localhost', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-methods'), /PUT/);
});
