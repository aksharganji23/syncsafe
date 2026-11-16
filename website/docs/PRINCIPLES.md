# Software Engineering and System Design Principles in SyncSafe

Each principle below names **where it is in the code**, so you can point to it in the report, the viva or the demo.

---

## Part A — Software engineering principles

### A1. Agile + Scrum lifecycle (iterative, incremental delivery)
Six two-week sprints, each ending in working software (see `docs/JIRA_GUIDE.md`). The order is chosen to
reduce risk: a working online app first, then offline storage, then sync, then conflicts, then hardening.
Each sprint's increment is demoable on its own.

### A2. Requirements engineering with measurable targets
Functional requirements are user stories with acceptance criteria (`jira/syncsafe-jira-import.csv`).
Non-functional requirements have numbers, so they can be tested, not argued about:

| Requirement | Target | Verified by |
| --- | --- | --- |
| Durability | 0 records lost in 1,000 random offline/online cycles | `npm run test:durability` |
| Correctness | 0 duplicates when requests are retried | `tests/sync-api.test.js` (idempotency tests) |
| Offline capacity | Works offline after one online visit | TC-07, `public/sw.js` |
| Scalability | 200 devices at once, p95 < 500 ms | `npm run test:load` |
| Security | Hashed passwords, expiring tokens, admin-only routes | `server/auth.js`, TC-20 |

**Traceability:** every user story (US1–US20) maps to manual test cases (TC-01–TC-25 in
`docs/test-case-tracker.csv`) and to automated tests.

### A3. Modularity and separation of concerns (layered architecture)

```
Browser / Android app                             Server
UI (app.js, views/*.js)                           HTTP routes (app.js) + WebSockets (live.js)
  ↓                                                 ↓
Repository (repository.js)                        Sync service (sync-service.js), attachments.js
  ↓                                                 ↓
Encrypted store (store.js, secure.js)             Conflict rules (conflict.js)
  ↑  Sync engine → API (sync-engine.js, api.js) →   ↓
                                                  Database adapter (db.js) → PGlite or PostgreSQL
```

Each layer only talks to the one below it. The UI never calls `fetch` for data; the conflict rules never
touch HTTP or SQL. That is **high cohesion** (each file does one job) and **low coupling** (files depend on
small, stable interfaces).

### A4. SOLID principles
- **Single responsibility:** `auth.js` only does passwords and tokens; `conflict.js` only decides conflicts;
  `db.js` only does storage.
- **Open/closed:** conflict behaviour is driven by data (`MANUAL_FIELDS` in `conflict.js`). Making `priority`
  a "human decides" field is a one-word change, with no new `if` statements across the code.
- **Dependency inversion:** the UI depends on the repository abstraction ("save this record"), not on the
  network. That is why the app behaves the same online and offline.

### A5. Design patterns used

| Pattern | Where | Why |
| --- | --- | --- |
| **Repository** | `public/js/repository.js` | Hides local-vs-remote storage from the UI |
| **Command / Outbox** | outbox store; `coalesce()` in `core.js` | Each change is an operation object that can be queued, merged, retried and audited |
| **Observer** | `SyncEngine extends EventTarget` (`status`, `changed`, `notice` events) | UI updates when sync state changes without the engine knowing about the UI |
| **Strategy** | `planOperation()` in `server/conflict.js` | Picks merge, last-write-wins, manual or restore per situation |
| **Facade** | `Api` class in `public/js/api.js` | One place for tokens, device headers, timeouts and offline simulation |
| **Idempotent receiver** | `applied_ops` table in `sync-service.js` | The same message processed twice has the effect of once |
| **Retry with exponential backoff** | `backoffDelay()` in `core.js` | Recovers from failures without overloading the server |
| **Unit of Work / Transaction** | `db.transaction()`, IndexedDB `tx()` | Several writes succeed or fail together |

