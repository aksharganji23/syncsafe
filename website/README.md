# SyncSafe 2.0 — Offline Data Synchronization System (website + server)

SyncSafe is an offline-first app for field teams: inspections, surveys and site visits.
People create and edit records (with photos, GPS and custom form fields) with **no internet**.
When the connection returns, every change syncs with the server and the other devices, text
edits are merged automatically, and a person decides only when two devices changed the same
protected field.

This folder is the **server and website**. The Android app is in the separate
`syncsafe-android-app` folder/zip and uses the same screens.

| Part | Technology |
| --- | --- |
| Server | Node.js 22 + Express 5, REST API + WebSockets (`/api/live`) |
| Database | PostgreSQL. Built in (PGlite, nothing to install) or a real PostgreSQL server via `DATABASE_URL` |
| Website | Progressive Web App: JavaScript modules, IndexedDB (AES-256 encrypted), service worker, Leaflet map |
| Text merge | Yjs CRDT for notes |
| Reports | CSV, Excel (exceljs), PDF (pdfkit) |
| Languages | English, Telugu, Hindi |
| Tests | Node test runner: 52 automated tests, 1,000-cycle durability simulation, 200-device load test |

---

## 1. Run it on your laptop (5 minutes)

### Step 1 — Install Node.js 22 (one time)

Download the **LTS** version from <https://nodejs.org> (22 or newer) and install it.
Check in a terminal (Windows: Command Prompt or PowerShell; Mac: Terminal):

```
node -v      (v22.x.x or newer)
npm -v
```

### Step 2 — Unzip and open the folder

Unzip `syncsafe-website.zip` (for example to your Desktop), then:

```
cd Desktop/syncsafe-website
```

Windows example: `cd %USERPROFILE%\Desktop\syncsafe-website`

### Step 3 — Install and start

```
npm install
npm start
```

You will see:

```
  SyncSafe 2.0.0 is running   (database: built-in PostgreSQL, data/pgdata)
  Open:        http://localhost:3000
  Phone app:   type  http://192.168.1.23:3000  as the Server address   (Wi-Fi)
  Emulator:    type  10.0.2.2:3000  in the Android Studio emulator
  Sample data loaded. Log in as admin@syncsafe.test / Admin@123
```

The first start takes a few seconds longer while the built-in database is created in `data/pgdata`.

### Step 4 — Open it

Open **http://localhost:3000** in Chrome or Edge, click a sample account (**Admin**, **Meera**,
**Asha**, **Ravi** or **Guest**) and **Log in**.

Stop the server with **Ctrl + C**. Your data stays in `data/pgdata`.
`npm run reset` deletes it, so the next start loads the sample data again.

> **Port 3000 busy?** Mac/Linux: `PORT=4000 npm start`. Windows (Command Prompt): `set PORT=4000 && npm start`. PowerShell: `$env:PORT=4000; npm start`.

---

## 2. Sample accounts

**Demo Team** (invite code `DEMO-2026`) — 24 records with GPS pins, assignments, due dates and form fields:

| Name | Role | Email | Password | Can |
| --- | --- | --- | --- | --- |
| Admin User | Admin | admin@syncsafe.test | Admin@123 | everything, including the Admin tab |
| Meera | Supervisor | meera@syncsafe.test | Test@123 | assign, delete, resolve any conflict, see sync health |
| Asha | Field worker | asha@syncsafe.test | Test@123 | create and edit; delete own records |
| Ravi | Field worker | ravi@syncsafe.test | Test@123 | same as Asha |
| Guest | Viewer | guest@syncsafe.test | Test@123 | read only |

**River Valley Clinic** (invite code `RIVER-2026`): nurse@rivervalley.test / Test@123 (admin, 3 records).
It shows that teams are separate: nobody in Demo Team ever sees its records.

Extra data: `sample-data/import-sample.csv` (15 records) and `sample-data/import-with-errors.csv`
(validation test) — Records → **Import CSV**.

---

## 3. Open it from a phone or another laptop on the same Wi-Fi

- **Android app (recommended):** install the APK (see `docs/GITHUB.md` or `docs/ANDROID.md`) and type the
  **Phone app** address the server printed, for example `http://192.168.1.23:3000`.
- **Browser on another device:** SyncSafe encrypts data on the device, and browsers only allow that on
  secure pages. So start the server with HTTPS:

  ```
  npm run start:https
  ```

  Open the `https://192.168.x.x:3000` address it prints, accept the certificate warning once
  (Advanced → Proceed), and log in. `http://localhost` on the laptop itself always works without this.

**Windows firewall:** the first start shows "Allow Node.js on private networks" — click **Allow**.
If you missed it: Windows Security → Firewall → Allow an app → tick Node.js (Private).

---

## 4. A 10-minute demo of everything

Use two windows: Chrome normal window as **Asha**, a Chrome Incognito window (or the phone app) as **Meera**.

