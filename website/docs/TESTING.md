# SyncSafe — Test Plan and Test Cases

SyncSafe is tested at five levels. The automated suites run with one command each; the manual cases
below are what you run (and screenshot) for the sprint reviews and the final demo.

## 1. Automated tests

| Level | Command / file | What it proves |
| --- | --- | --- |
| Unit | `tests/unit.test.js` (13 tests) | Conflict planning for every rule, custom-field and rule sanitising, outbox coalescing, diff, validation, backoff, CSV, rule-based suggestions and duplicate detection, CRDT merge in any order, LAN address ordering, **every English text has a Telugu and Hindi translation with the same placeholders** |
| Integration | `tests/sync-api.test.js` (16 tests) | Real HTTP server + PostgreSQL: login, push, pull with cursor, idempotent retries (also the same op twice in one batch), merge, conflict + resolve, edit-vs-delete, validation, batch limit, fault injection before/after processing, CORS |
| Features | `tests/features.test.js` (20 tests) | Refresh-token rotation and reuse detection, remote sign-out + wipe, roles, new team + invite code, CRDT notes merge, rule "later save wins", custom fields, history + restore, partial sync and eviction, clean-up + forced resync, chunked photo upload with resume and checksum, notifications, reports + CSV/Excel/PDF, Prometheus metrics, WebSocket live hint |
| Durability (short) | `tests/durability.test.js` | 3 × 150 random cycles, 4 devices, 30% faults: every device ends identical to the server |
| Durability (full) | `npm run test:durability` | 1,000 random cycles of offline edits, reconnects and dropped requests/replies |
| Load | `npm run test:load` | 200 devices, each waits a random 0–3 s (the app's reconnect jitter) then pushes 10 operations |
| Browser (manual + scripted) | section 2 | Two-device scenarios in real Chrome windows / the phone |

`npm test` runs **52 tests** and must show `# fail 0`. It runs on the built-in database by default; with
`TEST_DATABASE_URL=postgresql://user:pw@host:5432/postgres` every test server gets its own temporary database on
a real PostgreSQL server. GitHub Actions runs both (`.github/workflows/ci.yml`) on every push.

To replay a failing durability run exactly, use the seed it prints: `node tests/durability-run.js 1000 <seed>`.

### Results recorded while building (Linux, 2 vCPU, Node 22)

| Test | Built-in PostgreSQL (PGlite) | PostgreSQL 18 server |
| --- | --- | --- |
| `npm test` | 52 passed, 0 failed | 52 passed, 0 failed |
| Durability, 1,000 cycles (seed 2026) | PASS: 57 injected faults, 97 duplicate retries ignored, 0 lost, 0 applied twice | — |
| Load, 200 devices × 10 operations, 0–3 s jitter | p50 446 ms, p95 2,644 ms (above target) | **p50 70 ms, p95 280 ms (meets the 500 ms target)**, 0 errors |
| Load, all 200 at the same instant (`JITTER_MS=0`) | requests queue; p95 several seconds | p95 about 3 s |

### Load test: what the numbers mean

- The **built-in database** (PGlite) is PostgreSQL compiled to WebAssembly running inside the Node.js process:
  one connection, one query at a time. Perfect for a laptop demo with a few phones; about 400 operations per
  second. When 200 devices arrive together, requests wait in a queue, so p95 grows.
- A **real PostgreSQL server** (`DATABASE_URL`) runs queries in parallel over a connection pool and meets the
  target. More Node.js servers can share it (LISTEN/NOTIFY keeps live updates working), so the design scales out.
- Speed-ups made in v2: one database round trip per write (change-log insert + record update in one SQL statement),
  one query to find already-applied operations for the whole batch, and savepoints only when a batch hits an error.
- The app adds 0–3 s of random jitter before the first sync after reconnecting, so a cell tower coming back does
  not make every phone sync in the same millisecond. `JITTER_MS=0 npm run test:load` shows the worst case.

## 2. Manual test cases

Fill in **docs/test-case-tracker.csv** (opens in Excel or Google Sheets) with your actual results.
"Two devices" means a normal Chrome window and an Incognito window side by side (separate local storage), or the laptop and the phone app.
Story IDs US1–US20 are the version 1 backlog; SS-201 to SS-226 are the row IDs in `jira/syncsafe-v2-backlog.csv` (replace them with the keys Jira gives after import).

| ID | Story | Test | Steps | Expected result |
| --- | --- | --- | --- | --- |
| TC-01 | US3 | Log in with a sample account | 1. Open http://localhost:3000<br>2. Click Asha<br>3. Click Log in | Records screen opens, 24 sample records listed, status pill shows "All changes synced" |
| TC-02 | US3 | Wrong password is rejected | 1. Enter asha@syncsafe.test with password wrong123<br>2. Log in | Red message "Wrong email or password"; stays on login screen |
| TC-03 | US3 | Join a team with the invite code | 1. Click "Join a team"<br>2. Enter name, new email, 6+ char password, invite code DEMO-2026<br>3. Join | Logged in as a field worker; sees Demo Team's records |
| TC-04 | US4 | Create a record online | 1. + New record<br>2. Title "Test pump"<br>3. Save | Record appears with "Synced" tag within 2 s; visible on a second device after Sync now |
| TC-05 | US4 | Empty title is blocked | 1. + New record<br>2. Leave title empty, fill notes<br>3. Save | Save is blocked; nothing added to the outbox |
| TC-06 | US5 | Search and filter | 1. Type "bridge" in search<br>2. Choose status Follow-up | Only matching records shown; count line updates |
| TC-07 | US6 | App opens with no network | 1. Stop the server (Ctrl+C) or turn Wi-Fi off<br>2. Reload the page | App loads from cache; records still listed; orange offline banner |
| TC-08 | US7 | Offline edits survive a reload | 1. Create a record and edit another<br>2. Reload the page | Both changes still shown with "Not synced" tag |
| TC-09 | US8 | Changes are queued in the outbox | 1. Make 2 changes<br>2. Open Sync activity | Outbox table lists 2 operations with type, record and changed fields |
| TC-10 | US9 | Offline banner appears | 1. Tick Simulate offline (or DevTools Network Offline) | Banner "You are offline" and pill "Offline" appear within 2 s |
| TC-11 | US10 | Automatic sync on reconnect | 1. Untick Simulate offline | Outbox empties within 5 s; records turn Synced; no manual action needed |
| TC-12 | US11 | Changes arrive from another device | 1. Device 2 edits a record<br>2. Watch Device 1 | Device 1 shows Device 2's change within about a second (live update) |
| TC-13 | US12 | Retries never create duplicates | 1. Admin: failure rate 50%, mode After processing, Apply<br>2. On a field worker device go offline, create 5 records, reconnect<br>3. Wait until synced<br>4. Set failure rate Off | Exactly 5 new records on every device; Admin "Duplicates ignored" count above 0 |
| TC-14 | US13 | Sync status badges | 1. Go offline, edit a record<br>2. Reconnect | Tag goes Not synced → Synced; pill shows waiting count while offline |
| TC-15 | US14 | Different fields merge automatically | 1. Device 1 offline: change Priority of record X<br>2. Device 2 online: change Location of record X<br>3. Device 1 reconnects | Record X has both the new Priority and the new Location on both devices; no conflict |
| TC-16 | US15 | Edit wins over delete | 1. Device 1 offline: edit Notes of record Y<br>2. Device 2 online: delete record Y<br>3. Device 1 reconnects | Record Y comes back with Device 1's notes and a "Restored" tag on both devices |
| TC-17 | US16 | Manual conflict resolution | 1. Device 1 offline: change Notes of record Z<br>2. Device 2 online: change Notes of record Z<br>3. Device 1 reconnects<br>4. Open Conflicts, choose Combine, edit, Save combined version | Conflict shows both versions side by side; after saving, both devices show the combined notes |
| TC-18 | US17 | Open conflicts are counted | 1. Look at the Conflicts tab | Red badge shows the number of open conflicts; disappears after resolving |
| TC-19 | US18 | Sync history | 1. Open Sync activity | History table lists recent pushes/pulls with counts per device |
| TC-20 | US19 | Admin dashboard is admin-only | 1. Log in as Asha: no Admin tab<br>2. Log in as Admin: open Admin | Asha has no Admin tab (API returns 403); Admin sees tiles, devices, last 7 days |
| TC-21 | US20 | Load test | 1. Run npm run test:load | 0 errors; record p50/p95 (target p95 < 500 ms) |
| TC-22 | US7 | CSV import with validation | 1. Import sample-data/import-sample.csv<br>2. Import sample-data/import-with-errors.csv | First: 15 imported. Second: 3 imported, 4 skipped with reasons listed |
| TC-23 | US7 | Logout warns about unsynced changes | 1. Make a change<br>2. Click Log out | Warning shows the number of unsynced changes; Cancel keeps you logged in with data intact |
| TC-24 | US10 | Server reset is detected | 1. Stop server, npm run reset, npm start<br>2. Click Sync now | Message "The server was reset, so this device cleared its data. Log in again."; after login the fresh 24 records show |
| TC-25 | US12 | Durability test | 1. Run npm run test:durability | PASS: every device matches the server; 0 records lost; 0 operations applied twice |
| TC-26 | US16 | Edit the same notes back and forth on phone and laptop | 1. Both online: laptop edits Notes, phone edits Notes of the same record within a few seconds<br>2. Repeat 3 times without resolving<br>3. Laptop edits once more, then phone clicks Keep this edit | Only one open conflict card; it shows the newest values; step 3 shows "record changed again" and the latest version instead of overwriting it |
| TC-27 | SS-201 | Built-in vs real PostgreSQL | 1. `npm start` → Admin → Database tile<br>2. Start with DATABASE_URL (README §5) | Tile shows PGlite, then PostgreSQL; sample data loads in both |
| TC-28 | SS-202 | Live update | 1. Two windows side by side<br>2. Edit a record in one | Other window updates within 1 s without Sync now; green live dot visible |
| TC-29 | SS-204 | Clean-up forces resync | 1. Admin → retention 1 day<br>2. Delete a record; wait / run clean-up<br>3. A device that was offline reconnects | That device downloads everything again and matches the server |
| TC-30 | SS-205 | Live charts and /metrics | 1. Admin → Live charts<br>2. Open http://localhost:3000/metrics | Charts show the last 60 minutes; metrics page lists syncsafe_* counters |
| TC-31 | SS-206 | Stay logged in | 1. Set ACCESS_TTL_SECONDS=30 and restart<br>2. Use the app for 2 minutes | No logout; requests keep working (token refreshed automatically) |
| TC-32 | SS-207 | Remote sign-out + erase | 1. Admin → All devices → Sign out + erase the Incognito window's device | That window returns to login within 30 s; its records are gone |
| TC-33 | SS-208 | Viewer is read-only | 1. Log in as Guest<br>2. Try to edit | Read-only banner; no Save or New record buttons; API returns 403 if forced |
| TC-34 | SS-209 | Separate teams | 1. Log in as nurse@rivervalley.test | Only 3 River Valley records; none from Demo Team |
| TC-35 | SS-210 | Encrypted on the device | 1. Reload the page<br>2. Enter the wrong password, then the right one<br>3. DevTools → Application → IndexedDB → syncsafe-v2 | Wrong password refused; right one unlocks offline; stored values are unreadable ciphertext |
| TC-36 | SS-212 | Photo upload resumes | 1. Offline: add a 3 MB photo<br>2. Admin fault 50% after processing<br>3. Reconnect, wait, fault off | Photo reaches the server once and opens on the other device; Sync activity shows its progress |
| TC-37 | SS-213 | GPS and map | 1. Editor → Use my location<br>2. Map tab<br>3. Tap the map → New record here | Pin at your location coloured by status; new record has those coordinates |
| TC-38 | SS-214 | Custom form fields | 1. Admin → Add field "Water source" (choice list: Well, Tap)<br>2. Mark required, save<br>3. New record without it | Save blocked with "Water source is required"; the field appears in the Excel export |
| TC-39 | SS-216 | Assignment and overdue | 1. Meera assigns a record to Asha, due yesterday | Asha's bell shows it; record shows "overdue" in red; Reports lists it |
| TC-40 | SS-218 | Exports | 1. Reports → CSV, Excel, PDF | Three files download (phone: share sheet); Excel has Summary and Records sheets |
| TC-41 | SS-219 | History and undo | 1. Edit a record twice<br>2. History → restore version 1 | New version with version 1's values on both devices |
| TC-42 | SS-220 | Partial sync | 1. Sync activity → Keep "Assigned to me" → Apply | Only records assigned to or created by you remain on that device |
| TC-43 | SS-222 | Notes merge (CRDT) | 1. Admin → Notes rule = Merge<br>2. Both devices offline type different sentences in the same notes<br>3. Both reconnect | Both sentences present on both devices; no conflict card |
| TC-44 | SS-223 | Suggestions and duplicates | 1. New record titled "Urgent: injured child"<br>2. New record titled "Hand pump inspection Ward 4" | ✨ suggests High priority with the reason; duplicate warning names the existing record |
| TC-45 | SS-226 | Languages | 1. Switch to తెలుగు then हिन्दी | Every label, button and message changes language |
| TC-46 | SS-224 | GitHub build | 1. Push to main<br>2. Actions → both workflows green<br>3. Releases → latest | SyncSafe.apk and two zips attached; APK installs over the previous build |

## 3. Defect log template

| Bug ID | Found in test | Severity (High/Medium/Low) | Steps to reproduce | Expected | Actual | Jira key | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BUG-01 | | | | | | | |