### A6. DRY, KISS and YAGNI
- **DRY:** `public/js/core.js` (outbox merging, validation, backoff, CSV) is used by both the browser and the
  Node tests, so there is one implementation of each rule.
- **KISS:** no front-end framework or build step; plain ES modules run directly in the browser.
- **YAGNI:** CRDT text merging, native apps and end-to-end encryption were left out of scope on purpose.

### A7. Defensive programming and validation at every boundary
Inputs are validated on the client (fast feedback) **and** on the server (`validateFields()`), because the
server must never trust a client. Batch size and pull size are capped (100 / 500). Unknown fields are rejected.

### A8. Testing strategy (test pyramid) and continuous integration
Many fast unit tests of pure functions, fewer integration tests through real HTTP, and a small number of
expensive randomized and load tests (`docs/TESTING.md`). Pure functions (`planOperation`, `coalesce`) were
designed so they can be tested without a browser or a database. GitHub Actions (`.github/workflows/ci.yml`)
runs everything on every push.

### A9. Version control, code review and Definition of Done
Feature branches named after Jira keys, pull requests reviewed before merge, and a shared Definition of Done
(code reviewed, tests passing, works offline, acceptance criteria verified, docs updated).

### A10. Configuration and security basics
Settings come from environment variables (`PORT`, `DATA_DIR`, `JWT_SECRET`, `FAULT_RATE`), not code.
Passwords are hashed with bcrypt; tokens expire after 7 days; admin routes check the role (least privilege);
no secrets are committed (the JWT secret is generated into `data/`, which is in `.gitignore`).

### A11. Maintainability and documentation
Schema in one place (`db.js`), comments that explain *why*, an API reference (`docs/API.md`), a run guide
(`README.md`) and Architecture Decision Records in the proposal.

---

## Part B — System design principles

### B1. Offline-first (local-first) architecture
The device's own database is the primary copy for the user; the network is an optimisation. Every read and
write goes to IndexedDB first (`repository.js`), and the service worker (`sw.js`) caches the app itself.
Result: no screen ever waits on the network.

### B2. CAP theorem: choosing availability under partition
Being offline *is* a network partition. SyncSafe chooses **Availability + Partition tolerance (AP)**: users
keep working during the partition, and consistency is restored afterwards. A bank transfer would choose
consistency instead; field notes are a good fit for AP.

### B3. Eventual consistency and convergence
After everyone reconnects and syncs, every device holds exactly the server's data. The durability test
checks precisely this: all devices match the server field by field, after 1,000 random cycles with failures.

### B4. Optimistic concurrency control with version numbers
No locks. Each operation carries the `base_version` it was made from. The server compares it with per-field
version metadata (`field_meta`) to see who changed what since. Optimistic control fits offline work, where
holding a lock for days is impossible.

### B5. Logical clocks instead of wall clocks
Device clocks drift and can be set wrong, so ordering never relies on device timestamps. The server assigns
record versions and a global change sequence (`change_log.seq`), which is what pull cursors use.

### B6. Conflict resolution strategies (and why each)

| Situation | Strategy | Reason |
| --- | --- | --- |
| Different fields edited | Field-level merge | Nothing is actually in conflict; keep both |
| Same `title` / `location` / `priority` | Last-write-wins (server arrival order) | Low cost if the earlier value is lost |
| Same `status` / `notes` | Manual resolution (side-by-side screen) | Losing either edit could matter |
| Edit vs delete | Edit wins, record restored and flagged | Losing work is worse than an extra record |
| Same device, sequential edits | Never a conflict | A device cannot conflict with itself |
| Both set the same value | Not a conflict | Same outcome either way |

### B7. Idempotency and delivery guarantees
The network can deliver a request and lose the reply. So the client sends **at-least-once** (it retries until
it gets an answer) and the server **deduplicates** by `op_id` (`applied_ops` table, unique key). Together this
gives *effectively-once* processing. The "After processing" fault mode tests the hardest case directly.

