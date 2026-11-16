// Data layer: PostgreSQL everywhere.
//  - Laptop / tests: PGlite, a real PostgreSQL compiled to WebAssembly. Nothing to install;
//    data lives in a folder (data/pgdata), or in memory for tests.
//  - Production / several servers: set DATABASE_URL and the same SQL runs on a real
//    PostgreSQL server through the `pg` driver. Servers then share one database and
//    use LISTEN/NOTIFY to tell each other about changes (see bus.js).
import { SCHEMA } from './schema.js';

function wrapPglite(pg) {
  const q = async (runner, sql, params = []) => (await runner.query(sql, params)).rows;
  const api = (runner) => ({
    query: (sql, params) => q(runner, sql, params),
    one: async (sql, params) => (await q(runner, sql, params))[0] ?? null,
  });
  return {
    kind: 'pglite',
    ...api(pg),
    // One transaction at a time (PGlite has a single connection and queues them).
    tx: (fn) => pg.transaction(async (t) => fn(api(t))),
    exec: (sql) => pg.exec(sql),
    listen: (channel, cb) => pg.listen(channel, cb),
    notify: (channel, payload) => pg.query('SELECT pg_notify($1, $2)', [channel, payload]),
    close: () => pg.close(),
  };
}

function wrapPgPool(pool) {
  const api = (runner) => ({
    query: async (sql, params = []) => (await runner.query(sql, params)).rows,
    one: async (sql, params = []) => (await runner.query(sql, params)).rows[0] ?? null,
  });
  let listener = null;
  return {
    kind: 'postgres',
    ...api(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(api(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    exec: (sql) => pool.query(sql),
    async listen(channel, cb) {
      if (!listener) {
        listener = await pool.connect();
        listener.on('notification', (msg) => listener._handlers?.[msg.channel]?.(msg.payload));
        listener._handlers = {};
      }
      listener._handlers[channel] = cb;
      await listener.query(`LISTEN ${channel}`);
    },
    notify: (channel, payload) => pool.query('SELECT pg_notify($1, $2)', [channel, payload]),
    async close() {
      if (listener) listener.release();
      await pool.end();
    },
  };
}

/**
 * @param {object} o
 * @param {string|null} o.url   postgres:// URL (DATABASE_URL); if absent, embedded PGlite
 * @param {string|null} o.dir   folder for PGlite data; null = in memory (tests)
 */
export async function openDatabase({ url = null, dir = null } = {}) {
  let db;
  if (url) {
    const { default: pg } = await import('pg');
    pg.types.setTypeParser(1082, (v) => v); // DATE stays 'YYYY-MM-DD' (no time-zone shift)
    pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT sequences fit safely in a JS number
    const ssl = /sslmode=require|render\.com|neon\.tech|supabase/.test(url) ? { rejectUnauthorized: false } : undefined;
    db = wrapPgPool(new pg.Pool({ connectionString: url, max: 10, ssl }));
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    if (dir) (await import('node:fs')).mkdirSync(dir, { recursive: true });
    const options = { parsers: { 1082: (v) => v, 20: (v) => Number(v) } }; // DATE as text, BIGINT as number
    db = wrapPglite(dir ? new PGlite(dir, options) : new PGlite(options));
  }
  await db.exec(SCHEMA);
  return db;
}

export const isUniqueViolation = (err) => err && (err.code === '23505' || /duplicate key/i.test(err.message || ''));
