// Android (Capacitor) features with browser fallbacks. Every function works in a normal
// browser too, so the website and the app share the same screens.
import { isNativeApp } from './api.js';

const P = () => (globalThis.Capacitor && globalThis.Capacitor.Plugins) || {};
export const NATIVE = isNativeApp();

/** Current GPS position: { lat, lng, accuracy } (metres). */
export async function getLocation() {
  if (NATIVE && P().Geolocation) {
    let perm = await P().Geolocation.checkPermissions().catch(() => null);
    if (perm && perm.location !== 'granted') perm = await P().Geolocation.requestPermissions().catch(() => null);
    if (perm && perm.location === 'denied') throw new Error('gps_denied');
    let pos;
    try {
      pos = await P().Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000 });
    } catch (err) {
      throw new Error(/denied|permission/i.test(String(err?.message)) ? 'gps_denied' : /disabled|not enabled|services/i.test(String(err?.message)) ? 'no_gps' : 'gps_failed');
    }
    return { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), accuracy: Math.round(pos.coords.accuracy) };
  }
  if (!navigator.geolocation) throw new Error('no_gps');
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), accuracy: Math.round(pos.coords.accuracy) }),
      (err) => reject(new Error(err.code === 1 ? 'gps_denied' : 'gps_failed')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 },
    );
  });
}

/** Take a photo (app: camera or gallery) and return a File, or null if cancelled. */
export async function takePhoto() {
  if (!NATIVE || !P().Camera) return null; // browser: the page uses <input type="file" accept="image/*" capture>
  try {
    const photo = await P().Camera.getPhoto({ quality: 80, resultType: 'base64', source: 'PROMPT', width: 1600, correctOrientation: true });
    const bin = atob(photo.base64String);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime = `image/${photo.format === 'png' ? 'png' : 'jpeg'}`;
    return new File([bytes], `photo-${Date.now()}.${photo.format === 'png' ? 'png' : 'jpg'}`, { type: mime });
  } catch (err) {
    if (/cancel/i.test(String(err?.message))) return null;
    throw err;
  }
}

const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Save a downloaded file: browser = download; app = save to cache and open the share sheet. */
export async function saveFile(blob, filename) {
  if (NATIVE && P().Filesystem && P().Share) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const written = await P().Filesystem.writeFile({ path: filename, data: toBase64(bytes), directory: 'CACHE' });
    await P().Share.share({ title: filename, url: written.uri, dialogTitle: filename });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Phone notification for something new (only when the app is in the background). */
let notifPermission = null;
export async function systemNotify(title, body, id = Date.now() % 2147483647) {
  if (document.visibilityState === 'visible') return;
  if (NATIVE && P().LocalNotifications) {
    if (notifPermission === null) {
      const p = await P().LocalNotifications.requestPermissions().catch(() => ({ display: 'denied' }));
      notifPermission = p.display === 'granted';
    }
    if (notifPermission) await P().LocalNotifications.schedule({ notifications: [{ id, title, body }] }).catch(() => {});
    return;
  }
  if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
}

export function askBrowserNotifications() {
  if (!NATIVE && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

/** App plugin hooks: back button, resume, network changes. */
export function onNative({ back, resume, network }) {
  if (!NATIVE) return;
  P().App?.addListener?.('backButton', back);
  P().App?.addListener?.('resume', resume);
  P().Network?.addListener?.('networkStatusChange', (s) => network(!!s.connected));
}

export const exitApp = () => P().App?.exitApp?.();

export function setStatusBar(theme) {
  try { P().SystemBars?.setStyle?.({ style: theme === 'dark' ? 'DARK' : 'LIGHT' })?.catch?.(() => {}); } catch { /* not in the app */ }
}

/** Voice to text: browsers with the Web Speech API. On Android the keyboard's microphone does this. */
export function speechSupported() {
  return !NATIVE && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function listen(lang, onText, onEnd) {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new Rec();
  rec.lang = { en: 'en-IN', te: 'te-IN', hi: 'hi-IN' }[lang] || 'en-IN';
  rec.interimResults = false;
  rec.onresult = (e) => onText([...e.results].map((r) => r[0].transcript).join(' '));
  rec.onend = onEnd;
  rec.onerror = onEnd;
  rec.start();
  return () => rec.stop();
}
