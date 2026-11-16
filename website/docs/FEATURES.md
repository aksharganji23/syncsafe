# SyncSafe 2.0 — What is new and how to demonstrate it

Version 1 proved the core: offline edits, an outbox, idempotent sync, version-based conflict detection.
Version 2 implements the "future work" list. This page says, for each idea, **what was built**, **where
the code is**, and **how to show it** in a demo. Ideas that were not built say why.

## Built

| # | Idea | What SyncSafe 2.0 does | Code | Show it |
| --- | --- | --- | --- | --- |
| 1 | Scale the database | PostgreSQL everywhere. Built-in PGlite (nothing to install) or a real server through `DATABASE_URL` | `server/db.js`, `schema.js` | Admin → Sync health → Database tile |
| 2 | Live updates | WebSocket `/api/live`; the server sends "something changed" hints and the device pulls at once | `server/live.js`, `js/sync-engine.js` | Edit on the laptop; the phone list changes within a second (green dot by the status pill) |
| 3 | Several servers | PostgreSQL LISTEN/NOTIFY passes change hints between server instances | `server/bus.js` | Two servers on one `DATABASE_URL` (README §5) |
| 4 | Background sync | Syncs on reconnect (with 0–3 s random jitter), on app resume, on network change and every 30 s while open | `js/sync-engine.js`, `js/native.js` | Turn Wi-Fi off and on with the app open |
| 5 | Tombstone clean-up | Daily job removes old deleted records (retention days per team) and trims logs; devices that missed it re-sync | `server/jobs.js` | Admin → Data clean-up → Run clean-up now |
| 6 | Monitoring | Prometheus `/metrics`, per-minute live charts (latency p50/p95, applied, conflicts, failures) | `server/metrics.js`, `views/admin.js` | Admin → Live charts; open `/metrics` |
| 7 | Smarter text merge (CRDT) | Notes are a Yjs CRDT document: two offline edits merge character by character | `public/js/textcrdt.js`, `sync-service.js` | Admin → Conflict rules → Notes = Merge; both devices edit notes offline |
| 8 | Admin conflict rules | Per field: later save wins / a person decides / merge text | `server/conflict.js` | Admin → Conflict rules |
| 9 | History and undo | Every version saved; restore makes a new version | `record_versions` table, `views/editor.js` | Record → History → Restore |
| 10 | Partial sync | A device keeps all records, only "mine", or one area; out-of-scope records are removed from it | `inScope()` in `sync-service.js`, `views/activity.js` | Sync activity → What this device keeps |
| 11 | HTTPS | `npm run start:https` makes a self-signed certificate | `server/index.js` | Open the https address from another laptop |
| 12 | Encryption on the device | Records, notes, outbox and photos encrypted with AES-256-GCM; key from the password (PBKDF2, 150,000 rounds); unlock screen works offline | `js/secure.js`, `js/store.js` | Reload the page → unlock screen; DevTools → IndexedDB shows only ciphertext |
| 13 | Refresh tokens + remote logout | 15-minute access tokens, rotating 30-day refresh tokens bound to the device, reuse detection; admin can sign out (and wipe) a device | `server/auth.js`, `app.js` | Admin → All devices → Sign out + erase |
| 14 | Roles | Admin, supervisor, field worker, viewer — enforced by the server | `can` in `server/auth.js` | Log in as Guest: read-only banner |
| 15 | Multiple teams | Create a team or join with an invite code; teams are fully separate | `workspaces` table | Log in as nurse@rivervalley.test: only 3 records |
| 16 | Signed release APK | GitHub Actions signs the APK when the key is in GitHub secrets; version code rises every build | `.github/workflows/android.yml`, `android/app/build.gradle` | GitHub → Releases |
| 17 | Photos and attachments | Compressed on the device, saved offline (encrypted), uploaded in 256 KB chunks that resume after a drop, SHA-256 checked | `server/attachments.js`, `js/repository.js` | Add a photo offline, reconnect, open it on the other device |
| 18 | GPS and map | "Use my location" on a record; Map tab with pins coloured by status, red ring for overdue, tap to add | `views/map.js`, `js/native.js` | Map tab |
| 19 | Custom forms | Admin defines extra fields (text, number, date, choice list, yes/no, required) | `sanitizeCustomFields` in `conflict.js`, `views/admin.js` | Admin → Custom form fields → Add field |
| 20 | Assignment, due dates, notifications | Assign + due date; bell with unread count; phone notification in the background; hourly due reminders | `server/jobs.js`, `app.js` | Meera assigns a record to Asha → Asha's bell |
| 21 | Reports and export | Charts by status/priority/assignee, 14-day trend, overdue list; CSV, Excel (2 sheets), PDF | `server/reports.js`, `views/reports.js` | Reports → Excel |
| 22 | Voice notes | Dictate button (Web Speech API) in Chrome/Edge in English, Telugu or Hindi; on Android the keyboard microphone | `js/native.js` | Editor → Dictate |
| 23 | Telugu, Hindi, English | Every screen translated; a test fails if any text is missing | `js/lang/`, `tests/unit.test.js` | Language menu |
| 24 | AI-style auto-categorise | Rule-based (no paid service): keyword rules suggest priority and status and show the reason | `public/js/ai.js` | Type "Urgent: injured child" in a title |
| 25 | Duplicate detection | Warns when a similar title/location exists or a record is within 100 m | `findDuplicates` in `ai.js` | Create "Hand pump inspection ward 4" |
| 26 | Conflict suggestions | The Conflicts screen proposes a combined text (all sentences, near-duplicates removed) | `suggestMerge` in `ai.js` | Conflicts → Combine… |

