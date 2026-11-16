// App controller: start-up, unlock/login, top bar, tabs. Each tab lives in views/*.js.
import { Api, NetworkError, AuthError, normalizeServerUrl } from './api.js';
import { LocalStore } from './store.js';
import { SyncEngine } from './sync-engine.js';
import { uuid } from './core.js';
import { t, setLang, lang, LANGS, applyI18n } from './i18n.js';
import { $, $$, esc, toast, noticeToast, when } from './ui.js';
import { NATIVE, onNative, exitApp, systemNotify, askBrowserNotifications } from './native.js';
import { createRecordsView } from './views/records.js';
import { createEditor } from './views/editor.js';
import { createMapView } from './views/map.js';
import { createConflictsView } from './views/conflicts.js';
import { createReportsView } from './views/reports.js';
import { createActivityView } from './views/activity.js';
import { createAdminView } from './views/admin.js';

window.SyncSafeT = t;
const store = new LocalStore();
const api = new Api();
const engine = new SyncEngine(api, store);
let currentTab = 'records';
let views = {};

// ---------- shared context for the screens ----------
const ROLE_RANK = { viewer: 0, field: 1, supervisor: 2, admin: 3 };
const ctx = {
  store, api, engine, t,
  session: () => store.secure.session || null,
  user: () => store.secure.session?.user || null,
  team: () => store.secure.session?.team || { members: [], custom_fields: [], rules: {} },
  members: () => ctx.team().members || [],
  memberName: (id) => ctx.members().find((m) => m.id === id)?.name || '',
  customFields: () => ctx.team().custom_fields || [],
  atLeast: (role) => (ROLE_RANK[ctx.user()?.role] ?? -1) >= ROLE_RANK[role],
  canEdit: () => ctx.atLeast('field'),
  canAssign: () => ctx.atLeast('supervisor'),
  canDelete: (r) => ctx.atLeast('supervisor') || (ctx.user()?.role === 'field' && (r.created_by === ctx.user()?.id || !r.version)),
  isAdmin: () => ctx.user()?.role === 'admin',
  switchTab: (name) => switchTab(name),
  rerender: () => renderCurrent(),
  openEditor: (id, opts) => views.editor.open(id, opts),
};

// ---------- boot ----------
async function boot() {
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB) {
    $('#boot-message').textContent = t('boot.insecure');
    return;
  }
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  await store.init();
  setLang(store.kv.lang || (navigator.language || 'en').slice(0, 2));
  fillLangSelects();
  window.SyncSafeTheme?.refresh();

  if (!store.kv.deviceId) await store.setKV('deviceId', uuid());
  if (!store.kv.deviceName) await store.setKV('deviceName', describeDevice());
  api.deviceId = store.kv.deviceId;
  api.deviceName = store.kv.deviceName;
  api.base = NATIVE ? store.kv.serverUrl || '' : '';
  api.simulatedOffline = !!store.kv.simulatedOffline;
  $('#sim-offline').checked = api.simulatedOffline;
  $('#server-url').value = api.base;
  if (NATIVE) {
    document.documentElement.classList.add('native-app');
    $('#server-box').hidden = false;
  }

  views = {
    records: createRecordsView(ctx, $('#tab-records')),
    map: createMapView(ctx, $('#tab-map')),
    conflicts: createConflictsView(ctx, $('#tab-conflicts')),
    reports: createReportsView(ctx, $('#tab-reports')),
    activity: createActivityView(ctx, $('#tab-activity')),
    admin: createAdminView(ctx, $('#tab-admin')),
    editor: createEditor(ctx),
  };

  wireAuthScreens();
  wireTopBar();
  wireEngine();
  onNative({
    back: () => {
      const open = $$('dialog[open]');
      if (open.length) { open.at(-1).close(); return; }
      if (!$('#notif-panel').hidden) { $('#notif-panel').hidden = true; return; }
      if (!$('#app-view').hidden && currentTab !== 'records') { switchTab('records'); return; }
      exitApp();
    },
    resume: () => engine.sync('app resumed'),
    network: (up) => (up ? engine.reconnected() : engine.refreshStatus()),
  });

  $('#boot-view').hidden = true;
  if (store.account) showLock(); else showLogin();
}

function describeDevice() {
  const ua = navigator.userAgent;
  if (NATIVE) return `SyncSafe app on Android · ${(store.kv.deviceId || '').slice(0, 4)}`;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Device';
  return `${browser} on ${os} · ${(store.kv.deviceId || '').slice(0, 4)}`;
}

