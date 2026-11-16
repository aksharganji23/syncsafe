// Test helpers: a throwaway server on a random port with an in-memory PostgreSQL (PGlite).
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../server/app.js';
import { seedIfEmpty } from '../server/seed.js';
import { attachLive } from '../server/live.js';

export const newId = () => crypto.randomUUID();

/**
 * Without TEST_DATABASE_URL every test server gets a fresh in-memory PGlite.
 * With TEST_DATABASE_URL=postgres://user:pw@host:port/postgres each test server gets
 * its own new database on that real PostgreSQL server (dropped again on close).
 */
async function freshDatabaseUrl() {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) return { url: null, drop: async () => {} };
  const { default: pg } = await import('pg');
  const name = `syncsafe_test_${crypto.randomBytes(5).toString('hex')}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect(); await c.query(`CREATE DATABASE ${name}`); await c.end();
  const url = new URL(admin); url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => { const d = new pg.Client({ connectionString: admin }); await d.connect(); await d.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await d.end(); },
  };
}

export async function startServer() {
  const fresh = await freshDatabaseUrl();
  const ctx = await createApp({ dbDir: null, dataDir: null, databaseUrl: fresh.url });
  await seedIfEmpty(ctx.db);
  const server = http.createServer(ctx.app);
  const live = attachLive(server, { db: ctx.db, bus: ctx.bus, secret: ctx.secret, metrics: ctx.metrics });
  ctx.setLive(live);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, db: ctx.db, fault: ctx.fault, secret: ctx.secret,
    close: async () => { live.close(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await ctx.db.close(); await fresh.drop(); },
  };
}

export async function loginFull(base, email = 'asha@syncsafe.test', password = 'Test@123', deviceId = newId()) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': deviceId }, body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  return { ...body, deviceId, status: res.status };
}

export async function login(base, email, password) {
  return (await loginFull(base, email, password)).access_token;
}

/** A device: logs in once and talks to the API with its own device id. */
export async function device(base, email = 'asha@syncsafe.test', password = 'Test@123') {
  const s = await loginFull(base, email, password);
  return client(base, s.access_token, s.deviceId, s);
}

export function client(base, token, deviceId = newId(), session = {}) {
  const headers = () => ({ 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': deviceId });
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return {
    deviceId, token, session, user: session.user,
    push: (ops) => call('POST', '/api/sync/push', { ops }),
    pull: (cursor = 0, limit = 500) => call('GET', `/api/sync/pull?cursor=${cursor}&limit=${limit}`),
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    del: (p) => call('DELETE', p),
    async putChunk(id, offset, buf) {
      const res = await fetch(`${base}/api/attachments/${id}/chunk?offset=${offset}`, {
        method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-device-id': deviceId, 'content-type': 'application/octet-stream' }, body: buf,
      });
      return { status: res.status, body: await res.json() };
    },
  };
}

export const createOp = (fields, recordId = newId()) => ({ op_id: newId(), record_id: recordId, type: 'create', fields, base_version: 0 });
export const updateOp = (recordId, fields, baseVersion, extra = {}) => ({ op_id: newId(), record_id: recordId, type: 'update', fields, base_version: baseVersion, ...extra });
export const deleteOp = (recordId, baseVersion) => ({ op_id: newId(), record_id: recordId, type: 'delete', fields: {}, base_version: baseVersion });
