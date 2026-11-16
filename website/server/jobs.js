// Background jobs: due-date reminders (hourly) and clean-up of old deletions (daily).
export async function dueReminders(db, bus) {
  const rows = await db.query(
    `SELECT r.id, r.title, r.workspace_id, r.assigned_to, to_char(r.due_date, 'YYYY-MM-DD') AS due, r.due_date < current_date AS late
     FROM records r
     WHERE NOT r.is_deleted AND r.assigned_to IS NOT NULL AND r.status <> 'Closed' AND r.due_date <= current_date + 1
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.record_id = r.id AND n.kind = 'due' AND n.user_id = r.assigned_to
                       AND n.created_at::date = current_date)`,
  );
  for (const r of rows) {
    const message = r.late ? `"${r.title}" is overdue (due ${r.due})` : `"${r.title}" is due ${r.due}`;
    await db.query('INSERT INTO notifications (user_id, workspace_id, kind, record_id, message) VALUES ($1,$2,$3,$4,$5)',
      [r.assigned_to, r.workspace_id, 'due', r.id, message]);
    bus.publish({ type: 'notification', workspace_id: r.workspace_id, user_id: r.assigned_to });
  }
  return rows.length;
}

/**
 * Remove tombstones older than the team's retention period, trim old history, and
 * remember the highest change number removed. Devices that last synced before it are
 * told to start over (resync), so they cannot miss a deletion.
 */
export async function compact(db, workspaceId) {
  return db.tx(async (t) => {
    const ws = await t.one('SELECT settings FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
    const settings = ws.settings || {};
    const days = Number(settings.retentionDays || 30);
    const old = await t.query(
      `SELECT id, last_seq FROM records WHERE workspace_id = $1 AND is_deleted AND deleted_at < now() - ($2 || ' days')::interval`,
      [workspaceId, String(days)],
    );
    const ids = old.map((r) => r.id);
    let maxSeq = Number(settings.compactedThrough || 0);
    for (const r of old) maxSeq = Math.max(maxSeq, Number(r.last_seq));
    if (ids.length) {
      await t.query('DELETE FROM record_versions WHERE record_id = ANY($1)', [ids]);
      await t.query('DELETE FROM attachments WHERE record_id = ANY($1)', [ids]);
      await t.query('DELETE FROM conflicts WHERE record_id = ANY($1)', [ids]);
      await t.query('DELETE FROM notifications WHERE record_id = ANY($1)', [ids]);
      await t.query('DELETE FROM records WHERE id = ANY($1)', [ids]);
    }
    const log = await t.query(
      `DELETE FROM change_log WHERE workspace_id = $1 AND changed_at < now() - ($2 || ' days')::interval RETURNING seq`,
      [workspaceId, String(days)],
    );
    const versions = await t.query(
      `DELETE FROM record_versions v USING records r
       WHERE v.record_id = r.id AND r.workspace_id = $1 AND v.version <= r.version - 50 RETURNING v.version`,
      [workspaceId],
    );
    await t.query(`DELETE FROM sync_events WHERE workspace_id = $1 AND at < now() - interval '90 days'`, [workspaceId]);
    settings.compactedThrough = maxSeq;
    settings.lastCompaction = new Date().toISOString();
    await t.query('UPDATE workspaces SET settings = $1 WHERE id = $2', [settings, workspaceId]);
    return { tombstones_removed: ids.length, log_rows_removed: log.length, versions_trimmed: versions.length, compacted_through: maxSeq, retention_days: days };
  });
}

export function startJobs(db, bus, log = () => {}) {
  const hourly = setInterval(() => dueReminders(db, bus).catch((e) => log('due reminders failed', e)), 60 * 60 * 1000);
  const daily = setInterval(async () => {
    try {
      for (const w of await db.query('SELECT id FROM workspaces')) await compact(db, w.id);
    } catch (e) { log('compaction failed', e); }
  }, 24 * 60 * 60 * 1000);
  setTimeout(() => dueReminders(db, bus).catch(() => {}), 5000);
  return () => { clearInterval(hourly); clearInterval(daily); };
}