function fillLangSelects() {
  for (const sel of $$('.lang-select')) {
    sel.innerHTML = Object.entries(LANGS).map(([code, name]) => `<option value="${code}" ${code === lang() ? 'selected' : ''}>${name}</option>`).join('');
  }
}

$$('.lang-select').forEach((sel) => sel.addEventListener('change', async (e) => {
  setLang(e.target.value);
  await store.setKV('lang', e.target.value);
  fillLangSelects();
  window.SyncSafeTheme?.refresh();
  if (!$('#lock-view').hidden) showLock();
  if (!$('#app-view').hidden) { renderTopBar(); renderCurrent(); renderStatus(engine.status); }
}));

// ---------- unlock / login / register ----------
function showView(id) {
  for (const v of ['#boot-view', '#lock-view', '#login-view', '#app-view']) $(v).hidden = v !== id;
}

function showLock() {
  showView('#lock-view');
  $('#lock-title').textContent = t('lock.title', { name: store.account.name });
  setTimeout(() => $('#lock-form').password.focus(), 50);
}

function showLogin(messageKey, vars) {
  engine.stop();
  showView('#login-view');
  $('#auth-message').hidden = !messageKey;
  $('#auth-message').textContent = messageKey ? t(messageKey, vars) : '';
  if (store.account) $('#login-form').email.value = store.account.email;
}

function setAuthMode(mode) {
  $$('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.auth === mode));
  $('#login-form').hidden = mode !== 'login';
  $('#register-form').hidden = mode === 'login';
  $('#register-form').dataset.mode = mode;
  $$('.only-create').forEach((el) => { el.hidden = mode !== 'create'; });
  $$('.only-join').forEach((el) => { el.hidden = mode !== 'join'; });
  $('#register-form').team_name.required = mode === 'create';
  $('#register-form').invite_code.required = mode === 'join';
  $('#register-submit').textContent = t(mode === 'join' ? 'auth.join_team' : 'auth.create_team');
}

async function useServerFromForm({ quiet = false } = {}) {
  if (!NATIVE) return true;
  const url = normalizeServerUrl($('#server-url').value);
  if (!url) { toast(t('server.enter'), 'error', 7000); $('#server-url').focus(); return false; }
  $('#server-url').value = url;
  const previous = api.base;
  api.base = url;
  try {
    const health = await api.get('/api/health', { timeout: 6000, auth: false });
    if (!health?.ok) throw new Error('not syncsafe');
  } catch (err) {
    api.base = previous;
    toast(err instanceof NetworkError && !api.online ? t('server.offline') : t('server.no_answer', { url }), 'error', 10000);
    return false;
  }
  await store.setKV('serverUrl', url);
  if (!quiet) toast(t('server.connected', { url }), 'ok', 3000);
  return true;
}

/** After the server accepted email + password: open (or create) the encrypted store, save the session. */
async function afterAuth(data, password) {
  const sameAccount = store.account && store.account.email === data.user.email;
  let opened = false;
  if (sameAccount) opened = await store.unlock(password);
  if (!opened) {
    const pending = store.account ? await countPendingFor(password) : 0;
    if (store.account && !sameAccount && !window.confirm(t('auth.switch_confirm', { name: store.account.name }))) return false;
    if (pending && !window.confirm(t('auth.pending_lost', { n: pending }))) return false;
    await store.createAccount({ email: data.user.email, name: data.user.name, userId: data.user.id, password });
  }
  await store.mutate((tx) => tx.setSecure('session', { user: data.user, team: data.team, refresh_token: data.refresh_token }));
  api.accessToken = data.access_token;
  api.refreshToken = data.refresh_token;
  startApp();
  return true;
}

async function countPendingFor() { return store.unlocked ? store.outbox.size : 0; }

async function authSubmit(path, body, password, button) {
  button.disabled = true;
  try {
    if (!(await useServerFromForm({ quiet: true }))) return;
    const data = await api.post(path, body, { auth: false });
    await afterAuth(data, password);
  } catch (err) {
    if (err instanceof NetworkError) toast(`${t('auth.need_connection')} ${err.message}`, 'error', 8000);
    else toast(err.message, 'error', 7000);
  } finally {
    button.disabled = false;
  }
}

function wireAuthScreens() {
  $('#lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    const ok = await store.unlock(e.target.password.value).catch(() => false);
    btn.disabled = false;
    e.target.reset();
    if (!ok) { toast(t('lock.wrong'), 'error'); return; }
    const s = store.secure.session;
    if (!s?.refresh_token) { showLogin('auth.login_again'); return; }
    api.refreshToken = s.refresh_token;
    startApp();
  });
  $('#lock-switch').addEventListener('click', () => { store.lock(); showLogin(); });

  $$('.seg-btn').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));
  setAuthMode('login');
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    authSubmit('/api/auth/login', f, f.password, e.target.querySelector('button[type=submit]'));
  });
  $('#register-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const mode = e.target.dataset.mode;
    const body = { name: f.name, email: f.email, password: f.password, ...(mode === 'join' ? { invite_code: f.invite_code } : { team_name: f.team_name }) };
    authSubmit('/api/auth/register', body, f.password, e.target.querySelector('button[type=submit]'));
  });
  $$('.chip-btn').forEach((b) => b.addEventListener('click', () => {
    setAuthMode('login');
    $('#login-form').email.value = b.dataset.email;
    $('#login-form').password.value = b.dataset.pass;
  }));
  $('#test-server').addEventListener('click', async () => {
    const b = $('#test-server');
    b.disabled = true;
    await useServerFromForm();
    b.disabled = false;
  });
}

