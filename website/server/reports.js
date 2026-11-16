// Reports: team summary, and exports to CSV, Excel (.xlsx) and PDF.
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

const today = () => new Date().toISOString().slice(0, 10);

export async function summary(db, workspaceId) {
  const q = (sql, p = [workspaceId]) => db.query(sql, p);
  const base = 'FROM records r WHERE r.workspace_id = $1 AND NOT r.is_deleted';
  const [byStatus, byPriority, byAssignee, totals, perDay] = await Promise.all([
    q(`SELECT status AS key, count(*)::int AS n ${base} GROUP BY status`),
    q(`SELECT priority AS key, count(*)::int AS n ${base} GROUP BY priority`),
    q(`SELECT coalesce(u.name, 'Unassigned') AS key, count(*)::int AS n FROM records r LEFT JOIN users u ON u.id = r.assigned_to
       WHERE r.workspace_id = $1 AND NOT r.is_deleted GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT count(*)::int AS total,
         count(*) FILTER (WHERE due_date < current_date AND status <> 'Closed')::int AS overdue,
         count(*) FILTER (WHERE due_date BETWEEN current_date AND current_date + 7 AND status <> 'Closed')::int AS due_week,
         count(*) FILTER (WHERE lat IS NOT NULL)::int AS with_location,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM attachments a WHERE a.record_id = r.id AND a.uploaded AND NOT a.is_deleted))::int AS with_photos,
         count(*) FILTER (WHERE flagged)::int AS restored ${base}`),
    q(`SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
         (SELECT count(*)::int FROM records r WHERE r.workspace_id = $1 AND r.created_at::date = d::date) AS created
       FROM generate_series(current_date - 13, current_date, interval '1 day') d ORDER BY 1`),
  ]);
  const openConflicts = await db.one(`SELECT count(*)::int AS n FROM conflicts WHERE workspace_id = $1 AND status = 'open'`, [workspaceId]);
  const overdue = await db.query(
    `SELECT r.id, r.title, r.location, r.status, r.priority, to_char(r.due_date, 'YYYY-MM-DD') AS due_date, u.name AS assignee
     FROM records r LEFT JOIN users u ON u.id = r.assigned_to
     WHERE r.workspace_id = $1 AND NOT r.is_deleted AND r.due_date < current_date AND r.status <> 'Closed'
     ORDER BY r.due_date LIMIT 50`, [workspaceId]);
  return { ...totals[0], open_conflicts: openConflicts.n, by_status: byStatus, by_priority: byPriority, by_assignee: byAssignee, created_per_day: perDay, overdue_list: overdue };
}

export async function exportRows(db, workspaceId, f = {}) {
  const where = ['r.workspace_id = $1', 'NOT r.is_deleted'];
  const p = [workspaceId];
  if (f.status) { p.push(f.status); where.push(`r.status = $${p.length}`); }
  if (f.priority) { p.push(f.priority); where.push(`r.priority = $${p.length}`); }
  if (f.overdue) where.push(`r.due_date < current_date AND r.status <> 'Closed'`);
  return db.query(
    `SELECT r.title, r.location, r.status, r.priority, coalesce(u.name, '') AS assignee, to_char(r.due_date, 'YYYY-MM-DD') AS due_date,
       r.lat, r.lng, r.notes, r.custom, r.updated_by_name AS updated_by, to_char(r.updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
     FROM records r LEFT JOIN users u ON u.id = r.assigned_to WHERE ${where.join(' AND ')} ORDER BY r.updated_at DESC`, p);
}

const COLUMNS = ['title', 'location', 'status', 'priority', 'assignee', 'due_date', 'lat', 'lng', 'notes', 'updated_by', 'updated_at'];
const HEADERS = ['Title', 'Location', 'Status', 'Priority', 'Assigned to', 'Due date', 'Latitude', 'Longitude', 'Notes', 'Last changed by', 'Last changed'];

