# SyncSafe 2.0 Android app (.apk)

The Android app is the same SyncSafe screens packaged with **Capacitor 8**, plus phone features:
camera, GPS, notifications, share sheet for exports, back button and network-change detection.
App id `edu.ucmo.syncsafe`, Android 7.0 or newer.

There are two ways to get the APK.

---

## Way 1 — GitHub builds it (recommended, nothing to install)

Every push to `main` builds the APK and publishes it under **Releases**. Full steps, including
installing on the phone from a private repository and adding a signing key: **docs/GITHUB.md**.

Short version: phone → Chrome → sign in to github.com → your `syncsafe` repository → **Releases** →
**SyncSafe.apk** → open → allow "Install unknown apps" → Install.

---

## Way 2 — Build it on your laptop with Android Studio

1. Install **Android Studio** (<https://developer.android.com/studio>) and open it once so it installs the SDK.
2. Put the two folders side by side: `syncsafe/website` and `syncsafe/android-app`
   (the separate android-app zip already contains a copy of the screens, so it also works on its own).
3. In `android-app` run:

   ```
   npm install
   npm run sync          (copies ../website/public into the app, then "cap sync android")
   npm run open          (opens Android Studio)
   ```

4. Wait for **Gradle sync** to finish (first time: several minutes).
   If Android Studio offers to upgrade the Android Gradle Plugin, you can accept; the project builds either way.
5. **Build → Build App Bundle(s) / APK(s) → Build APK(s)** → **locate**:
   `android/app/build/outputs/apk/debug/app-debug.apk`.
6. Or plug in the phone (USB debugging on) and press the green **Run** button.

After changing anything in `website/public`, run `npm run sync` again before rebuilding.

> **Gradle download times out?** Your earlier fix still works: in
> `android/gradle/wrapper/gradle-wrapper.properties` point `distributionUrl` to a Gradle zip you downloaded,
> e.g. `distributionUrl=file\:///C:/Users/aksha/Downloads/gradle-9.6.0-bin.zip`.
> **Do not commit that change** — GitHub's build needs the normal `https://services.gradle.org/...` address.

---

## Install, connect, log in

1. Install the APK. If **Play Protect** warns, choose **More details → Install anyway** (normal for apps you build yourself).
   Uninstall the old v1 app first if Android says "App not installed".
2. On the laptop: `npm start` in `website`. Note the line
   `Phone app:   type  http://192.168.1.23:3000  as the Server address`.
3. Phone on the **same Wi-Fi**. Open SyncSafe → type that address → **Test connection** → log in.
   - Use the **Phone app** address, never `10.0.2.2` (that is only for the Android Studio emulator) and never
     `192.168.56.x` (a VirtualBox adapter the phone cannot reach).
   - Windows Firewall: allow Node.js on **Private** networks.
   - Campus Wi-Fi often blocks phone-to-laptop traffic: use the phone's hotspot for the laptop instead.
4. The app asks for **location**, **camera** and **notifications** the first time you use each. You can say no;
   only that feature is skipped.

## Phone features

| Feature | How it works in the app |
| --- | --- |
| Offline | Screens are inside the APK; data is in the phone's encrypted IndexedDB; outbox syncs on reconnect and resume |
| Unlock | After the app is closed, your password unlocks the data on the phone (works offline) |
| GPS | Editor → **Use my location** (Capacitor Geolocation) |
| Photos | Editor → **Add photo** opens camera or gallery; photos are compressed, stored encrypted, uploaded in resumable chunks |
| Voice | Use the 🎤 on the phone keyboard to dictate notes (any keyboard language: Telugu, Hindi, English) |
| Notifications | New assignment, conflict or due reminder shows a phone notification while the app is in the background |
| Exports | Reports → Excel / PDF opens the share sheet (save to Files, Drive, WhatsApp…) |
| Lost phone | Admin signs the device out and erases its data; it happens as soon as the phone connects |
| Back button | Closes a dialog → returns to Records → leaves the app |

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "No SyncSafe server answered at …" | Laptop not running `npm start`, different Wi-Fi, wrong address, or firewall. Try the same address in the phone's Chrome: it should show the SyncSafe page |
| The laptop's address changed | Log out in the app and type the new address |
| "App not installed" | An older SyncSafe signed with another key is installed: uninstall it first |
| Photo stays "Waiting" | It uploads when the record has synced; check Sync activity → outbox |
| Map is grey | The background map needs internet; pins show anyway |
| Stuck on "Retrying" | The phone cannot reach the laptop (see first row). Changes are safe in the outbox |

## Technical notes (for the report)

- Capacitor 8, min API 24, target API 36. Plugins: App, Network, Geolocation, Camera, Filesystem, Share, Local Notifications.
- Permissions in `android/app/src/main/AndroidManifest.xml`: Internet, network state, location, camera,
  read images, post notifications.
- `usesCleartextTraffic` allows plain `http://` to a laptop on the local network. For a real deployment use HTTPS and turn it off.
- Debug builds use a fixed key in the project (`syncsafe-debug.keystore`) so every new APK installs over the old one.
  Release builds use your private key from GitHub secrets (docs/GITHUB.md §5); `versionCode` is the GitHub run number.
- Sync while the app is **fully closed** is not done: Android suspends the WebView. The app syncs on open, resume,
  network change and every 30 seconds while open.
