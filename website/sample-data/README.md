# Sample data for testing

| File | What it is | How to use it |
| --- | --- | --- |
| `seed-records.json` | 24 field records loaded automatically the first time the server starts | Nothing to do. Run `npm run reset` to reload them. |
| `import-sample.csv` | 15 valid records | Records tab → **Import CSV** → pick this file. Works offline too: the rows sync when you reconnect. |
| `import-with-errors.csv` | 7 rows: 3 valid, 4 broken on purpose | Import it to test validation. Expect "Imported 3, skipped 4" and a list of the bad rows. |

## Sample accounts

All three accounts are in the same team, so they see each other's records.

| Role | Email | Password |
| --- | --- | --- |
| Admin (sees the Admin dashboard) | admin@syncsafe.test | Admin@123 |
| Field worker | asha@syncsafe.test | Test@123 |
| Field worker | ravi@syncsafe.test | Test@123 |

The login screen has buttons that fill these in for you.

## CSV format

First row is the header. Columns: `title` (required, max 120 characters), `location`, `status`
(`Pending`, `Visited`, `Follow-up`, `Closed`), `priority` (`Low`, `Medium`, `High`), `notes` (max 2,000 characters).
Missing status defaults to `Pending`; missing priority defaults to `Medium`.
