// Unit tests for pure logic: conflict rules, client helpers, rule-based AI, text CRDT,
// network address ordering and translation completeness. No server needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOperation, sanitizeCustomFields, sanitizeRules, flattenFields, DEFAULT_RULES } from '../server/conflict.js';
import { coalesce, diffRecord, validateRecord, backoffDelay, parseCSV, isOverdue } from '../public/js/core.js';
import { suggestPriority, suggestStatus, findDuplicates, suggestMerge, distanceMeters } from '../public/js/ai.js';
import { loadDoc, setText, getText, encode, mergeState, editState } from '../public/js/textcrdt.js';
import { lanAddresses } from '../server/network.js';
import en from '../public/js/lang/en.js';
import te from '../public/js/lang/te.js';
import hi from '../public/js/lang/hi.js';

const rec = (over = {}) => ({
  id: 'r1', version: 3, is_deleted: false, title: 'T', status: 'Pending', notes: 'n',
  field_meta: { title: { v: 3, d: 'B' }, status: { v: 3, d: 'B' }, notes: { v: 1, d: 'A' } }, ...over,
});

test('planOperation: same field changed by another device → manual field becomes a conflict', () => {
  const p = planOperation(rec(), { type: 'update', base_version: 2, device_id: 'A', fields: { status: 'Closed' } });
  assert.equal(p.action, 'conflict');
  assert.deepEqual(p.conflictFields, ['status']);
});

test('planOperation: last-writer-wins field merges instead of conflicting', () => {
  const p = planOperation(rec(), { type: 'update', base_version: 2, device_id: 'A', fields: { title: 'New' } });
  assert.equal(p.action, 'merge');
  assert.deepEqual(p.overwritten, ['title']);
});

test('planOperation: different fields merge, up-to-date base applies, delete after edit is superseded', () => {
  assert.equal(planOperation(rec(), { type: 'update', base_version: 2, device_id: 'A', fields: { notes: 'x' } }).action, 'merge');
  assert.equal(planOperation(rec(), { type: 'update', base_version: 3, device_id: 'A', fields: { status: 'Closed' } }).action, 'apply');
  assert.equal(planOperation(rec(), { type: 'delete', base_version: 2, device_id: 'A' }).action, 'superseded');
  assert.equal(planOperation(rec({ is_deleted: true }), { type: 'update', base_version: 2, device_id: 'A', fields: { title: 'x' } }).action, 'restore');
  assert.equal(planOperation(rec(), { type: 'create', fields: {} }).action, 'reject');
});

test('planOperation: notes rule "merge" never raises a conflict', () => {
  const r = rec({ field_meta: { notes: { v: 3, d: 'B' } } });
  const p = planOperation(r, { type: 'update', base_version: 2, device_id: 'A', fields: { notes: 'mine' } }, { ...DEFAULT_RULES, notes: 'merge' });
  assert.equal(p.action, 'merge');
  assert.equal(p.mergedNotes, true);
});

test('rules and custom field definitions are sanitised', () => {
  assert.equal(sanitizeRules({ status: 'nonsense', title: 'manual' }).status, DEFAULT_RULES.status);
  assert.equal(sanitizeRules({ title: 'manual' }).title, 'manual');
  const f = sanitizeCustomFields([{ key: 'Households Affected', label: 'Households', type: 'number' }, { key: 'కుటుంబాలు', label: 'కుటుంబాలు', type: 'text' }, { key: 'x', type: 'bogus' }]);
  assert.equal(f[0].key, 'households_affected');
  assert.match(f[1].key, /^field_\d+$/);
  assert.equal(f.length, 2);
  assert.deepEqual(Object.keys(flattenFields({ title: 'a', custom: { k: 1 } })), ['title', 'custom.k']);
});

test('coalesce merges unsent edits but never touches an attempted operation', () => {
  const a = { seq: 1, type: 'update', record_id: 'r', fields: { title: 'a', custom: { x: 1 } } };
  const merged = coalesce([a], { type: 'update', record_id: 'r', fields: { status: 'Closed', custom: { y: 2 } } });
  assert.deepEqual(merged.put[0].fields, { title: 'a', status: 'Closed', custom: { x: 1, y: 2 } });
  const sent = coalesce([{ ...a, attempts: 1 }], { type: 'update', record_id: 'r', fields: { status: 'Closed' } });
  assert.equal(sent.put.length, 1);
  assert.notEqual(sent.put[0].seq, 1);
});

