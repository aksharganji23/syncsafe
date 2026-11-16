// Observability: request timing, sync outcomes and live counts.
//  - GET /metrics      Prometheus text format (for Prometheus/Grafana, if you run them)
//  - GET /api/admin/metrics/live   last 60 minutes, per minute, for the Admin charts
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export function createMetrics() {
  const counters = new Map();   // name{labels} -> value
  const hist = new Map();       // route -> { buckets:[], sum, count }
  const gauges = new Map();
  const minutes = new Map();    // minute ISO -> { requests, errors, latencies:[], applied, conflicts, rejected, duplicates, faults }

  const key = (name, labels = {}) => `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`).join(',')}}`;
  const inc = (name, labels, by = 1) => counters.set(key(name, labels), (counters.get(key(name, labels)) || 0) + by);
  const minute = () => {
    const m = new Date().toISOString().slice(0, 16);
    if (!minutes.has(m)) {
      minutes.set(m, { requests: 0, errors: 0, latencies: [], applied: 0, conflicts: 0, rejected: 0, duplicates: 0, faults: 0 });
      for (const k of [...minutes.keys()].sort().slice(0, -60)) minutes.delete(k);
    }
    return minutes.get(m);
  };

  const routeOf = (req) => {
    const p = req.baseUrl + (req.route?.path || req.path);
    return String(p).replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id').replace(/\/\d+(?=\/|$)/g, '/:n');
  };

  return {
    middleware(req, res, next) {
      if (!req.path.startsWith('/api/')) return next();
      const t0 = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const route = routeOf(req);
        inc('syncsafe_http_requests_total', { method: req.method, route, status: res.statusCode });
        let h = hist.get(route);
        if (!h) { h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; hist.set(route, h); }
        BUCKETS.forEach((b, i) => { if (ms <= b) h.buckets[i]++; });
        h.sum += ms; h.count++;
        const m = minute();
        m.requests++;
        if (res.statusCode >= 500) m.errors++;
        if (route.startsWith('/api/sync/')) m.latencies.push(ms);
      });
      next();
    },
    syncResults(results) {
      const m = minute();
      for (const r of results) {
        const k = r.duplicate ? 'duplicates' : r.status === 'conflict' ? 'conflicts' : r.status === 'rejected' ? 'rejected' : 'applied';
        m[k]++;
        inc('syncsafe_sync_operations_total', { result: k });
      }
    },
    fault() { minute().faults++; inc('syncsafe_injected_faults_total'); },
    gauge(name, value) { gauges.set(name, value); },
    prometheus() {
      const lines = [];
      lines.push('# HELP syncsafe_http_requests_total HTTP requests by route and status', '# TYPE syncsafe_http_requests_total counter');
      for (const [k, v] of counters) if (k.startsWith('syncsafe_http')) lines.push(`${k} ${v}`);
      lines.push('# HELP syncsafe_sync_operations_total Pushed operations by result', '# TYPE syncsafe_sync_operations_total counter');
      for (const [k, v] of counters) if (!k.startsWith('syncsafe_http')) lines.push(`${k} ${v}`);
      lines.push('# HELP syncsafe_http_request_duration_ms Request duration', '# TYPE syncsafe_http_request_duration_ms histogram');
      for (const [route, h] of hist) {
        BUCKETS.forEach((b, i) => lines.push(`syncsafe_http_request_duration_ms_bucket{route="${route}",le="${b}"} ${h.buckets[i]}`));
        lines.push(`syncsafe_http_request_duration_ms_bucket{route="${route}",le="+Inf"} ${h.count}`);
        lines.push(`syncsafe_http_request_duration_ms_sum{route="${route}"} ${h.sum.toFixed(1)}`);
        lines.push(`syncsafe_http_request_duration_ms_count{route="${route}"} ${h.count}`);
      }
      for (const [k, v] of gauges) lines.push(`# TYPE ${k} gauge`, `${k} ${v}`);
      return lines.join('\n') + '\n';
    },
    live() {
      const pct = (arr, p) => {
        if (!arr.length) return null;
        const s = [...arr].sort((a, b) => a - b);
        return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
      };
      const out = [];
      const now = Date.now();
      for (let i = 59; i >= 0; i--) {
        const m = new Date(now - i * 60000).toISOString().slice(0, 16);
        const d = minutes.get(m) || { requests: 0, errors: 0, latencies: [], applied: 0, conflicts: 0, rejected: 0, duplicates: 0, faults: 0 };
        out.push({ minute: m.slice(11), requests: d.requests, errors: d.errors, p50: pct(d.latencies, 50), p95: pct(d.latencies, 95),
          applied: d.applied, conflicts: d.conflicts, rejected: d.rejected, duplicates: d.duplicates, faults: d.faults });
      }
      return { minutes: out, gauges: Object.fromEntries(gauges) };
    },
  };
}
