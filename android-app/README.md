# SyncSafe 2.0 — Android app

The SyncSafe screens packaged as an Android app with Capacitor 8 (camera, GPS, notifications, share sheet).
It needs a SyncSafe server running on your laptop (the `website` folder / `syncsafe-website.zip`).

**Easiest:** download `SyncSafe.apk` from the GitHub repository's **Releases** page — GitHub builds it on every push.

**Build it yourself with Android Studio:**

```
npm install
npm run sync      copies ../website/public into public/ (if that folder exists), then runs "cap sync android"
npm run open      opens the project in Android Studio → Build → Build APK(s)
```

The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`.
Install it, open it, type the **Phone app** address that `npm start` printed on the laptop (same Wi-Fi), log in.

Full guide, permissions and troubleshooting: `website/docs/ANDROID.md` (also in the website zip under `docs/`).
Signing a release APK: `website/docs/GITHUB.md`, section 5.