test('diffRecord reports only changed fields, custom per key', () => {
  const d = diffRecord({ title: 'a', status: 'Pending', custom: { x: 1, y: 2 } }, { title: 'a', status: 'Closed', custom: { x: 1 } });
  assert.deepEqual(d, { status: 'Closed', custom: { y: null } });
});

test('validateRecord checks core and custom fields', () => {
  const defs = [{ key: 'n', label: 'Count', type: 'number', required: true }, { key: 's', label: 'Ward', type: 'select', options: ['A'] }];
  const keys = validateRecord({ title: '', due_date: '2026-13-40', custom: { s: 'Z' } }, defs, { create: true }).map((e) => e.key);
  assert.deepEqual(keys.sort(), ['err.custom_invalid', 'err.custom_required', 'err.due_date', 'err.title_required']);
  assert.deepEqual(validateRecord({ title: 'ok', custom: { n: 3, s: 'A' } }, defs, { create: true }), []);
});

test('backoff grows and is capped; CSV parser handles quotes', () => {
  assert.ok(backoffDelay(1, () => 1) < backoffDelay(5, () => 1));
  assert.ok(backoffDelay(50, () => 1) <= 61000);
  const rows = parseCSV('title,notes\n"A, B","say ""hi"""\n');
  assert.equal(rows[0].title, 'A, B');
  assert.equal(rows[0].notes, 'say "hi"');
  assert.equal(isOverdue({ due_date: '2000-01-01', status: 'Pending' }), true);
  assert.equal(isOverdue({ due_date: '2000-01-01', status: 'Closed' }), false);
});

test('AI suggestions are explainable and duplicates are found by wording or distance', () => {
  assert.equal(suggestPriority({ title: 'Urgent: injured child', notes: '' })?.value, 'High');
  assert.ok(suggestPriority({ title: 'Urgent: injured child' }).reason.length > 0);
  assert.equal(suggestStatus({ notes: 'Need to come back next week' })?.value, 'Follow-up');
  const others = [
    { id: 'a', title: 'Water tank leaking', location: 'Ward 4 school' },
    { id: 'b', title: 'Street light', location: 'Far away', geo: { lat: 38.7628, lng: -93.7360 } },
    { id: 'c', title: 'Unrelated', location: 'Elsewhere' },
  ];
  const d = findDuplicates({ id: 'n', title: 'Water tank leaking badly', location: 'Ward 4 school', geo: { lat: 38.76281, lng: -93.73601 } }, others);
  assert.deepEqual(d.map((x) => x.record.id).sort(), ['a', 'b']);
  assert.ok(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) > 110000);
  assert.equal(suggestMerge('Roof leaks. Two kids.', 'Two kids. Needs tarp.'), 'Roof leaks. Two kids. Needs tarp.');
});

test('text CRDT: concurrent edits from two devices both survive, in any merge order', () => {
  const base = encode(loadDoc(null, 'Roof leaks.'));
  const a = editState(base, '', 'Roof leaks. Two kids.');
  const b = editState(base, '', 'URGENT Roof leaks.');
  const x = loadDoc(a); mergeState(x, b);
  const y = loadDoc(b); mergeState(y, a);
  assert.equal(getText(x), getText(y));
  assert.ok(getText(x).includes('Two kids.') && getText(x).includes('URGENT'));
  mergeState(x, a);                                 // re-applying is harmless
  assert.equal(getText(x), getText(y));
  const d = loadDoc(null, 'abc'); setText(d, 'abXc');
  assert.equal(getText(d), 'abXc');
});

test('LAN address list puts real Wi-Fi first and flags virtual adapters', () => {
  const list = lanAddresses({
    'VirtualBox Host-Only Network': [{ family: 'IPv4', address: '192.168.56.1', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.23', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  });
  assert.equal(list[0].address, '192.168.1.23');
  assert.ok(list.find((x) => x.address === '192.168.56.1').likelyVirtual);
});

test('every English text has a Telugu and Hindi translation with the same placeholders', () => {
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [name, dict] of [['te', te], ['hi', hi]]) {
    const missing = Object.keys(en).filter((k) => !(k in dict));
    assert.deepEqual(missing, [], `${name} is missing keys`);
    const extra = Object.keys(dict).filter((k) => !(k in en));
    assert.deepEqual(extra, [], `${name} has unknown keys`);
    for (const k of Object.keys(en)) assert.equal(vars(dict[k]), vars(en[k]), `${name} ${k} placeholders`);
  }
});