### B8. Transactional outbox pattern
The record change and its outbox entry are written in **one local transaction** (`repository.js`), so the app
can never save a change and forget to sync it, or sync a change that was not saved. Outbox entries are deleted
only after the server answers.

### B9. Delta sync with cursor-based pagination
Devices download only what changed since their cursor (`GET /api/sync/pull?cursor=N&limit=500`), not the
whole database. Pages are bounded, and `hasMore` tells the client to keep going. Cursor pagination stays
correct while new writes arrive, unlike page-number pagination.

### B10. Soft deletes (tombstones)
Deleted records stay as `is_deleted = 1`, so other devices learn about deletions when they pull. A hard delete
would simply vanish, and offline devices would keep the record forever.

### B11. Client-generated identifiers (UUIDs)
Records and operations get UUIDs on the device, so they have permanent IDs while offline with no risk of
clashing with another device's IDs.

### B12. Reliability engineering
- **Retries with exponential backoff and jitter** (`backoffDelay`): 1 s, 2 s, 4 s … 60 s plus random jitter,
  so thousands of devices reconnecting together do not hit the server at the same instant (the *thundering herd*).
- **Timeouts** on every request (`api.js`), so a hung connection cannot freeze sync.
- **Atomic file writes:** the database is written to a temporary file and renamed (`db.js`), so a crash never
  leaves a half-written database.
- **Savepoints:** each operation in a batch is isolated; one bad operation cannot corrupt the others.
- **Server reset detection:** `instanceId` lets devices notice a fresh database and resynchronise cleanly.

### B13. Chaos engineering and observability
The admin can make the server fail a share of requests on purpose (`POST /api/admin/fault`), before or after
processing. `sync_events` records pushes, pulls, conflicts, rejections, duplicates and injected failures,
shown in the Admin dashboard and each user's sync history.

### B14. Scalability: batching, limits, statelessness and bottlenecks
- Pushes are batched (up to 100 operations, one transaction per batch).
- The API is **stateless** (JWT carries the identity), so more server instances could be added behind a load balancer.
- Version 2 took the scale-out step: PostgreSQL (`DATABASE_URL`) with several API instances sharing it.
  The built-in PGlite (one connection) handles about 400 operations per second; a PostgreSQL server meets the
  200-device p95 target. Idempotency and versioning do not depend on which server handles a request
  (`docs/TESTING.md`, "Load test").

### B15. Caching
The service worker uses *network-first, cache fallback* for the app shell: online users always get the newest
code; offline users get the cached copy. API responses are deliberately **not** cached; data lives in IndexedDB.

### B16. Security design
Authentication (bcrypt + JWT), authorisation (team scoping on every query, admin-only routes), input
validation, request size limits, and tokens long-lived enough (7 days) for offline work. If a token expires
offline, sync pauses but the outbox is kept until the user logs in again; it is never discarded.

---

## Part C — What version 2 adds

### C1. Hybrid conflict resolution: rules for fields, a CRDT for text
Structured fields (status, assignee) keep version-based detection with per-field rules chosen by the admin
(`lww`, `manual`); free text (notes) can use a **CRDT** (Yjs) so concurrent edits merge character by character
and converge in any order. This is the "right tool per data type" principle.
Code: `server/conflict.js` (`planOperation`, `ruleFor`), `public/js/textcrdt.js`, `resolveNotes()` in `server/sync-service.js`.

### C2. Event-driven push on top of pull (WebSockets + LISTEN/NOTIFY)
The server pushes a small *hint* ("something changed"); the device still fetches data through the normal,
idempotent pull. Hints can be lost without harm, so the design stays correct with or without the socket.
PostgreSQL LISTEN/NOTIFY fans the hint out to every server instance (publish/subscribe).
Code: `server/live.js`, `server/bus.js`.

