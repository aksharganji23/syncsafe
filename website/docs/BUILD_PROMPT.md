# Prompt used to build SyncSafe (for Claude on claude.ai)

> This is the prompt that built **version 1** (SQLite). Version 2 moved to PostgreSQL and added the features in `docs/FEATURES.md`; keep this page as a record of how the project started.

Paste everything inside the box into a new Claude chat. Attach your project proposal if you have one.

```
<context>
I am a university student in a Software Engineering and System Design course. My semester project is
SyncSafe, an offline data synchronization system, run with Agile + Scrum over six two-week sprints.
These decisions are final; build on them and do not swap technologies:
- Domain: field data-collection records with fields title (required, ≤120 chars), location (≤120),
  status (Pending | Visited | Follow-up | Closed), priority (Low | Medium | High), notes (≤2000).
- Frontend: Progressive Web App in plain HTML, CSS and ES modules, no build step. IndexedDB holds local
  data; a service worker caches the app shell so it opens with no network.
- Backend: Node.js 20+ with Express. SQLite through sql.js (pure WebAssembly, nothing native to install),
  saved to data/syncsafe.db with atomic writes.
- Sync: transactional outbox on the device (record + outbox entry in one IndexedDB transaction).
  POST /api/sync/push takes batches of at most 100 operations {op_id, record_id, type, fields, base_version};
  the server deduplicates by op_id. GET /api/sync/pull?cursor=N&limit=500 returns changes after a
  server-assigned sequence, including tombstones. Ordering uses server versions, never device clocks.
- Conflicts: different fields merge automatically; same title/location/priority = last write wins;
  same status/notes = manual side-by-side resolution (keep mine / keep theirs / combine);
  edit beats delete (record restored and flagged). A device never conflicts with its own edits.
- Auth: bcrypt password hashes, JWT bearer tokens valid 7 days, roles member and admin.
</context>

<task>
Build the complete, working project from an empty folder and give it to me as one downloadable zip.
The zip MUST contain:
1. The full-stack app: login/register, record list with search and filters, create/edit/delete,
   online/offline banner, sync status pill, "Simulate offline" switch, "Sync now", conflicts screen,
   sync activity (outbox + history), admin dashboard (devices, conflict counts, daily stats) and an
   admin fault-injection control (fail X% of sync requests before or after processing).
2. Sample data: auto-seeded accounts (admin@syncsafe.test / Admin@123, asha@syncsafe.test / Test@123,
   ravi@syncsafe.test / Test@123), 24 seeded records, a 15-row import CSV, and a CSV with deliberately
   invalid rows. Include a CSV import button in the app and `npm run reset`.
3. Tests runnable with `npm test` (Node's built-in test runner, no extra framework): unit tests for the
   conflict rules and outbox merging, HTTP integration tests (idempotent retry, merge, conflict + resolve,
   edit vs delete, validation, admin-only), and a seeded randomized durability simulation (several virtual
   devices, random offline edits, injected faults) that asserts every device ends identical to the server
   and no op_id is applied twice. Add `npm run test:durability` (1,000 cycles) and `npm run test:load`
   (200 devices pushing at once, prints p50/p95).
4. Documents in docs/: README.md run guide for a beginner on Windows and Mac (install Node, unzip,
   npm install, npm start, two-device demo using a normal + Incognito window, troubleshooting);
   TESTING.md with a test plan and 25 manual test cases mapped to user stories, plus the same cases as
   test-case-tracker.csv with empty Actual/Status columns; JIRA_GUIDE.md explaining step by step how to
   create a Scrum space, add epics and user stories (template, acceptance criteria, story points), import
   the backlog, plan and start sprints, use the board, log bugs, and read burndown/velocity reports;
   jira/syncsafe-jira-import.csv with 5 epics and 20 stories (Work item ID, Work type, Summary,
   Description, Priority, Labels, Story Points, Parent; epics listed first); PRINCIPLES.md listing each
   software engineering principle and system design principle used, with the file where it appears;
   API.md. Also include a Dockerfile, docker-compose.yml and a GitHub Actions workflow that runs the tests.
</task>

<constraints>
- Every claim in the docs MUST match the code. Use the current Jira Cloud terms (space, work item,
  work type) and say that older tutorials call them project, issue and issue type.
- Keep dependencies to express, sql.js, bcryptjs and jsonwebtoken. No front-end framework.
- Put the conflict rules in pure functions (no HTTP, no SQL) so they can be unit tested.
- Never put real secrets in the code; generate the JWT secret into data/ or read JWT_SECRET.
- Do not add features I did not list.
</constraints>

<verification>
Before you give me the zip, actually run: npm install, npm test, npm run test:durability, npm run
test:load, then start the server and drive the offline flow in a headless browser if one is available
(go offline, create and edit, reconnect, resolve a conflict). Fix anything that fails. Report the real
numbers you measured; if a target (for example p95 < 500 ms) is missed, say so and explain why instead of
changing the test.
</verification>

<output_format>
1. The zip file (without node_modules or data/).
2. A short summary: what is in the zip, the commands to run it, and the measured test results.
3. Any limitation you found, in one or two lines.
</output_format>
```
