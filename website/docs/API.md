# SyncSafe 2.0 REST API

Base URL: `http://localhost:3000`. All bodies are JSON unless noted.
Protected routes need `Authorization: Bearer <access_token>`. Sync routes also need `X-Device-Id: <uuid>`
(the device's own id; the refresh token is bound to it). Errors look like `{ "error": "message" }`.

## Accounts and sessions

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | anyone | `{ ok, version, instanceId, time }` — the app uses `instanceId` to notice a server reset |
| POST | `/api/auth/register` | anyone | `{ name, email, password, team_name }` creates a team (you are admin) or `{ …, invite_code }` joins one (field worker) |
| POST | `/api/auth/login` | anyone | `{ email, password }` → `{ access_token, refresh_token, user, team }` |
| POST | `/api/auth/refresh` | device | `{ refresh_token }` → new pair. The old refresh token stops working; re-using it signs the device out (theft detection) |
| POST | `/api/auth/logout` | device | `{ refresh_token }` revokes it |
| GET | `/api/me` | signed in | user, team (rules, custom fields, retention), members |

Access tokens last 15 minutes, refresh tokens 30 days (rotated on every use, stored only as SHA-256 hashes).

## Devices

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/devices` | signed in | your devices (admins: the whole team) |
| POST | `/api/devices/:id/revoke` | owner or admin | `{ wipe: true/false }` signs the device out; with `wipe` it erases its local data when it next connects |
| POST | `/api/devices/me/scope` | device | partial sync: `{ mode: "all" | "mine" | "area", area }` |

## Sync

**POST `/api/sync/push`** — body `{ ops: [...] }`, up to 100 operations, applied in order in one transaction:

```json
{ "op_id": "uuid", "record_id": "uuid", "type": "create|update|delete",
  "fields": { "status": "Closed", "custom": { "households": 40 } },
  "base_version": 3, "notes_state": "base64 Yjs state (optional)" }
```

Each result: `{ op_id, record_id, status, record, … }` where `status` is
`applied | merged | restored | conflict | superseded | rejected`, and `duplicate: true` when that `op_id`
was already applied (safe retry). Conflicts also return `conflict_id` and `fields`.

**GET `/api/sync/pull?cursor=N&limit=500`** → `{ changes, cursor, hasMore, scope }`.
Each change is a full record (deleted ones have `is_deleted: true`; records that left the device's scope come
as `{ id, evicted: true }`). `{ resync: true }` means the cursor is older than the last clean-up, so the
device must download everything again from cursor 0.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/sync/history` | recent push/pull events with counts and latency |
| GET | `/api/records/:id/history` | every saved version (snapshot, changed fields, who, when) |
| WS | `/api/live` | send `{ type: "auth", token, device_id }` within 5 s; then receive hints `changed`, `notification`, `settings`, `revoked`. Hints only: data always comes through pull |

## Conflicts

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/conflicts` | open conflicts with `local_value`, `current_value`, `suggested_value`, `record_version`, `can_resolve` |
| POST | `/api/conflicts/:id/resolve` | `{ choice: "mine" | "theirs" | "custom", values, seen_version }`. 409 if the record changed after you looked (`seen_version` stale) |

## Attachments (photos and files)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/attachments/:id/init` | `{ record_id, name, mime, size, sha256 }` → `{ received }` (resume point). 409 + retry if the record has not synced yet |
| PUT | `/api/attachments/:id/chunk?offset=N` | raw bytes (`application/octet-stream`, ≤ 512 KB). Wrong offset → 409 `{ received }`; finished file with a wrong SHA-256 → 422 and the upload restarts |
| GET | `/api/attachments/:id` | the file |
| DELETE | `/api/attachments/:id` | remove it for everyone |

Limits: 10 MB per file; images (JPEG, PNG, WebP, GIF), PDF, plain text and audio.

## Notifications and reports

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/notifications` | newest 50 for you, plus the `unread` count |
| POST | `/api/notifications/read` | `{ ids }` or `{}` for all |
| GET | `/api/reports/summary` | totals, overdue, due this week, by status/priority/assignee, created per day, overdue list |
| GET | `/api/reports/export?format=csv|xlsx|pdf&status=&priority=&overdue=1` | file download |

## Admin

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/admin/sync-health` | supervisor+ | devices, totals, conflicts, last 7 days, fault settings, live connections, database kind |
| GET | `/api/admin/metrics/live` | supervisor+ | last 60 minutes: requests, errors, p50, p95, applied, conflicts, rejected, duplicates, faults |
| GET | `/api/admin/users` | admin | team members |
| POST | `/api/admin/users/:id` | admin | `{ role }` and/or `{ disabled }` |
| GET / POST | `/api/admin/settings` | admin | `{ rules, custom_fields, retention_days, team_name }` |
| POST | `/api/admin/invite/regenerate` | admin | new invite code |
| POST | `/api/admin/fault` | admin | `{ rate: 0..1, mode: "before" | "after" }` chaos testing |
| POST | `/api/admin/compact` | admin | run the clean-up now |
| GET | `/metrics` | localhost, `METRICS_TOKEN`, or admin | Prometheus text format |

## Conflict rules

Per field: `lww` (later save wins), `manual` (a person decides), `merge` (notes only: CRDT merge).
Defaults: title, location, priority, GPS, due date, custom fields = `lww`; status, notes, assigned to = `manual`.
A conflict only happens when another device changed the same field after the version this device last saw
(`base_version`) to a different value. Different fields always merge.