function withCustom(rows, customFields) {
  return rows.map((r) => {
    const out = { ...r };
    for (const d of customFields) out[`custom_${d.key}`] = r.custom?.[d.key] ?? '';
    return out;
  });
}

export function toCSV(rows, customFields = []) {
  const cols = [...COLUMNS, ...customFields.map((d) => `custom_${d.key}`)];
  const head = [...HEADERS, ...customFields.map((d) => d.label)];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [head.map(esc).join(','), ...withCustom(rows, customFields).map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

export async function toXLSX(rows, sum, team, customFields = []) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SyncSafe';
  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 28 }, { width: 14 }];
  s.addRow([`SyncSafe report — ${team}`]).font = { bold: true, size: 14 };
  s.addRow([`Generated ${today()}`]);
  s.addRow([]);
  for (const [k, v] of [['Records', sum.total], ['Overdue', sum.overdue], ['Due in 7 days', sum.due_week], ['Open conflicts', sum.open_conflicts], ['With GPS location', sum.with_location], ['With photos', sum.with_photos]]) s.addRow([k, v]);
  s.addRow([]);
  s.addRow(['By status']).font = { bold: true };
  for (const r of sum.by_status) s.addRow([r.key, r.n]);
  s.addRow(['By priority']).font = { bold: true };
  for (const r of sum.by_priority) s.addRow([r.key, r.n]);
  s.addRow(['By assignee']).font = { bold: true };
  for (const r of sum.by_assignee) s.addRow([r.key, r.n]);

  const ws = wb.addWorksheet('Records');
  const cols = [...COLUMNS, ...customFields.map((d) => `custom_${d.key}`)];
  ws.columns = [...HEADERS, ...customFields.map((d) => d.label)].map((h, i) => ({ header: h, key: cols[i], width: [30, 26, 11, 9, 16, 11, 10, 10, 50, 18, 17][i] || 16 }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of withCustom(rows, customFields)) ws.addRow(r);
  ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPDF(rows, sum, team) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(18).text(`SyncSafe report — ${team}`);
    doc.fontSize(10).fillColor('#555').text(`Generated ${today()} · ${rows.length} records`).moveDown();
    doc.fillColor('#000').fontSize(12).text('Summary', { underline: true }).moveDown(0.3);
    doc.fontSize(10);
    doc.text(`Records: ${sum.total}    Overdue: ${sum.overdue}    Due in 7 days: ${sum.due_week}    Open conflicts: ${sum.open_conflicts}`);
    doc.text(`By status: ${sum.by_status.map((r) => `${r.key} ${r.n}`).join(', ')}`);
    doc.text(`By priority: ${sum.by_priority.map((r) => `${r.key} ${r.n}`).join(', ')}`);
    doc.text(`By assignee: ${sum.by_assignee.map((r) => `${r.key} ${r.n}`).join(', ')}`).moveDown();
    doc.fontSize(12).text('Records', { underline: true }).moveDown(0.3);
    const x = [40, 210, 330, 395, 450];
    const header = () => {
      doc.fontSize(9).font('Helvetica-Bold');
      const y = doc.y;
      ['Title', 'Location', 'Status', 'Priority', 'Due / Assigned'].forEach((h, i) => doc.text(h, x[i], y, { width: (x[i + 1] || 555) - x[i] - 6 }));
      doc.font('Helvetica').moveDown(0.4);
    };
    header();
    for (const r of rows) {
      if (doc.y > 770) { doc.addPage(); header(); }
      const y = doc.y;
      const cells = [r.title, r.location, r.status, r.priority, [r.due_date, r.assignee].filter(Boolean).join(' · ')];
      let maxY = y;
      cells.forEach((c, i) => {
        doc.text(String(c || ''), x[i], y, { width: (x[i + 1] || 555) - x[i] - 6 });
        maxY = Math.max(maxY, doc.y);
      });
      doc.y = maxY + 3;
      doc.x = 40;
    }
    doc.end();
  });
}
