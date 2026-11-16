// Languages: English, Telugu, Hindi. Text in the HTML uses data-i18n="key";
// text built in code uses t('key', { vars }). Missing words fall back to English.
import en from './lang/en.js';
import te from './lang/te.js';
import hi from './lang/hi.js';

export const LANGS = { en: 'English', te: 'తెలుగు', hi: 'हिन्दी' };
const DICTS = { en, te, hi };
let current = 'en';

export const lang = () => current;

export function setLang(code) {
  current = DICTS[code] ? code : 'en';
  document.documentElement.lang = current;
  applyI18n(document);
}

export function t(key, vars = {}) {
  const raw = DICTS[current][key] ?? en[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

export function applyI18n(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}

export const dictionaries = DICTS;