### C3. Horizontal scalability with a stateless API
Any server instance can handle any request: tokens are self-contained (JWT), operations are idempotent,
and all state lives in PostgreSQL. Measured: the real-PostgreSQL configuration meets the 200-device p95
target (docs/TESTING.md). The **adapter pattern** in `server/db.js` hides PGlite vs `pg`.

### C4. Defence in depth for security
- **Short-lived access tokens + rotating refresh tokens** with reuse detection (`server/auth.js`).
- **Role-based access control** checked on the server for every operation (`can.*`).
- **Multi-tenancy**: every query is scoped by `workspace_id`.
- **Encryption at rest on the device**: AES-256-GCM, key derived with PBKDF2 (150,000 iterations); the key
  never leaves the device (`public/js/secure.js`, `store.js`).
- **Remote revoke and wipe** for lost devices; **HTTPS** option; refresh tokens stored only as SHA-256 hashes.

### C5. Resumable, verifiable transfers
Photos upload in 256 KB chunks; the server reports how much it has (`received`), so an interrupted upload
resumes instead of restarting; a SHA-256 checksum proves integrity end to end (`server/attachments.js`).

### C6. Data lifecycle: retention and compaction
Tombstones are needed only until every device has seen them. A daily job removes them after the team's
retention period, trims the change log and old versions, and records a `compactedThrough` watermark; a device
whose cursor is older is told to **resync** — the same "snapshot + log" idea databases use (`server/jobs.js`).

### C7. Observability
RED metrics (rate, errors, duration) per route, sync results per minute and Prometheus exposition
(`server/metrics.js`); the admin sees live charts; every push records its latency (`sync_events`).

### C8. Event sourcing light: version history
Every write stores an immutable snapshot (`record_versions`). Undo is a **new** write of an old snapshot,
so history is never rewritten and undo itself syncs and can be undone.

### C9. Partial replication
Each device declares a scope (all / mine / area); the server filters pulls and tells devices to evict records
that left the scope — selective replication as used by mobile databases (`inScope()` in `sync-service.js`).

### C10. Internationalisation and accessibility
All user-visible text lives in language files (`public/js/lang/`); a unit test proves Telugu and Hindi have
every key with the same placeholders. Labels, `aria-label`s and keyboard focus styles are kept.

### C11. Explainable "AI" without a model
Suggestions (priority, status, duplicates, merged text) come from transparent rules and similarity measures
(Jaccard similarity, distance in metres) that run offline and always show **why** (`public/js/ai.js`).
KISS and YAGNI: no paid service, no data leaves the device.

### C12. Continuous integration and delivery
GitHub Actions runs the test suite against both databases on every push, builds the APK, signs release
builds from secrets, publishes a release and smoke-tests the APK on an emulator (`.github/workflows/`).
Build numbers come from the pipeline so every APK upgrades the previous one.

---

## Trade-offs to discuss in the viva

| Decision | Chosen | Alternative | Why |
| --- | --- | --- | --- |
| Consistency model | Eventual (AP) | Strong (CP) | Users must work offline |
| Conflict handling | Per-field rules (admin-chosen) + CRDT for notes | CRDTs for everything | Records are forms; a CRDT fits free text, rules fit status/assignee where a person should decide |
| Ordering | Server versions + sequence | Device timestamps / vector clocks | Device clocks are untrustworthy; a central server makes versions simple |
| Database | PostgreSQL: built-in PGlite or a server | SQLite | Same SQL from laptop demo to scale-out; PGlite keeps zero install |
| Frontend | Plain JS modules | React | No build step; the sync engine is the focus |
| Delete | Tombstones | Hard delete | Deletions must sync to offline devices |
| Live updates | WebSocket hints + pull | Send full data over the socket | Hints can be lost safely; one code path for data |
| Device encryption | Password-derived key | Key stored on the device | A stolen phone cannot decrypt; cost: unlock with the password after a restart |
| Background sync | On open/resume/network change | Native background worker | Works with the shared web code; fully closed app waits until opened |
