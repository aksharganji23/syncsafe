// Map tab: every record with a GPS location as a pin (Leaflet + OpenStreetMap tiles).
// Pins come from the device's own data, so they show offline; the background map needs internet.
import { $, esc, toast, statusLabel, priorityLabel } from '../ui.js';
import { isOverdue } from '../core.js';
import { getLocation } from '../native.js';

const COLORS = { Pending: '#e3a74a', Visited: '#5aa9e6', 'Follow-up': '#c084fc', Closed: '#4cc38a' };

export function createMapView(ctx, root) {
  const { t, store, engine, api } = ctx;
  let map = null;
  let layer = null;
  let tiles = null;
  let focusId = null;

  engine.addEventListener('focus-map', (e) => { focusId = e.detail; if (map) draw(); });

  function render() {
    if (!window.L) { root.innerHTML = `<div class="empty">${esc(t('map.unavailable'))}</div>`; return; }
    if (!map) {
      root.innerHTML = `
        <div class="toolbar">
          <span class="muted small" id="m-count"></span><span class="spacer"></span>
          <span class="legend">${Object.keys(COLORS).map((s) => `<span><i style="background:${COLORS[s]}"></i>${esc(statusLabel(s))}</span>`).join('')}</span>
          <button class="secondary small-btn" id="m-me">📍 ${esc(t('map.me'))}</button>
        </div>
        <div id="m-offline" class="hint" hidden>${esc(t('map.offline'))}</div>
        <div id="map" class="map"></div>
        ${ctx.canEdit() ? `<p class="muted small">${esc(t('map.tap_to_add'))}</p>` : ''}`;
      map = window.L.map($('#map', root), { zoomControl: true }).setView([38.7628, -93.736], 12);
      tiles = window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      layer = window.L.layerGroup().addTo(map);
      map.on('click', (e) => {
        if (!ctx.canEdit()) return;
        const g = { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6), accuracy: null };
        window.L.popup().setLatLng(e.latlng).setContent(`<button class="primary small-btn" id="m-add">+ ${esc(t('map.add_here'))}</button>`).openOn(map);
        setTimeout(() => $('#m-add')?.addEventListener('click', () => { map.closePopup(); ctx.openEditor(null, { prefill: { geo: g } }); }), 0);
      });
      $('#m-me', root).addEventListener('click', async () => {
        try {
          const g = await getLocation();
          map.setView([g.lat, g.lng], 16);
          window.L.circle([g.lat, g.lng], { radius: g.accuracy || 20, className: 'me-circle' }).addTo(layer);
        } catch (err) { toast(['no_gps', 'gps_denied', 'gps_failed'].includes(err.message) ? t(`gps.${err.message}`) : err.message, 'error'); }
      });
      draw(true);
    } else {
      draw(false);
    }
    $('#m-offline', root).hidden = api.online;
    setTimeout(() => map.invalidateSize(), 60);
  }

  function draw(fit) {
    layer.clearLayers();
    const recs = [...store.records.values()].filter((r) => !r.is_deleted && r.geo);
    $('#m-count', root).textContent = t('map.count', { n: recs.length, total: [...store.records.values()].filter((r) => !r.is_deleted).length });
    const pts = [];
    for (const r of recs) {
      const color = COLORS[r.status] || '#93a1b0';
      const m = window.L.circleMarker([r.geo.lat, r.geo.lng], {
        radius: r.priority === 'High' ? 10 : 7, color: isOverdue(r) ? '#f07167' : '#0f1419', weight: isOverdue(r) ? 3 : 1.5, fillColor: color, fillOpacity: 0.9,
      }).addTo(layer);
      m.bindPopup(`<strong>${esc(r.title)}</strong><br>${esc(r.location || '')}<br>${esc(statusLabel(r.status))} · ${esc(priorityLabel(r.priority))}${isOverdue(r) ? ` · <span class="overdue">${esc(t('records.overdue'))}</span>` : ''}<br><button class="secondary small-btn map-open" data-id="${esc(r.id)}">${esc(t('common.open'))}</button>`);
      m.on('popupopen', () => setTimeout(() => document.querySelector(`.map-open[data-id="${CSS.escape(r.id)}"]`)?.addEventListener('click', () => ctx.openEditor(r.id)), 0));
      pts.push([r.geo.lat, r.geo.lng]);
      if (focusId === r.id) { map.setView([r.geo.lat, r.geo.lng], 17); m.openPopup(); }
    }
    if (fit && pts.length && !focusId) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
    focusId = null;
  }

  return { render };
}
