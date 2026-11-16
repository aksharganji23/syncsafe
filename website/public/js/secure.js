// Encryption of data stored on the device (AES-GCM 256, Web Crypto).
// The key is derived from the user's password (PBKDF2-SHA-256) and kept only in memory,
// so a lost phone's records, notes and photos can't be read without the password.
const enc = new TextEncoder();
const dec = new TextDecoder();
export const PBKDF2_ITERATIONS = 150000;

const subtle = () => {
  if (!globalThis.crypto?.subtle) throw new Error('This browser cannot encrypt data here. Open SyncSafe via localhost, HTTPS, or the Android app.');
  return globalThis.crypto.subtle;
};

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export async function deriveKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptBytes(key, bytes) {
  const iv = randomBytes(12);
  const data = await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv, data: new Uint8Array(data) };
}

export async function decryptBytes(key, box) {
  const data = await subtle().decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.data);
  return new Uint8Array(data);
}

export const encryptJSON = (key, value) => encryptBytes(key, enc.encode(JSON.stringify(value)));
export const decryptJSON = async (key, box) => JSON.parse(dec.decode(await decryptBytes(key, box)));

export async function sha256Hex(bytes) {
  const h = await subtle().digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
