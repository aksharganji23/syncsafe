// Durability simulation: several virtual devices make random offline edits while
// the server randomly drops requests and replies. At the end every device must
// match the server exactly, and no operation may have been applied twice.
// The device logic mirrors public/js/repository.js and public/js/sync-engine.js.
import { coalesce, uuid } from '../public/js/core.js';
import { startServer, loginFull } from './helpers.js';

const STATUSES = ['Pending', 'Visited', 'Follow-up', 'Closed'];
const PRIORITIES = ['Low', 'Medium', 'High'];
const FIELDS = ['title', 'location', 'status', 'priority', 'notes'];

class SimDevice {
  constructor(base, session, name, rand) {
    this.base = base; this.token = session.access_token; this.name = name; this.rand = rand;
    this.id = session.deviceId; this.records = new Map(); this.outbox = []; this.seq = 0;
    this.cursor = 0; this.online = true; this.created = new Set(); this.dropped = new Set();
  }

  headers() {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, 'x-device-id': this.id };
  }

  enqueue(op) {
    const pending = this.outbox.filter((o) => o.record_id === op.record_id);
    const plan = coalesce(pending, op);
    this.outbox = this.outbox.filter((o) => !plan.remove.includes(o.seq));
    for (const item of plan.put) {
      if (item.seq) this.outbox = this.outbox.map((o) => (o.seq === item.seq ? item : o));
      else this.outbox.push({ ...item, seq: ++this.seq });
    }
    return plan;
  }

  create() {
    const id = uuid();
    const fields = { title: `Rec ${id.slice(0, 6)}`, status: 'Pending', priority: 'Medium', location: '', notes: '' };
    this.records.set(id, { id, ...fields, version: 0 });
    this.created.add(id);
    this.enqueue({ op_id: uuid(), record_id: id, type: 'create', fields, base_version: 0, attempts: 0 });
  }

  update() {
    const list = [...this.records.values()];
    if (!list.length) return;
    const r = list[Math.floor(this.rand() * list.length)];
    const field = FIELDS[Math.floor(this.rand() * FIELDS.length)];
    const value = field === 'status' ? STATUSES[Math.floor(this.rand() * 4)]
      : field === 'priority' ? PRIORITIES[Math.floor(this.rand() * 3)]
      : `${field} by ${this.name} #${Math.floor(this.rand() * 1000)}`;
    if (r[field] === value) return;
    this.records.set(r.id, { ...r, [field]: value });
    const pendingCreate = this.outbox.some((o) => o.record_id === r.id && o.type === 'create');
    const isNew = r.version === 0 && !pendingCreate;
    this.enqueue({ op_id: uuid(), record_id: r.id, type: isNew ? 'create' : 'update',
      fields: isNew ? { title: r.title, [field]: value } : { [field]: value }, base_version: r.version, attempts: 0 });
  }

  remove() {
    const list = [...this.records.values()];
    if (!list.length) return;
    const r = list[Math.floor(this.rand() * list.length)];
    const plan = this.enqueue({ op_id: uuid(), record_id: r.id, type: 'delete', fields: {}, base_version: r.version, attempts: 0 });
    this.records.delete(r.id);
    if (plan.dropRecord) this.dropped.add(r.id);
  }

  async sync() {
    if (!this.online) return { ok: false };
    try {
      // push
      for (;;) {
        const batch = this.outbox.slice(0, 100);
        if (!batch.length) break;
        batch.forEach((o) => { o.attempts = (o.attempts || 0) + 1; });
        const res = await fetch(`${this.base}/api/sync/push`, {
          method: 'POST', headers: this.headers(),
          body: JSON.stringify({ ops: batch.map(({ op_id, record_id, type, fields, base_version }) => ({ op_id, record_id, type, fields, base_version })) }),
        });
        if (res.status >= 500) throw new Error('fault');
        const { results } = await res.json();
        for (const op of batch) {
          const r = results.find((x) => x.op_id === op.op_id);
          if (!r) continue;
          this.outbox = this.outbox.filter((o) => o.seq !== op.seq);
          const stillPending = this.outbox.some((o) => o.record_id === op.record_id);
          const server = r.record;
          if (stillPending) {
            const local = this.records.get(op.record_id);
            if (local && server) local.version = server.version;
          } else if (!server || server.is_deleted) this.records.delete(op.record_id);
          else this.records.set(server.id, { ...server });
        }
      }
      // pull
      for (;;) {
        const res = await fetch(`${this.base}/api/sync/pull?cursor=${this.cursor}&limit=50`, { headers: this.headers() });
        if (res.status >= 500) throw new Error('fault');
        const page = await res.json();
        for (const c of page.changes) {
          if (this.outbox.some((o) => o.record_id === c.id)) continue;
          if (c.is_deleted) this.records.delete(c.id);
          else this.records.set(c.id, { ...c });
        }
        this.cursor = page.cursor;
        if (!page.hasMore) break;
      }
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
}

// Small seeded random generator so a failing run can be replayed.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function runDurability({ cycles = 200, devices = 4, faultRate = 0.3, seed = 42 } = {}) {
  const rand = mulberry32(seed);
  const srv = await startServer();
  try {
    const accounts = ['asha@syncsafe.test', 'ravi@syncsafe.test'];
    const fleet = [];
    for (let i = 0; i < devices; i++) {
      fleet.push(new SimDevice(srv.base, await loginFull(srv.base, accounts[i % 2]), `dev${i}`, rand));
    }
    for (const d of fleet) await d.sync(); // start from the sample data

    let failedSyncs = 0;
    for (let c = 0; c < cycles; c++) {
      srv.fault.rate = faultRate;
      srv.fault.mode = rand() < 0.5 ? 'before' : 'after';
      const d = fleet[Math.floor(rand() * fleet.length)];
      const roll = rand();
      if (roll < 0.25) d.create();
      else if (roll < 0.6) d.update();
      else if (roll < 0.68) d.remove();
      else if (roll < 0.78) d.online = !d.online;
      else if (!(await d.sync()).ok) failedSyncs++;
    }

    // Recovery: network healthy, everyone online, sync until quiet.
    srv.fault.rate = 0;
    fleet.forEach((d) => { d.online = true; });
    for (let round = 0; round < 3; round++) for (const d of fleet) await d.sync();

    const ws = (await srv.db.one(`SELECT workspace_id FROM users WHERE email = 'asha@syncsafe.test'`)).workspace_id;
    const server = new Map(
      (await srv.db.query('SELECT * FROM records WHERE NOT is_deleted AND workspace_id = $1', [ws])).map((r) => [r.id, r]),
    );
    const allServerIds = new Set((await srv.db.query('SELECT id FROM records')).map((r) => r.id));
    const problems = [];

    for (const d of fleet) {
      if (d.outbox.length) problems.push(`${d.name}: ${d.outbox.length} operations still unsent`);
      if (d.records.size !== server.size) problems.push(`${d.name}: has ${d.records.size} records, server has ${server.size}`);
      for (const [id, s] of server) {
        const l = d.records.get(id);
        if (!l) { problems.push(`${d.name}: missing record ${id}`); continue; }
        for (const f of FIELDS) if (l[f] !== s[f]) problems.push(`${d.name}: ${id} field ${f} differs`);
      }
      for (const id of d.created) {
        if (!d.dropped.has(id) && !allServerIds.has(id)) problems.push(`${d.name}: created record ${id} never reached the server`);
      }
    }
    const doubled = (await srv.db.one(
      'SELECT COUNT(*)::int AS n FROM (SELECT op_id FROM change_log WHERE op_id IS NOT NULL GROUP BY op_id HAVING COUNT(*) > 1) x',
    )).n;
    if (doubled) problems.push(`${doubled} operations were applied more than once`);

    const stats = await srv.db.one(
      `SELECT count(*) FILTER (WHERE direction = 'fault')::int AS faults, coalesce(sum(duplicates),0)::int AS duplicates,
              coalesce(sum(conflicts),0)::int AS conflicts FROM sync_events`,
    );
    return {
      cycles, devices, faultRate, seed, failedSyncs,
      serverRecords: server.size,
      injectedFaults: stats.faults || 0,
      duplicatesIgnored: stats.duplicates || 0,
      conflictsRaised: stats.conflicts || 0,
      problems,
    };
  } finally {
    await srv.close();
  }
}
