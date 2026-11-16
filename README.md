# SyncSafe — Offline Data Synchronization System

Software Engineering and System Design semester project (Agile + Scrum) by Chethan Ganji.

SyncSafe lets field teams record inspections and surveys with **no internet**. Every change is saved
(encrypted) on the device first and synced when the connection returns; edits from different devices are
merged, and a person decides only when two devices changed the same protected field.

| Folder | What it is | Start here |
| --- | --- | --- |
| [`website/`](website/) | Node.js server, PostgreSQL, website (PWA), tests, docs, Jira backlog | [`website/README.md`](website/README.md) |
| [`android-app/`](android-app/) | Android app (Capacitor 8) using the same screens | [`website/docs/ANDROID.md`](website/docs/ANDROID.md) |
| [`.github/workflows/`](.github/workflows/) | Tests on every push; APK build + GitHub Release | [`website/docs/GITHUB.md`](website/docs/GITHUB.md) |

## Quick start

```
cd website
npm install
npm start            → open http://localhost:3000, log in as Admin (admin@syncsafe.test / Admin@123)
```

Phone: download **SyncSafe.apk** from this repository's **Releases** (sign in to GitHub on the phone first;
the repository is private), install it and type the "Phone app" address that `npm start` prints.

## Documentation

- [What's new in 2.0 and the demo script](website/docs/FEATURES.md)
- [GitHub: builds, releases, signing](website/docs/GITHUB.md)
- [Android app](website/docs/ANDROID.md)
- [API](website/docs/API.md)
- [Software engineering and system design principles](website/docs/PRINCIPLES.md)
- [Test plan and results](website/docs/TESTING.md)
- [Jira guide and backlogs](website/docs/JIRA_GUIDE.md)
