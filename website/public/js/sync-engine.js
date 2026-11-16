// Sync engine: push the outbox, pull changes since the last cursor, upload/download
// photos, and listen on a WebSocket so changes from other devices arrive within a second.
// Observer pattern: the UI listens for 'status', 'changed', 'notice', 'notifications', 'team'.
import { backoffDelay, reconnectJitter } from './core.js';
import { NetworkError, AuthError } from './api.js';

const BATCH = 100;
const PULL_LIMIT = 500;
const POLL_MS = 30000;
const CHUNK = 256 * 1024;

export class SyncEngine extends EventTarget {
  constructor(api, store) {
    super();
    this.api = api;
    this.store = store;
    this.running = false;
    this.again = false;
    this.failures = 0;
    this.timers = {};
    this.ws = null;
    this.wsRetry = 0;
    this.status = { state: 'idle', pending: 0, conflicts: 0, uploads: 0, lastSyncAt: null, message: '', live: false };
    this.notifications = { items: [], unread: 0 };
  }

  start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener('online', () => this.reconnected());
    window.addEventListener('offline', () => { this.closeLive(); this.refreshStatus(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.sync('app focused'); });
    this.timers.poll = setInterval(() => this.sync('poll'), POLL_MS);
  }

  stop() {
    this.started = false;
    for (const t of Object.values(this.timers)) { clearInterval(t); clearTimeout(t); }
    this.timers = {};
    this.closeLive();
  }

  /** Network came back: wait a random 0–3 s first so many devices don't all arrive at once. */
  reconnected() {
    clearTimeout(this.timers.jitter);
    this.timers.jitter = setTimeout(() => { this.sync('back online'); this.openLive(); }, reconnectJitter());
  }

