// Small UI helpers shared by every screen.
import { t, lang } from './i18n.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const locale = () => ({ en: 'en-IN', te: 'te-IN', hi: 'hi-IN' }[lang()] || 'en-IN');
export const when = (iso) => (iso ? new Date(iso).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function toast(text, kind = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

/** Toast from an engine/repository notice { key, vars, kind }. */
export const noticeToast = (n) => toast(n.text || t(n.key, n.vars), n.kind, n.kind === 'error' ? 9000 : 6000);

export const statusLabel = (s) => t(`status.${s}`);
export const priorityLabel = (p) => t(`priority.${p}`);

/** Horizontal bar chart (inline SVG, theme colours via CSS variables). */
export function barChart(rows, { label = (r) => r.key, value = (r) => r.n, width = 320 } = {}) {
  if (!rows.length) return `<div class="muted small">${esc(t('reports.no_data'))}</div>`;
  const max = Math.max(...rows.map(value), 1);
  const rowH = 28;
  const labelW = 120;
  const h = rows.length * rowH + 4;
  return `<svg class="chart" viewBox="0 0 ${width} ${h}" role="img">${rows.map((r, i) => {
    const w = Math.max(2, ((width - labelW - 44) * value(r)) / max);
    const y = i * rowH + 4;
    return `<text x="0" y="${y + 15}" class="chart-label">${esc(label(r)).slice(0, 18)}</text>
      <rect x="${labelW}" y="${y + 2}" width="${w}" height="18" rx="4" class="chart-bar"/>
      <text x="${labelW + w + 6}" y="${y + 15}" class="chart-value">${value(r)}</text>`;
  }).join('')}</svg>`;
}

/** Simple line/column chart for per-minute or per-day series. */
export function seriesChart(points, series, { height = 120, width = 600 } = {}) {
  const n = points.length;
  const max = Math.max(1, ...points.flatMap((p) => series.map((s) => p[s.key] || 0)));
  const x = (i) => 30 + (i * (width - 40)) / Math.max(1, n - 1);
  const y = (v) => height - 18 - ((v || 0) * (height - 30)) / max;
  const lines = series.map((s) => {
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[s.key]).toFixed(1)}`).join(' ');
    return `<path d="${d}" class="chart-line ${s.cls || ''}" fill="none"/>`;
  }).join('');
  const ticks = [0, Math.floor(n / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i)
    .map((i) => `<text x="${x(i)}" y="${height - 2}" class="chart-label" text-anchor="middle">${esc(points[i]?.label ?? '')}</text>`).join('');
  const legend = series.map((s, i) => `<text x="${40 + i * 120}" y="12" class="chart-legend ${s.cls || ''}">● ${esc(s.name)}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img">
    <line x1="30" x2="${width - 10}" y1="${height - 18}" y2="${height - 18}" class="chart-axis"/>
    <text x="0" y="${y(max) + 4}" class="chart-label">${max}</text>${lines}${ticks}${legend}</svg>`;
}

export function confirmBox(message) {
  return Promise.resolve(window.confirm(message));
}