// ---------- main app ----------
function startApp() {
  showView('#app-view');
  $$('#toasts .toast.error').forEach((el) => el.remove());
  renderTopBar();
  switchTab(ctx.canEdit() || currentTab !== 'records' ? currentTab : 'records');
  engine.start();
  engine.refreshStatus();
  engine.sync('start');
  refreshTeam().catch(() => {});
  askBrowserNotifications();
}

async function refreshTeam() {
  if (!api.online) return;
  const me = await api.get('/api/me');
  await store.mutate((tx) => tx.setSecure('session', { ...store.secure.session, user: { ...store.secure.session.user, ...me.user }, team: me.team }));
  renderTopBar();
  renderCurrent();
}

function renderTopBar() {
  const u = ctx.user();
  if (!u) return;
  $('#user-name').textContent = `${u.name} · ${t(`role.${u.role}`)}`;
  $('#admin-tab').hidden = !ctx.atLeast('supervisor');
  $('#readonly-banner').hidden = ctx.canEdit();
  applyI18n($('#app-view'));
}

function wireTopBar() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  $('#sync-now').addEventListener('click', () => engine.sync('manual'));
  $('#sim-offline').addEventListener('change', async (e) => {
    api.simulatedOffline = e.target.checked;
    await store.setKV('simulatedOffline', e.target.checked);
    if (e.target.checked) { engine.closeLive(); engine.refreshStatus({ state: 'offline' }); } else engine.reconnected();
  });
  $('#logout').addEventListener('click', async () => {
    const pending = store.outbox.size;
    if (pending > 0 && !window.confirm(t('top.logout_pending', { n: pending }))) return;
    if (pending === 0 && !window.confirm(t('top.logout_confirm'))) return;
    const refresh = api.refreshToken;
    if (refresh && api.online) api.post('/api/auth/logout', { refresh_token: refresh }, { auth: false }).catch(() => {});
    api.accessToken = null;
    api.refreshToken = null;
    engine.stop();
    await store.wipe();
    showLogin();
  });
  $('#bell').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = $('#notif-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderNotifications(true);
  });
  document.addEventListener('click', (e) => {
    if (!$('#notif-panel').hidden && !e.target.closest('#notif-panel')) $('#notif-panel').hidden = true;
  });
}

function switchTab(tab) {
  if (tab === 'admin' && !ctx.atLeast('supervisor')) tab = 'records';
  currentTab = tab;
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  $$('main > section').forEach((s) => { s.hidden = s.id !== `tab-${tab}`; });
  renderCurrent();
}

function renderCurrent() {
  if ($('#app-view').hidden) return;
  views[currentTab]?.render();
}

