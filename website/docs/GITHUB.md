# SyncSafe on GitHub: tests, APK builds and releases

Your repository `syncsafe` holds both parts in one place:

```
syncsafe/
├── website/                 server + website (this folder)
├── android-app/             Android app (Capacitor 8); its screens are copied from website/public
├── .github/workflows/
│   ├── ci.yml               runs all tests on every push (built-in PostgreSQL and real PostgreSQL)
│   └── android.yml          builds the APK and publishes a GitHub Release
└── README.md
```

What GitHub does for you after every push to `main`:

1. Runs the tests (52 tests + 1,000-cycle durability simulation).
2. Builds **SyncSafe.apk** on GitHub's servers — no Android Studio needed.
3. Publishes a release called **latest** with:
   - `SyncSafe.apk` — install on a phone
   - `SyncSafe-release.apk` — signed release build (after you add the signing secrets, section 5)
   - `syncsafe-website.zip` — the server + website
   - `syncsafe-android-app.zip` — the Android Studio project
4. Starts an Android emulator, installs the APK, opens it and saves a screenshot (Actions → run → **emulator-screenshot**).

> **Why not GitHub Pages for the website?** Pages only serves static files, and SyncSafe needs its
> Node.js server and database. Your chosen setup runs the server on the laptop; GitHub builds and
> stores everything you install. (Pages on a private repository also needs a paid plan.)

---

## 1. Put the project in your repository (first time)

You need **Git**: <https://git-scm.com/downloads> (Windows: default options).

1. Unzip both zips into one folder named `syncsafe`, so you have `syncsafe/website` and
   `syncsafe/android-app` (rename `syncsafe-website` → `website` and `syncsafe-android-app` → `android-app`).
   If you downloaded the repository-ready zip, it already has this layout.
2. Copy the `.github` folder and `README.md` from the repository zip into `syncsafe/`.
3. Open a terminal in `syncsafe/` and run (replace `YOUR-USERNAME`):

   ```
   git init
   git add .
   git commit -m "SyncSafe 2.0"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/syncsafe.git
   git push -u origin main
   ```

   Git asks you to sign in to GitHub the first time (a browser window opens).

> If GitHub already shows files in the repository (for example a README you created on the website),
> run `git pull origin main --allow-unrelated-histories` before `git push`, keep both READMEs' content, and commit.

**Never commit** `node_modules/`, `website/data/` or a `.jks` key — the `.gitignore` already excludes them.

---

## 2. Watch the build

1. Open your repository on GitHub → **Actions**.
2. You will see two workflows start: **Tests** and **Android APK and release**.
3. A green tick ✅ means success (about 6–10 minutes for the APK). A red ✗ — click it, open the
   failed step and read the last lines; the most common causes are in section 7.
4. Run a build by hand any time: Actions → **Android APK and release** → **Run workflow**.

---

## 3. Download and install the APK on your phone

The repository is **private**, so downloads need you to be signed in to GitHub.

1. On the phone, open <https://github.com> in Chrome and **sign in**.
2. Go to your repository → **Releases** (right side, or `github.com/YOUR-USERNAME/syncsafe/releases`).
3. Open **SyncSafe (latest build)** → tap **SyncSafe.apk**.
4. Open the downloaded file. Android asks to allow "Install unknown apps" for Chrome once → allow → **Install**.
5. Open SyncSafe, type the **Phone app** address that `npm start` printed on the laptop (same Wi-Fi), log in.

Every new push builds a new APK with a higher version number, and it installs **over** the old app
(the debug key is fixed in the project), so your data on the phone is kept.

> Uninstall the **old v1 app** first if you installed it from Android Studio — it was signed with a
> different key, so Android refuses to update it ("App not installed").

---

## 4. Make a numbered release (for submission)

```
git tag v2.0.0
git push origin v2.0.0
```

The workflow creates a release named **SyncSafe v2.0.0** that is kept (the "latest" release is replaced
on every push). Use the next number (`v2.0.1`, …) for later releases.

---

## 5. Signed release APK (optional, needed for the Play Store later)

A release APK is signed with **your own private key**. Make it once and keep it safe — if you lose it,
you can never update an app signed with it.

1. Make the key (the `keytool` command comes with Android Studio's Java, or any Java 17+):

   ```
   keytool -genkeypair -v -keystore syncsafe-release.jks -alias syncsafe -keyalg RSA -keysize 2048 -validity 10000
   ```

   It asks for a password and your name. Remember the password. **Do not put this file in the repository.**
   (Windows: if `keytool` is not found, use
   `"C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe"` instead.)

2. Turn the key into text:
   - Mac/Linux: `base64 -i syncsafe-release.jks | tr -d '\n' > key.txt`
   - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("syncsafe-release.jks")) > key.txt`

3. On GitHub: repository → **Settings → Secrets and variables → Actions → New repository secret**. Add four secrets:

   | Name | Value |
   | --- | --- |
   | `ANDROID_KEYSTORE_BASE64` | the whole content of `key.txt` |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
   | `ANDROID_KEY_ALIAS` | `syncsafe` |
   | `ANDROID_KEY_PASSWORD` | the key password (same as above unless you chose another) |

4. Delete `key.txt`. Push any change (or Run workflow). The release now also has **SyncSafe-release.apk**.

To build a signed APK on your laptop instead, set the same values as environment variables
`SYNCSAFE_KEYSTORE` (path to the .jks), `SYNCSAFE_KEYSTORE_PASSWORD`, `SYNCSAFE_KEY_ALIAS`,
`SYNCSAFE_KEY_PASSWORD`, then `cd android-app/android` and `gradlew assembleRelease`.

---

## 6. Day-to-day workflow (Scrum + GitHub + Jira)

1. Pick a Jira story (e.g. `SS-214`) and create a branch: `git checkout -b SS-214-map-view`.
2. Commit with the key in the message: `git commit -m "SS-214 map view pins by status"` — Jira links
   the commit when the GitHub for Jira app is installed.
3. Push and open a **pull request** on GitHub. The **Tests** workflow runs on it; merge only when green
   (this is your Definition of Done).
4. Merging into `main` builds a new APK release automatically.

---

## 7. When a build fails

| Message in the log | Fix |
| --- | --- |
| `npm ci` … lock file out of sync | Run `npm install` in that folder on your laptop, commit `package-lock.json`, push |
| A test fails (`not ok …`) | Run `npm test` in `website/` on your laptop to see the same failure |
| `SDK location not found` / license errors | Only happens on your laptop; GitHub's runner has the SDK. On the laptop, open the project once in Android Studio |
| `Keystore was tampered with, or password was incorrect` | A signing secret is wrong; re-add the four secrets |
| Release step: `HTTP 403` | Repository → Settings → Actions → General → Workflow permissions → **Read and write** |
| Emulator check red | Informational only; the release is still published. Open the `emulator-screenshot` artifact to see why |

GitHub's free plan gives private repositories 2,000 Actions minutes per month; one push uses about 15.
