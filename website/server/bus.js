// Change bus: tells every connected device (over WebSockets) that something changed.
// One server: an in-process event emitter. Several servers sharing one PostgreSQL:
// PostgreSQL LISTEN/NOTIFY carries the message to every server, which forwards it to
// its own WebSocket clients.
import { EventEmitter } from 'node:events';

const CHANNEL = 'syncsafe_changes';

export async function createBus(db) {
  const local = new EventEmitter();
  local.setMaxListeners(0);
  const shared = db.kind === 'postgres';
  if (shared) {
    await db.listen(CHANNEL, (payload) => {
      try { local.emit('message', JSON.parse(payload)); } catch { /* ignore malformed */ }
    });
  }
  return {
    /** msg: { workspace_id, type: 'changed' | 'notification' | ..., ... } */
    publish(msg) {
      if (shared) db.notify(CHANNEL, JSON.stringify(msg)).catch(() => local.emit('message', msg));
      else local.emit('message', msg);
    },
    subscribe(fn) {
      local.on('message', fn);
      return () => local.off('message', fn);
    },
  };
}