| # | What to do | What it shows |
| --- | --- | --- |
| 1 | Both: tick **Simulate offline**. Both edit the **Status** of "Hand pump inspection - Ward 4" to different values and save | Work with no internet; changes wait in the outbox (Sync activity tab) |
| 2 | Asha: untick Simulate offline. Then Meera | Sync on reconnect; Meera gets a **conflict** (status is "a person decides") |
| 3 | Meera: Conflicts tab → **Keep this edit** | Manual resolution; Asha's screen updates within a second (live WebSocket) |
| 4 | Both offline again, both type a different sentence in the **Notes** of one record, reconnect | Admin → Conflict rules → Notes = "Merge both texts automatically" keeps **both** sentences (CRDT) |
| 5 | Edit a record: **Use my location**, **Add photo**, fill **Households affected** and **Ward** | GPS, photos (resumable upload), custom form fields |
| 6 | **Map** tab | Pins by status, red ring = overdue; tap the map to add a record there |
| 7 | Type a title like "Urgent: child injured near well" | ✨ suggested priority with the reason; duplicate warning for similar records |
| 8 | Record → **History** → Restore an old version | Version history and undo |
| 9 | **Reports** → Excel / PDF | Charts and exports |
| 10 | Language menu → తెలుగు / हिन्दी | Translations |
| 11 | Admin → **Fault injection 50%**, keep editing, then switch it off | Retries never lose or duplicate data |
| 12 | Admin → All devices → **Sign out + erase** Meera's window | Remote sign-out and wipe of a lost phone |
| 13 | Reload the page | Unlock screen: data on the device is encrypted with the password |

A longer script with sample text for both devices is in `docs/FEATURES.md`.

---

## 5. Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 3000 | Port to listen on |
| `DATA_DIR` | `./data` | Where the built-in database, the token secret and the HTTPS certificate are kept |
| `DATABASE_URL` | (none) | Use a real PostgreSQL server, e.g. `postgresql://user:pass@localhost:5432/syncsafe`. Several servers can then share it |
| `HTTPS` | (off) | `1` = HTTPS with a self-signed certificate (same as `npm run start:https`) |
| `JWT_SECRET` | random, saved in `data/.jwt-secret` | Secret that signs login tokens. Set it when several servers share one database |
| `ACCESS_TTL_SECONDS` | 900 | Lifetime of an access token (refresh tokens last 30 days) |
| `METRICS_TOKEN` | (none) | Lets Prometheus read `/metrics` from another machine (`Authorization: Bearer <token>`) |
| `FAULT_RATE`, `FAULT_MODE` | 0, before | Start with fault injection on (chaos testing) |

### Using a real PostgreSQL server (optional)

1. Install PostgreSQL 15+ (<https://www.postgresql.org/download/>) and create a database: `createdb syncsafe`.
2. Start SyncSafe with `DATABASE_URL`:
   - Mac/Linux: `DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/syncsafe npm start`
   - PowerShell: `$env:DATABASE_URL="postgresql://postgres:yourpassword@localhost:5432/syncsafe"; npm start`
3. The tables and sample data are created automatically. To run two servers on one database, start a second
   one with another `PORT` and the same `DATABASE_URL` and `JWT_SECRET`: live updates reach devices on both
   (PostgreSQL LISTEN/NOTIFY).

---

## 6. Tests

```
npm test                    52 tests: unit, sync API, features, short durability runs
npm run test:durability     1,000 random offline/online cycles with 30% injected faults
npm run test:load           200 devices push 10 changes each; reports p50/p95 latency
```

Run the tests on a real PostgreSQL server too:
`TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5432/postgres npm test` (each test server gets its own temporary database).

Results and the manual test cases are in `docs/TESTING.md`.

---

## 7. Folder map

```
server/            index.js (start), app.js (routes), sync-service.js (push/pull), conflict.js (rules),
                   auth.js, attachments.js, reports.js, metrics.js, live.js (WebSockets), jobs.js, db.js, schema.js
public/            index.html, css/, js/app.js, js/views/ (one file per tab), js/lang/ (en, te, hi), vendor/
tests/             automated tests, durability simulation (sim.js), load test
docs/              FEATURES, GITHUB, ANDROID, API, PRINCIPLES, TESTING, JIRA_GUIDE
jira/              backlog CSVs to import into Jira (v1 and v2)
sample-data/       seed records and CSV files to import
```

---

## 8. Troubleshooting

| Problem | Fix |
| --- | --- |
| "SyncSafe encrypts your data on this device…" message | You opened `http://192.168.x.x` in a browser. Use `http://localhost:3000` on the laptop, `npm run start:https`, or the app |
| Phone app: "No SyncSafe server answered" | Laptop and phone on the same Wi-Fi; use the **Phone app** address (not 10.0.2.2, not 192.168.56.x); allow Node.js in the firewall; the server is running |
| Map is grey | The background map needs internet; pins still show offline |
| Forgot the password for the data on a device | "Use a different account" on the unlock screen erases the device copy; log in again to download it |
| Start fails after an update | `npm install` again; if the database is from an old test, `npm run reset` |
| `npm install` fails | Node.js must be 22 or newer (`node -v`) |
