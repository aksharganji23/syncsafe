// Local store on the device: everything is held in memory while the app runs and saved,
// encrypted, to IndexedDB. Writes go through store.mutate(), which runs one change at a
// time and saves every changed item in ONE IndexedDB transaction (all or nothing).
// Encryption happens before that transaction opens, because IndexedDB transactions close
// themselves if code waits on anything else (such as Web Crypto) in the middle.
import { deriveKey, encryptJSON, decryptJSON, encryptBytes, decryptBytes, randomBytes } from './secure.js';

const DB_NAME = 'syncsafe-v2';
const DB_VERSION = 1;
const STORES = ['kv', 'secure', 'records', 'outbox', 'filemeta', 'blobs'];
const CHECK = 'syncsafe-check-v1';

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

function openIDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });           // plain: device id, server, account name
      if (!db.objectStoreNames.contains('secure')) db.createObjectStore('secure', { keyPath: 'key' });   // encrypted settings and session
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq' });
      if (!db.objectStoreNames.contains('filemeta')) db.createObjectStore('filemeta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class LocalStore extends EventTarget {
  constructor() {
    super();
    this.idb = null;
    this.key = null;
    this.kv = {};                 // plain settings
    this.secure = {};             // decrypted secure settings (session, cursor, ...)
    this.records = new Map();
    this.outbox = new Map();      // seq -> op
    this.files = new Map();       // attachment id -> meta
    this.nextSeq = 1;
    this.queue = Promise.resolve();
  }

  async init() {
    this.idb = await openIDB();
    const rows = await this.#all('kv');
    this.kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  get unlocked() { return !!this.key; }
  get account() { return this.kv.account || null; }

  async setKV(key, value) {
    this.kv[key] = value;
    const t = this.idb.transaction('kv', 'readwrite');
    if (value === undefined || value === null) t.objectStore('kv').delete(key); else t.objectStore('kv').put({ key, value });
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }

  /** Unlock with the password. Returns false if the password does not match. */
  async unlock(password) {
    const acct = this.account;
    if (!acct) return false;
    const key = await deriveKey(password, new Uint8Array(acct.salt));
    try {
      const ok = await decryptJSON(key, { iv: new Uint8Array(acct.check.iv), data: new Uint8Array(acct.check.data) });
      if (ok !== CHECK) return false;
    } catch {
      return false;
    }
    this.key = key;
    await this.#loadAll();
    return true;
  }

  /** Start a new local account on this device (erases any previous local data). */
  async createAccount({ email, name, userId, password }) {
    await this.wipe();
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt);
    const check = await encryptJSON(key, CHECK);
    await this.setKV('account', { email, name, userId, salt: [...salt], check: { iv: [...check.iv], data: [...check.data] } });
    this.key = key;
    await this.#loadAll();
  }

  lock() {
    this.key = null;
    this.records.clear(); this.outbox.clear(); this.files.clear(); this.secure = {};
  }

  /** Erase records, outbox, files and the account; keep listed plain settings. */
  async wipe(keepKV = ['deviceId', 'deviceName', 'serverUrl', 'lang', 'simulatedOffline']) {
    const t = this.idb.transaction(STORES, 'readwrite');
    for (const s of STORES) if (s !== 'kv') t.objectStore(s).clear();
    const kvStore = t.objectStore('kv');
    for (const k of Object.keys(this.kv)) if (!keepKV.includes(k)) kvStore.delete(k);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    for (const k of Object.keys(this.kv)) if (!keepKV.includes(k)) delete this.kv[k];
    this.lock();
    this.nextSeq = 1;
  }

  /** Keep the account, drop the data (server was reset, or a full resync). */
  async clearData({ keepSession = true } = {}) {
    await this.mutate((tx) => {
      for (const id of [...this.records.keys()]) tx.deleteRecord(id);
      for (const seq of [...this.outbox.keys()]) tx.deleteOp(seq);
      for (const id of [...this.files.keys()]) tx.deleteFile(id);
      const session = this.secure.session;
      for (const k of Object.keys(this.secure)) tx.setSecure(k, undefined);
      if (keepSession && session) tx.setSecure('session', session);
    });
    const t = this.idb.transaction('blobs', 'readwrite');
    t.objectStore('blobs').clear();
    await new Promise((res) => { t.oncomplete = res; });
  }

  /**
   * Make a change. `fn(tx)` runs against the in-memory data and returns a value.
   * Everything it touched is encrypted and saved in one IndexedDB transaction.
   */
  mutate(fn) {
    const run = this.queue.then(async () => {
      if (!this.key) throw new Error('Locked');
      const dirty = { records: new Map(), outbox: new Map(), files: new Map(), secure: new Map() };
      const tx = {
        record: (id) => this.records.get(id),
        putRecord: (r) => { this.records.set(r.id, r); dirty.records.set(r.id, r); return r; },
        deleteRecord: (id) => { this.records.delete(id); dirty.records.set(id, null); },
        opsFor: (recordId) => [...this.outbox.values()].filter((o) => o.record_id === recordId).sort((a, b) => a.seq - b.seq),
        putOp: (op) => {
          if (!op.seq) op.seq = this.nextSeq++;
          this.outbox.set(op.seq, op); dirty.outbox.set(op.seq, op); return op;
        },
        deleteOp: (seq) => { this.outbox.delete(seq); dirty.outbox.set(seq, null); },
        file: (id) => this.files.get(id),
        putFile: (m) => { this.files.set(m.id, m); dirty.files.set(m.id, m); return m; },
        deleteFile: (id) => { this.files.delete(id); dirty.files.set(id, null); },
        setSecure: (k, v) => { if (v === undefined) delete this.secure[k]; else this.secure[k] = v; dirty.secure.set(k, v); },
      };
      const result = await fn(tx);
      if (dirty.outbox.size) dirty.secure.set('nextSeq', this.nextSeq);
      await this.#persist(dirty);
      this.dispatchEvent(new CustomEvent('change'));
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async putBlob(id, bytes) {
    const box = await encryptBytes(this.key, bytes);
    const t = this.idb.transaction('blobs', 'readwrite');
    t.objectStore('blobs').put({ id, iv: box.iv, data: box.data });
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }

  async getBlob(id) {
    const t = this.idb.transaction('blobs', 'readonly');
    const row = await req(t.objectStore('blobs').get(id));
    if (!row) return null;
    return decryptBytes(this.key, row);
  }

  async deleteBlob(id) {
    const t = this.idb.transaction('blobs', 'readwrite');
    t.objectStore('blobs').delete(id);
    await new Promise((res) => { t.oncomplete = res; });
  }

  get pendingCount() { return this.outbox.size; }

  // ----- internals -----
  async #all(store) {
    const t = this.idb.transaction(store, 'readonly');
    return req(t.objectStore(store).getAll());
  }

  async #loadAll() {
    const [recs, ops, files, sec] = await Promise.all(['records', 'outbox', 'filemeta', 'secure'].map((s) => this.#all(s)));
    const open = (row) => decryptJSON(this.key, row);
    this.records = new Map((await Promise.all(recs.map(open))).map((r) => [r.id, r]));
    this.outbox = new Map((await Promise.all(ops.map(open))).map((o) => [o.seq, o]));
    this.files = new Map((await Promise.all(files.map(open))).map((f) => [f.id, f]));
    this.secure = {};
    for (const row of sec) this.secure[row.key] = await decryptJSON(this.key, row);
    this.nextSeq = Math.max(this.secure.nextSeq || 1, ...[...this.outbox.keys()].map((s) => s + 1), 1);
  }

  async #persist(dirty) {
    const seal = async (map, keyName, extra = () => ({})) => Promise.all([...map].map(async ([k, v]) => (
      v === null || v === undefined ? { del: k } : { put: { [keyName]: k, ...extra(v), ...(await encryptJSON(this.key, v)) } }
    )));
    const [records, outbox, files, secure] = await Promise.all([
      seal(dirty.records, 'id'),
      seal(dirty.outbox, 'seq'),
      seal(dirty.files, 'id'),
      seal(dirty.secure, 'key'),
    ]);
    const t = this.idb.transaction(['records', 'outbox', 'filemeta', 'secure'], 'readwrite');
    const apply = (store, items) => { for (const i of items) if (i.del !== undefined) t.objectStore(store).delete(i.del); else t.objectStore(store).put(i.put); };
    apply('records', records);
    apply('outbox', outbox);
    apply('filemeta', files);
    apply('secure', secure);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  }
}
