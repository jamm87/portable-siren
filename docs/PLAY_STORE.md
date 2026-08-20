# Publishing Dub Siren on Google Play

Step by step, from nothing to a live listing. Budget roughly **$25 once** (the
Play Console registration fee) and **a few days to two weeks** of waiting for
Google's review — the review is the slow part, not the work below.

Everything here is done from a browser plus a few commands. You don't need
Android Studio, and you don't need a Mac.

---

## What already exists in this repo

The app is production-shaped already:

| | |
|---|---|
| Package name (`applicationId`) | `com.jamm87.dubsiren` — **permanent**, can never be changed after the first upload |
| Min Android version | 7.0 (API 24) |
| Target API | 36 (Android 16) — meets Play's current target-API rule |
| Permissions requested | `INTERNET` only, and nothing that counts as sensitive |
| Data collected from users | none — no analytics, no accounts, no network calls |
| Signing for Play | configured in `android/app/build.gradle`, reading secrets from outside the repo |
| Release build | `.github/workflows/release.yml` produces a signed `.aab` |

Two consequences worth knowing up front: because the app collects nothing and
asks for no sensitive permissions, the **Data safety** form and the content
questionnaires are quick. And because `com.jamm87.dubsiren` is locked in
forever once you upload, change it *now* if you ever want a different name.

---

## Step 1 — Create the Play Console account

1. Go to <https://play.google.com/console> and sign in with the Google account
   that should own the app. Choose carefully: moving an app between accounts
   later is painful.
2. Pick account type **Personal** (unless you have a registered company).
3. Pay the **one-time $25** registration fee.
4. Complete identity verification — Google asks for a government ID and an
   address. **This can take a few days**, and you can't publish until it
   clears, so do this first while you prepare everything else.

## Step 2 — Create the app entry

In Play Console → **Create app**:

- **App name**: `Dub Siren` (up to 30 characters)
- **Default language**: your choice
- **App or game**: App
- **Free or paid**: Free (you can't switch a free app to paid later)
- Tick the declarations about Play policies and US export law.

## Step 3 — Create your upload key and add it to GitHub

Play signs the app for users with a key Google holds, but *you* sign each
upload with your own **upload key**. Create it once and never lose it — losing
it means asking Google support to reset it.

Run this locally (needs a JDK, which you have if you've ever built Android):

```bash
keytool -genkeypair -v \
  -keystore upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias upload
```

It asks for a password and some identity fields. **Keep `upload.jks` and the
passwords in a password manager** — back them up somewhere that isn't only your
laptop.

Now hand them to CI. Turn the keystore into text:

```bash
base64 -w0 upload.jks > upload.jks.base64   # macOS: base64 -i upload.jks -o upload.jks.base64
```

In GitHub → repo **Settings → Secrets and variables → Actions → New repository
secret**, add four:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the whole contents of `upload.jks.base64` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | the key password (same as the keystore one unless you set it differently) |

Then delete `upload.jks.base64` from your machine. **Never commit the keystore**
— `.gitignore` already blocks `*.jks`, `*.keystore` and `keystore.properties`,
but the habit matters more than the safety net.

## Step 4 — Build the signed bundle

Tag a version and push it:

```bash
git tag v1.0
git push origin v1.0
```

`.github/workflows/release.yml` then builds a signed **AAB** (Android App
Bundle — what Play wants, as opposed to the APK used for sideloading), checks
it really is signed, and attaches it to a GitHub release. Download
`DubSiren-1.0.aab` from that release.

The tag sets `versionName`; the workflow's run number sets `versionCode`.
**Play rejects any upload whose `versionCode` isn't higher than the previous
one**, which is why it's tied to an always-increasing number.

> Prefer to build locally? Create `android/keystore.properties` (gitignored):
> ```properties
> storeFile=/absolute/path/to/upload.jks
> storePassword=...
> keyAlias=upload
> keyPassword=...
> ```
> then `npx cap sync android && cd android && ./gradlew bundleRelease`.
> The bundle lands in `android/app/build/outputs/bundle/release/`.

## Step 5 — Fill in the store listing

Play Console → **Grow → Store presence → Main store listing**:

- **Short description** — 80 characters max. For example:
  *"Dub siren synth: touch plate, sweeping tones and heavy tape-style echo."*
- **Full description** — 4000 characters max. Describe the touch plate, the
  presets, the echo, and that it works offline. Don't stuff keywords; Play
  penalises it.
- **App icon** — 512×512 PNG, 32-bit. Export it from
  `www/icons/icon-512.png`.
- **Feature graphic** — 1024×500 PNG or JPG. Required. A crop of the app's
  brass-on-enamel look with the name on it is enough.
- **Phone screenshots** — between 2 and 8, each 16:9 or 9:16, minimum 320px on
  the short side. Take them on the phone with the app running; the STACK and
  TABS layouts both make good shots.

## Step 6 — Complete the mandatory declarations

Play Console → **Policy → App content**. All of these must be green before you
can publish:

- **Privacy policy** — a URL is required *even though the app collects
  nothing*. Use
  **<https://jamm87.github.io/portable-siren/privacy.html>**, which this repo
  already publishes (source: `www/privacy.html`).
- **Data safety** — declare **no data collected and no data shared**. True
  here: the app makes no network requests and stores only your Mem slots and
  layout choice, locally on the device.
- **Ads** — no.
- **Content rating** — fill in the questionnaire. A music tool with no user
  content, no ads and no purchases rates as suitable for everyone.
- **Target audience** — choose an adult age band. Aiming at under-13s pulls in
  the Families policy and a lot of extra requirements for no benefit here.
- **Government apps / financial features / health** — no to all.

## Step 7 — Test before going public

Don't go straight to Production. Play Console → **Testing → Internal testing**:

1. Create a release, upload the `.aab`, add yourself as a tester.
2. Install from the opt-in link Play gives you and confirm the real,
   Play-signed build behaves like your sideloaded one — audio starts after
   Power On, rotating gives the landscape split, and leaving the app silences
   it.

Internal testing has no review wait, so this loop is fast.

> **New personal accounts:** Google requires personal developer accounts
> created from late 2023 onward to run a **closed test with at least 12
> testers for 14 days** before Production unlocks. Check whether the banner
> appears on your Production page — if it does, plan for those two weeks and
> recruit the testers early. Company accounts are exempt.

## Step 8 — Publish

Play Console → **Production → Create new release** → upload the same `.aab` →
write the release notes → **Send for review**.

First reviews typically take **a few days**, occasionally longer. You'll get an
email either way; if it's rejected, the message names the specific policy, and
you fix it and resubmit against the same release.

---

## Releasing an update later

```bash
git tag v1.1
git push origin v1.1
```

Download the new `.aab`, upload it as a new Production release, write the
notes, submit. `versionCode` increments on its own. Updates are usually
reviewed faster than the first submission.

---

## Things that catch people out

- **The package name is permanent.** `com.jamm87.dubsiren` is fixed from your
  first upload onward.
- **Losing the upload keystore is the expensive mistake.** Back it up in at
  least two places.
- **Play won't accept the debug APK** the `android-latest` release publishes.
  That build is for sideloading only; Play needs the signed AAB from Step 4.
- **Target API rules move every year.** Google raises the required
  `targetSdkVersion` annually, around August, and eventually stops accepting
  updates to apps below it. Bumping `targetSdkVersion` in
  `android/variables.gradle` is usually the whole fix.
- **The screenshots and feature graphic are the actual blockers.** The code is
  ready; the artwork is what people stall on.
