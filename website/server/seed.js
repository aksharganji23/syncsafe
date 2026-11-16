// Sample teams, people and records so the app is ready to test the moment it starts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';
import { CORE_FIELDS, DEFAULT_RULES } from './conflict.js';
import { publicRecord } from './sync-service.js';
import { loadDoc, encode } from '../public/js/textcrdt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECORDS_FILE = path.join(here, '..', 'sample-data', 'seed-records.json');

export const SAMPLE_TEAMS = [
  {
    name: 'Demo Team',
    invite: 'DEMO-2026',
    users: [
      { key: 'admin', name: 'Admin User', email: 'admin@syncsafe.test', password: 'Admin@123', role: 'admin' },
      { key: 'meera', name: 'Meera (Supervisor)', email: 'meera@syncsafe.test', password: 'Test@123', role: 'supervisor' },
      { key: 'asha', name: 'Asha (Field Worker)', email: 'asha@syncsafe.test', password: 'Test@123', role: 'field' },
      { key: 'ravi', name: 'Ravi (Field Worker)', email: 'ravi@syncsafe.test', password: 'Test@123', role: 'field' },
      { key: 'guest', name: 'Guest (Viewer)', email: 'guest@syncsafe.test', password: 'Test@123', role: 'viewer' },
    ],
    customFields: [
      { key: 'households', label: 'Households affected', type: 'number', required: false, options: [] },
      { key: 'ward', label: 'Ward', type: 'select', required: false, options: ['Ward 1', 'Ward 2', 'Ward 3', 'Ward 4', 'Ward 5'] },
      { key: 'followup_call', label: 'Follow-up call needed', type: 'checkbox', required: false, options: [] },
    ],
  },
  {
    name: 'River Valley Clinic',
    invite: 'RIVER-2026',
    users: [
      { key: 'nurse', name: 'Nurse Priya', email: 'nurse@rivervalley.test', password: 'Test@123', role: 'admin' },
    ],
    customFields: [],
    records: [
      { title: 'Vaccine fridge temperature log', location: 'River Valley Clinic', status: 'Visited', priority: 'High', notes: 'Fridge at 4 °C, within range.' },
      { title: 'Patient transport request', location: 'Holden Rd', status: 'Pending', priority: 'Medium', notes: '' },
      { title: 'First-aid kit restock', location: 'Mobile van 2', status: 'Follow-up', priority: 'Low', notes: 'Bandages and gloves low.' },
    ],
  },
];

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

export async function seedIfEmpty(db) {
  const existing = await db.one('SELECT id FROM users LIMIT 1');
  if (existing) return false;
  const demoRecords = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
  await db.tx(async (t) => {
    for (const team of SAMPLE_TEAMS) {
      const settings = { rules: { ...DEFAULT_RULES }, customFields: team.customFields, retentionDays: 30 };
      const { id: ws } = await t.one('INSERT INTO workspaces (name, invite_code, settings) VALUES ($1, $2, $3) RETURNING id', [team.name, team.invite, settings]);
      const ids = {};
      for (const u of team.users) {
        const row = await t.one('INSERT INTO users (email, name, password_hash, role, workspace_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [u.email, u.name, hashPassword(u.password), u.role, ws]);
        ids[u.key] = row.id;
      }
      const records = team.records || demoRecords;
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        const id = crypto.randomUUID();
        const t0 = new Date(Date.now() - (records.length - i) * 3600_000);
        const meta = Object.fromEntries(CORE_FIELDS.map((f) => [f, { v: 1, d: 'seed' }]));
        for (const k of Object.keys(r.custom || {})) meta[`custom.${k}`] = { v: 1, d: 'seed' };
        const state = Buffer.from(encode(loadDoc(null, r.notes || '')));
        await t.query(
          `INSERT INTO records (id, workspace_id, title, location, status, priority, notes, notes_state, lat, lng, accuracy, assigned_to, due_date,
             custom, version, field_meta, created_by, updated_by_device, updated_by_name, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,'seed','Sample data',$17,$17)`,
          [id, ws, r.title, r.location, r.status, r.priority, r.notes || '', state, r.geo?.lat ?? null, r.geo?.lng ?? null, r.geo?.accuracy ?? null,
            r.assigned ? ids[r.assigned] : null, r.assigned ? day(r.due_in_days) : null, r.custom || {}, meta, ids[team.users[0].key], t0],
        );
        const { seq } = await t.one(`INSERT INTO change_log (record_id, workspace_id, version, kind, device_id, changed_at) VALUES ($1,$2,1,'create','seed',$3) RETURNING seq`, [id, ws, t0]);
        await t.query('UPDATE records SET last_seq = $1 WHERE id = $2', [seq, id]);
        const row = await t.one('SELECT * FROM records WHERE id = $1', [id]);
        const snap = publicRecord(row);
        delete snap.notes_state; delete snap.attachments;
        await t.query(`INSERT INTO record_versions (record_id, version, snapshot, changed_fields, kind, user_name, device_id, created_at)
                       VALUES ($1, 1, $2, '[]', 'create', 'Sample data', 'seed', $3)`, [id, snap, t0]);
      }
    }
  });
  return true;
}
