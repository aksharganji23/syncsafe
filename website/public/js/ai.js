// Rule-based "AI" helpers. They run on the device (so they work offline) and on the server.
// No external AI service or API key: transparent rules with the reason shown to the user.

const HIGH_WORDS = ['urgent', 'emergency', 'danger', 'dangerous', 'unsafe', 'hazard', 'collapse', 'crack', 'fire', 'smoke',
  'flood', 'flooding', 'injur', 'injured', 'leak', 'leaking', 'broken', 'no water', 'contaminat', 'medicine', 'blocked',
  'electric', 'shock', 'gas', 'fallen', 'falling', 'child', 'sick', 'outbreak', 'immediately', 'asap'];
const LOW_WORDS = ['cosmetic', 'minor', 'paint', 'faded', 'request', 'survey', 'suggestion', 'routine', 'cleaning', 'later',
  'when possible', 'low priority', 'small'];
const STATUS_WORDS = {
  Closed: ['done', 'fixed', 'completed', 'resolved', 'repaired', 'replaced', 'closed', 'finished', 'cleared'],
  'Follow-up': ['follow up', 'follow-up', 'revisit', 'next week', 'next visit', 'call back', 'waiting for', 'pending approval', 'needs review', 'schedule'],
  Visited: ['visited', 'inspected', 'checked', 'measured', 'collected', 'counted', 'surveyed', 'met with'],
};

const norm = (s) => String(s || '').toLowerCase();
const found = (text, words) => words.filter((w) => text.includes(w));

/** Suggest a priority from the title + notes. Returns { value, reason } or null. */
export function suggestPriority(record) {
  const text = norm(`${record.title || ''} ${record.notes || ''}`);
  if (!text.trim()) return null;
  const high = found(text, HIGH_WORDS);
  const low = found(text, LOW_WORDS);
  if (high.length >= 1 && high.length >= low.length) return { value: 'High', reason: high.slice(0, 3).join(', ') };
  if (low.length >= 1 && high.length === 0) return { value: 'Low', reason: low.slice(0, 3).join(', ') };
  return null;
}

/** Suggest a status from the notes. Returns { value, reason } or null. */
export function suggestStatus(record) {
  const text = norm(record.notes);
  if (!text.trim()) return null;
  for (const [status, words] of Object.entries(STATUS_WORDS)) {
    const hit = found(text, words);
    if (hit.length) return { value: status, reason: hit.slice(0, 2).join(', ') };
  }
  return null;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'on', 'and', 'to', 'for', 'near', 'by', '-', '&', 'st', 'no']);
export const tokens = (s) => new Set(norm(s).replace(/[^a-z0-9ऀ-ॿఀ-౿ ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)));

export function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export function distanceMeters(g1, g2) {
  if (!g1 || !g2) return Infinity;
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(g2.lat - g1.lat);
  const dLng = rad(g2.lng - g1.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(g1.lat)) * Math.cos(rad(g2.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Possible duplicates of `record` among `others` (same title/location wording, or same place).
 * Returns up to 3 of { record, score, reason }.
 */
export function findDuplicates(record, others) {
  const out = [];
  for (const o of others) {
    if (o.id === record.id || o.is_deleted) continue;
    const titleSim = similarity(record.title, o.title);
    const placeSim = similarity(record.location, o.location);
    const meters = distanceMeters(record.geo, o.geo);
    let score = titleSim * 0.7 + placeSim * 0.3;
    const reasons = [];
    if (titleSim >= 0.5) reasons.push('similar title');
    if (placeSim >= 0.6 && record.location) reasons.push('same location');
    if (meters <= 100) { score = Math.max(score, 0.5 + titleSim * 0.5); reasons.push(`${Math.round(meters)} m away`); }
    if (score >= 0.5 && reasons.length) out.push({ record: o, score, reason: reasons.join(', ') });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 3);
}

const sentences = (s) => String(s || '').split(/(?<=[.!?\n])\s+/).map((x) => x.trim()).filter(Boolean);

/**
 * Suggest one text that keeps both people's information: all sentences from `current`,
 * then every sentence from `incoming` that is not already said (near-duplicates skipped).
 */
export function suggestMerge(current, incoming) {
  const a = sentences(current);
  const b = sentences(incoming);
  if (!a.length) return b.join(' ');
  if (!b.length) return a.join(' ');
  const merged = [...a];
  for (const s of b) {
    if (!merged.some((m) => m === s || similarity(m, s) >= 0.8)) merged.push(s);
  }
  return merged.join(' ');
}
