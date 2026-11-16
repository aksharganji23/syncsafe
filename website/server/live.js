// Live updates over WebSockets (path /api/live).
// The message is only a hint ("something changed, pull now"); the data itself always
// travels through the normal pull, so a missed message can never lose data.
import { WebSocketServer } from 'ws';
import { verifyAccess } from './auth.js';

export function attachLive(server, { db, bus, secret, metrics }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/api/live')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    ws.alive = true;
    const kill = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type !== 'auth' || ws.user) return;
      const { claims } = verifyAccess(String(msg.token || ''), secret);
      if (!claims) return ws.close(4001, 'invalid token');
      const device = msg.device_id ? await db.one('SELECT revoked FROM devices WHERE id = $1', [msg.device_id]).catch(() => null) : null;
      if (device?.revoked) return ws.close(4003, 'device revoked');
      clearTimeout(kill);
      ws.user = { id: claims.sub, workspace_id: claims.ws };
      ws.deviceId = msg.device_id || null;
      clients.add(ws);
      metrics?.gauge('syncsafe_live_connections', clients.size);
      ws.send(JSON.stringify({ type: 'ready' }));
    });
    ws.on('close', () => {
      clearTimeout(kill);
      clients.delete(ws);
      metrics?.gauge('syncsafe_live_connections', clients.size);
    });
    ws.on('error', () => {});
  });

  const unsubscribe = bus.subscribe((msg) => {
    for (const ws of clients) {
      if (ws.user.workspace_id !== msg.workspace_id || ws.readyState !== 1) continue;
      if (msg.type === 'notification' && msg.user_id !== ws.user.id) continue;
      if (msg.type === 'changed' && msg.device_id && msg.device_id === ws.deviceId) continue; // it already knows
      if (msg.type === 'revoked' && msg.device_id !== ws.deviceId) continue;
      ws.send(JSON.stringify(msg));
    }
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 30000);

  return {
    count: () => clients.size,
    close() {
      clearInterval(heartbeat);
      unsubscribe();
      for (const ws of clients) ws.terminate();
      wss.close();
    },
  };
}
