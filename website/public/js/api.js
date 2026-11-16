// HTTP client. Adds the access token and device id to every request, refreshes the
// short-lived access token with the device's refresh token when it expires, times out
// slow requests, and honours the "Simulate offline" switch.
export class NetworkError extends Error {}
export class AuthError extends Error {
  constructor(message, code, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

export const isNativeApp = () => !!(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());

// "192.168.1.5:3000" -> "http://192.168.1.5:3000"; trims spaces and trailing slashes.
export function normalizeServerUrl(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return '';
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

export class Api extends EventTarget {
  constructor() {
    super();
    this.base = '';
    this.accessToken = null;
    this.refreshToken = null;        // set from the encrypted session after unlock
    this.deviceId = null;
    this.deviceName = null;
    this.simulatedOffline = false;
    this.refreshing = null;
  }

  get online() { return navigator.onLine && !this.simulatedOffline; }

  wsUrl() {
    const b = this.base || location.origin;
    return `${b.replace(/^http/, 'ws')}/api/live`;
  }

  headers(extra = {}) {
    return {
      ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      ...(this.deviceId ? { 'x-device-id': this.deviceId, 'x-device-name': encodeURIComponent(this.deviceName || '').slice(0, 120) } : {}),
      ...extra,
    };
  }

  async raw(method, path, { body, timeout = 15000, headers = {}, auth = true } = {}) {
    if (!this.online) throw new NetworkError('Offline');
    if (auth && !this.accessToken && this.refreshToken) await this.refresh();
    const send = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        return await fetch(`${this.base}${path}`, { method, signal: ctrl.signal, headers: this.headers(headers), body });
      } catch {
        throw new NetworkError(this.base ? `Cannot reach the server at ${this.base}` : 'Server unreachable');
      } finally {
        clearTimeout(timer);
      }
    };
    let res = await send();
    if (res.status === 401 && auth && this.refreshToken) {
      const data = await res.clone().json().catch(() => ({}));
      if (data.code === 'token_expired' || data.code === 'token_invalid' || data.code === 'login_required') {
        await this.refresh();
        res = await send();
      }
    }
    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      const err = new AuthError(data.error || 'Login required', data.code || 'login_required', { wipe: !!data.wipe });
      this.dispatchEvent(new CustomEvent('auth-error', { detail: err }));
      throw err;
    }
    if (res.status >= 500) {
      const data = await res.json().catch(() => ({}));
      throw new NetworkError(data.error || `Server error ${res.status}`);
    }
    return res;
  }

  async request(method, path, body, opts = {}) {
    const res = await this.raw(method, path, {
      ...opts,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  get(path, opts) { return this.request('GET', path, undefined, opts); }
  post(path, body = {}, opts) { return this.request('POST', path, body, opts); }
  del(path, opts) { return this.request('DELETE', path, undefined, opts); }

  /** Swap the refresh token for a new pair (only one refresh runs at a time). */
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const res = await this.raw('POST', '/api/auth/refresh', {
        auth: false, body: JSON.stringify({ refresh_token: this.refreshToken }), headers: { 'content-type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new AuthError(data.error || 'Please log in again', data.code || 'refresh_invalid', { wipe: !!data.wipe });
        this.accessToken = null;
        this.dispatchEvent(new CustomEvent('auth-error', { detail: err }));
        throw err;
      }
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token;
      this.dispatchEvent(new CustomEvent('tokens', { detail: data }));
      return data;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Download a file (with the auth header) as a Blob. */
  async blob(path) {
    const res = await this.raw('GET', path);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return res.blob();
  }
}