  soon(delay = 800) {
    this.refreshStatus();
    clearTimeout(this.timers.debounce);
    this.timers.debounce = setTimeout(() => this.sync('local change'), delay);
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  refreshStatus(patch = {}) {
    const recs = [...this.store.records.values()];
    this.status = {
      ...this.status,
      ...patch,
      pending: this.store.outbox.size,
      uploads: [...this.store.files.values()].filter((f) => f.status === 'pending' || f.status === 'uploading').length,
      conflicts: recs.filter((r) => r.sync_state === 'conflict').length,
    };
    if (!this.api.online && this.status.state !== 'auth') this.status.state = 'offline';
    else if (this.status.state === 'offline') this.status.state = 'idle';
    this.emit('status', this.status);
  }

  async sync(reason = 'manual') {
    if (!this.store.unlocked || !this.api.refreshToken) return;
    if (this.running) { this.again = true; return; }
    if (!this.api.online) { this.refreshStatus({ state: 'offline' }); return; }
    this.running = true;
    clearTimeout(this.timers.retry);
    this.refreshStatus({ state: 'syncing', message: reason });
    try {
      await this.checkServerInstance();
      const pushed = await this.push();
      const pulled = await this.pull();
      const files = await this.syncFiles();
      const reconciled = await this.reconcileConflicts();
      this.failures = 0;
      this.refreshStatus({ state: 'idle', lastSyncAt: new Date().toISOString(), message: '' });
      if (pushed || pulled || files || reconciled) this.emit('changed');
      this.loadNotifications().catch(() => {});
      if (!this.ws) this.openLive();
    } catch (err) {
      await this.unmarkInflight().catch(() => {});
      if (err instanceof AuthError) {
        this.refreshStatus({ state: 'auth', message: err.message });
      } else {
        this.failures++;
        const delay = backoffDelay(this.failures);
        this.timers.retry = setTimeout(() => this.sync('retry'), delay);
        this.refreshStatus({ state: this.api.online ? 'error' : 'offline', message: `${err.message}. Retrying in ${Math.round(delay / 1000)}s` });
      }
    } finally {
      this.running = false;
      if (this.again) { this.again = false; setTimeout(() => this.sync('queued'), 50); }
    }
  }

  async checkServerInstance() {
    const health = await this.api.get('/api/health', { timeout: 6000, auth: false });
    if (!health?.instanceId) throw new NetworkError('The server address does not point to a SyncSafe server');
    const known = this.store.secure.instanceId;
    if (known && known !== health.instanceId) {
      await this.store.clearData({ keepSession: false });
      this.api.refreshToken = null;
      this.api.accessToken = null;
      this.emit('notice', { kind: 'warn', key: 'notice.server_reset' });
      this.emit('server-reset');
      throw new AuthError('Server was reset', 'server_reset');
    }
    if (known !== health.instanceId) await this.store.mutate((tx) => tx.setSecure('instanceId', health.instanceId));
  }

  async unmarkInflight() {
    const inflight = [...this.store.outbox.values()].filter((o) => o.inflight);
    if (!inflight.length) return;
    await this.store.mutate((tx) => { for (const o of inflight) tx.putOp({ ...o, inflight: false }); });
  }

  async push() {
    let total = 0;
    for (;;) {
      const batch = await this.store.mutate((tx) => {
        const ops = [...this.store.outbox.values()].sort((a, b) => a.seq - b.seq).slice(0, BATCH);
        for (const op of ops) tx.putOp({ ...op, inflight: true, attempts: (op.attempts || 0) + 1 });
        return ops;
      });
      if (!batch.length) return total;
      const { results } = await this.api.post('/api/sync/push', {
        ops: batch.map(({ op_id, record_id, type, fields, base_version, notes_state }) => ({ op_id, record_id, type, fields, base_version, notes_state })),
      });
      await this.applyPushResults(batch, results);
      total += batch.length;
    }
  }

  async applyPushResults(batch, results) {
    const notices = [];
    await this.store.mutate((tx) => {
      for (const op of batch) {
        const res = results.find((r) => r.op_id === op.op_id);
        if (!res) continue;
        tx.deleteOp(op.seq);
        const stillPending = tx.opsFor(op.record_id).length > 0;
        const local = tx.record(op.record_id);
        const server = res.record;

        if (res.status === 'rejected') {
          const keep = server && !server.is_deleted ? server : local;
          if (keep) tx.putRecord({ ...keep, sync_state: 'rejected', error: res.reason });
          notices.push({ kind: 'error', key: 'notice.rejected', vars: { title: local?.title || '', reason: res.reason } });
          continue;
        }
        if (res.status === 'conflict') {
          tx.putRecord({ ...server, sync_state: 'conflict', conflict_id: res.conflict_id });
          notices.push({ kind: 'warn', key: 'notice.conflict', vars: { title: server.title, fields: res.fields.join(', ') } });
          continue;
        }
        if (res.status === 'superseded') notices.push({ kind: 'info', key: 'notice.superseded', vars: { title: server.title } });
        if (res.status === 'restored') notices.push({ kind: 'info', key: 'notice.restored', vars: { title: server.title } });
        if (res.merged_notes) notices.push({ kind: 'ok', key: 'notice.merged_notes', vars: { title: server.title } });

        if (stillPending) {
          if (local && server) tx.putRecord({ ...local, version: server.version });
        } else if (!server || server.is_deleted) {
          tx.deleteRecord(op.record_id);
        } else {
          const closed = (res.resolved_conflicts || []).includes(local?.conflict_id);
          const keepConflict = local?.sync_state === 'conflict' && !closed;
          tx.putRecord({ ...server, sync_state: keepConflict ? 'conflict' : 'synced', conflict_id: keepConflict ? local.conflict_id : undefined });
        }
      }
    });
    for (const n of notices) this.emit('notice', n);
  }

  async pull() {
    let received = 0;
    let fullResync = false;
    const seen = new Set();
    for (;;) {
      const cursor = this.store.secure.cursor || 0;
      const page = await this.api.get(`/api/sync/pull?cursor=${cursor}&limit=${PULL_LIMIT}`);
      if (page.resync) {
        // Old deletions were cleaned up on the server since we last synced: start over.
        await this.store.mutate((tx) => tx.setSecure('cursor', 0));
        fullResync = true;
        continue;
      }
      if (cursor === 0) fullResync = true;
      const evicted = [];
      await this.store.mutate((tx) => {
        for (const change of page.changes) {
          seen.add(change.id);
          if (tx.opsFor(change.id).length > 0) continue; // our own unsent edit wins locally until it is pushed
          if (change.is_deleted || change.evicted) {
            if (tx.record(change.id)) evicted.push(change.id);
            tx.deleteRecord(change.id);
            continue;
          }
          const local = tx.record(change.id);
          const keepConflict = local?.sync_state === 'conflict';
          tx.putRecord({ ...change, sync_state: keepConflict ? 'conflict' : 'synced', conflict_id: keepConflict ? local.conflict_id : undefined });
        }
        tx.setSecure('cursor', page.cursor);
        if (page.scope) tx.setSecure('scope', page.scope);
      });
      await this.dropFilesOf(evicted);
      received += page.changes.length;
      if (!page.hasMore) break;
    }
    if (fullResync) {
      // Anything we still hold that the server no longer has (and that we have not edited) goes.
      const pendingIds = new Set([...this.store.outbox.values()].map((o) => o.record_id));
      const gone = [...this.store.records.keys()].filter((id) => !seen.has(id) && !pendingIds.has(id));
      if (gone.length) {
        await this.store.mutate((tx) => { for (const id of gone) tx.deleteRecord(id); });
        await this.dropFilesOf(gone);
        received += gone.length;
      }
    }
    return received;
  }

  async dropFilesOf(recordIds) {
    if (!recordIds.length) return;
    const drop = [...this.store.files.values()].filter((f) => recordIds.includes(f.record_id) && f.status !== 'pending');
    if (!drop.length) return;
    await this.store.mutate((tx) => { for (const f of drop) tx.deleteFile(f.id); });
    for (const f of drop) await this.store.deleteBlob(f.id);
  }

  /** Upload pending photos (resuming where a dropped connection stopped) and send deletions. */
  async syncFiles() {
    let done = 0;
    for (const meta of [...this.store.files.values()]) {
      if (meta.status === 'delete') {
        try {
          await this.api.del(`/api/attachments/${meta.id}`);
        } catch (err) {
          if (err.status !== 404) throw err;
        }
        await this.store.mutate((tx) => tx.deleteFile(meta.id));
        done++;
        continue;
      }
      if (meta.status !== 'pending' && meta.status !== 'uploading') continue;
      const rec = this.store.records.get(meta.record_id);
      if (!rec) { await this.store.mutate((tx) => tx.deleteFile(meta.id)); continue; }
      if (!rec.version) continue;                                  // record not on the server yet
      let init;
      try {
        init = await this.api.post(`/api/attachments/${meta.id}/init`, {
          record_id: meta.record_id, name: meta.name, mime: meta.mime, size: meta.size, sha256: meta.sha256,
        });
      } catch (err) {
        if (err.status === 409) continue;                          // try again next sync
        if (err.status >= 400 && err.status < 500) {
          await this.store.mutate((tx) => tx.putFile({ ...meta, status: 'failed', error: err.message }));
          this.emit('notice', { kind: 'error', key: 'notice.upload_failed', vars: { name: meta.name, reason: err.message } });
          continue;
        }
        throw err;
      }
      const bytes = await this.store.getBlob(meta.id);
      if (!bytes) { await this.store.mutate((tx) => tx.deleteFile(meta.id)); continue; }
      let offset = init.received;
      while (offset < meta.size && !init.uploaded) {
        const chunk = bytes.subarray(offset, Math.min(meta.size, offset + CHUNK));
        const res = await this.api.raw('PUT', `/api/attachments/${meta.id}/chunk?offset=${offset}`, {
          body: chunk, headers: { 'content-type': 'application/octet-stream' }, timeout: 60000,
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 || res.status === 422) { offset = data.received ?? 0; continue; }   // resume at the server's position
        if (!res.ok) throw new NetworkError(data.error || `Upload failed (${res.status})`);
        offset = data.received;
        await this.store.mutate((tx) => tx.putFile({ ...meta, status: data.uploaded ? 'uploaded' : 'uploading', offset }));
        this.refreshStatus();
        if (data.uploaded) break;
      }
      await this.store.mutate((tx) => tx.putFile({ ...tx.file(meta.id), status: 'uploaded', offset: meta.size, local: false }));
      done++;
    }
    return done;
  }

  /** Photo bytes for display: from the encrypted cache, else downloaded once and cached. */
  async attachmentBytes(att) {
    const cached = await this.store.getBlob(att.id);
    if (cached) return cached;
    if (!this.api.online) return null;
    const blob = await this.api.blob(`/api/attachments/${att.id}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await this.store.putBlob(att.id, bytes);
    await this.store.mutate((tx) => tx.putFile({ id: att.id, record_id: att.record_id, name: att.name, mime: att.mime, size: att.size, status: 'cached' }));
    return bytes;
  }

  async reconcileConflicts() {
    const marked = [...this.store.records.values()].filter((r) => r.sync_state === 'conflict');
    if (!marked.length) return 0;
    const { conflicts } = await this.api.get('/api/conflicts');
    const open = new Map(conflicts.map((c) => [c.record_id, c.id]));
    let changed = 0;
    await this.store.mutate((tx) => {
      for (const r of marked) {
        const pending = tx.opsFor(r.id).length;
        if (open.has(r.id)) {
          if (open.get(r.id) !== r.conflict_id) { tx.putRecord({ ...r, conflict_id: open.get(r.id) }); changed++; }
        } else {
          tx.putRecord({ ...r, sync_state: pending ? 'pending' : 'synced', conflict_id: undefined });
          changed++;
        }
      }
    });
    return changed;
  }

  async markResolved(record) {
    await this.store.mutate((tx) => tx.putRecord({ ...record, sync_state: 'synced', conflict_id: undefined }));
    this.refreshStatus();
    this.emit('changed');
  }

  async loadNotifications() {
    if (!this.api.online) return;
    const data = await this.api.get('/api/notifications');
    const before = new Set(this.notifications.items.map((n) => n.id));
    const fresh = data.notifications.filter((n) => !n.read && !before.has(n.id));
    this.notifications = { items: data.notifications, unread: data.unread };
    this.emit('notifications', { ...this.notifications, fresh: before.size || this.notifiedOnce ? fresh : [] });
    this.notifiedOnce = true;
  }

  // ----- live updates -----
  openLive() {
    if (this.ws || !this.api.online || !this.api.accessToken || typeof WebSocket === 'undefined') return;
    let ws;
    try { ws = new WebSocket(this.api.wsUrl()); } catch { return; }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.api.accessToken, device_id: this.api.deviceId }));
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'ready') { this.wsRetry = 0; this.refreshStatus({ live: true }); }
      if (msg.type === 'changed') this.soon(300);
      if (msg.type === 'notification') this.loadNotifications().catch(() => {});
      if (msg.type === 'settings') this.emit('team');
      if (msg.type === 'revoked') this.emit('revoked', { wipe: !!msg.wipe });
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.refreshStatus({ live: false });
      if (!this.started || !this.api.online) return;
      this.wsRetry++;
      clearTimeout(this.timers.ws);
      this.timers.ws = setTimeout(() => this.openLive(), backoffDelay(Math.min(this.wsRetry, 6)));
    };
    ws.onerror = () => {};
  }

  closeLive() {
    clearTimeout(this.timers.ws);
    if (this.ws) { const w = this.ws; this.ws = null; try { w.close(); } catch { /* ignore */ } }
    this.status.live = false;
  }
}