## Not built (and why)

| Idea | Reason |
| --- | --- |
| iOS app | Needs a Mac with Xcode and an Apple developer account. The Capacitor project can add iOS later with `npx cap add ios` |
| Play Store publishing | Needs a paid Google Play developer account and store listing. The signed release APK is the input it would use |
| Peer-to-peer sync (phone to phone without the server) and vector clocks | Needs Bluetooth/Wi-Fi Direct native code and a different consistency model; server-ordered versions plus CRDT notes cover the project's goals |
| Sync while the app is fully closed | Android stops the WebView; it needs a native background worker and native storage. SyncSafe syncs the moment the app opens or resumes |
| Paid AI models | Replaced by explainable keyword rules that work offline and cost nothing |
| Grafana | Replaced by built-in charts; `/metrics` is ready if a Prometheus + Grafana stack is added |

## Two-device demo script (sample data)

Laptop browser = **Asha** (field worker). Phone app or Incognito window = **Meera** (supervisor).

1. **Live sync.** Meera creates "Streetlight out — Ward 3", location "Main Rd near bus stop", priority High.
   It appears on Asha's screen within a second.
2. **Offline + outbox.** Both tick *Simulate offline* (phone: airplane mode).
   - Asha opens "Hand pump inspection - Ward 4": status **Visited**, notes add "Handle replaced."
   - Meera opens the same record: status **Closed**, notes add "Water pressure normal now."
   - Sync activity tab shows the waiting changes on each device.
3. **Reconnect.** Asha first, then Meera. Status was changed on both → **conflict** for Meera.
   Notes: with the default rule, also a conflict; switch Admin → Conflict rules → Notes = *Merge both texts
   automatically* beforehand and both sentences survive instead.
4. **Resolve.** Meera → Conflicts → *Keep this edit* (or *Combine…*). Asha's screen updates.
5. **Photo + GPS.** Asha offline: edit the record, *Use my location*, *Add photo*. Reconnect; Meera opens the
   photo. Map tab shows the pin.
6. **Assignment.** Meera assigns "Streetlight out — Ward 3" to Asha with a due date of yesterday → Asha's bell
   shows it; Reports shows it in Overdue.
7. **Undo.** Asha → History → restore version 1.
8. **Reports.** Meera → Reports → PDF.
9. **Safety.** Admin → Fault injection 50%; make three edits; switch it off; nothing lost, nothing doubled
   (Sync activity shows "Duplicates ignored").
10. **Lost phone.** Admin → All devices → *Sign out + erase* the phone; the phone returns to the login screen.