// ---------- status, notices, notifications ----------
function renderStatus(s) {
  const pill = $('#status-pill');
  let cls = 'ok';
  let text = t('status.synced');
  const waiting = s.pending + s.uploads;
  if (s.state === 'offline') { cls = 'offline'; text = waiting ? t('status.offline_waiting', { n: waiting }) : t('status.offline'); }
  else if (s.state === 'syncing') { cls = 'syncing'; text = t('status.syncing'); }
  else if (s.state === 'auth') { cls = 'auth'; text = t('status.login'); }
  else if (s.state === 'error') { cls = 'error'; text = waiting ? t('status.retrying_waiting', { n: waiting }) : t('status.retrying'); }
  else if (waiting) { cls = 'pending'; text = t('status.waiting', { n: waiting }); }
  pill.className = `status-pill ${cls}`;
  $('#status-text').textContent = text;
  $('#live-dot').hidden = !s.live;
  pill.title = s.message || (s.lastSyncAt ? t('status.last', { when: when(s.lastSyncAt) }) : '');
  $('#offline-banner').hidden = s.state !== 'offline';
  $('#conflict-badge').hidden = !s.conflicts;
  $('#conflict-badge').textContent = s.conflicts;
  $('#pending-badge').hidden = !waiting;
  $('#pending-badge').textContent = waiting;
}

function renderNotifications(markRead = false) {
  const { items, unread } = engine.notifications;
  $('#bell-count').hidden = !unread;
  $('#bell-count').textContent = unread;
  const panel = $('#notif-panel');
  if (panel.hidden) return;
  panel.innerHTML = `<div class="notif-head"><strong>${esc(t('notif.title'))}</strong></div>${items.length
    ? items.map((n) => `<button class="notif ${n.read ? '' : 'unread'}" data-record="${esc(n.record_id || '')}"><span>${esc(n.message)}</span><span class="muted small">${esc(when(n.created_at))}</span></button>`).join('')
    : `<div class="muted small pad">${esc(api.online ? t('notif.none') : t('notif.offline'))}</div>`}`;
  $$('.notif', panel).forEach((b) => b.addEventListener('click', () => {
    panel.hidden = true;
    if (b.dataset.record && store.records.get(b.dataset.record)) { switchTab('records'); ctx.openEditor(b.dataset.record); }
  }));
  if (markRead && unread && api.online) {
    api.post('/api/notifications/read', {}).then(() => { engine.notifications.unread = 0; $('#bell-count').hidden = true; }).catch(() => {});
  }
}

function handleSignedOut({ wipe, code }) {
  engine.stop();
  api.accessToken = null;
  api.refreshToken = null;
  if (wipe) {
    store.wipe().then(() => showLogin('auth.revoked_wiped'));
  } else if (code === 'device_revoked') {
    store.mutate((tx) => tx.setSecure('session', { ...store.secure.session, refresh_token: null })).finally(() => showLogin('auth.revoked'));
  } else {
    showLogin('auth.login_again');
  }
}

function wireEngine() {
  engine.addEventListener('status', (e) => { renderStatus(e.detail); if (currentTab === 'activity') views.activity.renderOutbox(); });
  engine.addEventListener('changed', () => renderCurrent());
  engine.addEventListener('notice', (e) => noticeToast(e.detail));
  engine.addEventListener('notifications', (e) => {
    renderNotifications();
    for (const n of e.detail.fresh || []) systemNotify('SyncSafe', n.message, n.id);
  });
  engine.addEventListener('team', () => refreshTeam().catch(() => {}));
  engine.addEventListener('revoked', (e) => handleSignedOut({ wipe: e.detail.wipe, code: 'device_revoked' }));
  engine.addEventListener('server-reset', () => showLogin('notice.server_reset'));
  store.addEventListener('change', () => { if (!$('#app-view').hidden) engine.refreshStatus(); });
  api.addEventListener('tokens', (e) => {
    if (store.unlocked && store.secure.session) store.mutate((tx) => tx.setSecure('session', { ...store.secure.session, refresh_token: e.detail.refresh_token, user: { ...store.secure.session.user, ...e.detail.user } })).catch(() => {});
    if (!engine.ws) engine.openLive();
  });
  api.addEventListener('auth-error', (e) => {
    const err = e.detail;
    if (err.code === 'device_revoked') handleSignedOut({ wipe: err.wipe, code: err.code });
    else if (['refresh_invalid', 'refresh_reused', 'refresh_expired', 'account_disabled'].includes(err.code)) handleSignedOut({ wipe: false, code: err.code });
  });
}

boot().catch((err) => {
  console.error(err);
  $('#boot-message').textContent = `${t('boot.failed')} ${err.message}`;
});

export { AuthError };
