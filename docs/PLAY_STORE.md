# Publishing Portable Dub Siren on Google Play

Step by step, for the chosen model: **the app is free to download, and the
instrument is unlocked either by a yearly subscription with a 7-day free trial,
or by a one-time purchase — the buyer picks.**

Everything here is done from a browser plus a few commands. You don't need
Android Studio, and you don't need a Mac.

---

## Read this first: three things that bite

**1. "Free" vs "Paid" is a one-way door, and you want Free.** A Play app
published as free can never become paid. That's fine, because a *paid app* is a
one-time purchase with no trials and no recurrence — it cannot do what you
asked for. What does it is a **free app that sells products inside itself**:
one subscription and one unlock. Pick **Free** at creation and never revisit it.

**2. Selling anything needs a payments profile first.** Monetization is locked
until you have a Google payments profile linked to the Play Console account,
with tax and banking details accepted. This is separate from the $25
registration and **can take days**, so start it before you write any code.

**3. The privacy policy URL has to stay publicly reachable.** Play requires it.
If the GitHub Pages site is ever taken down or put behind a password,
`privacy.html` must still be served somewhere public, or the listing gets
rejected.

---

## What already exists in this repo

| | |
|---|---|
| Package name (`applicationId`) | `com.jamm87.dubsiren` — **permanent**, can never be changed after the first upload |
| Min Android version | 7.0 (API 24) |
| Target API | 36 (Android 16) |
| Permissions requested | `INTERNET` only |
| Signing for Play | configured in `android/app/build.gradle`, reading secrets from outside the repo |
| Release build | `.github/workflows/release.yml` produces a signed `.aab` |
| Billing integration | **not built yet** — see [Step 5](#step-5--the-code-that-has-to-exist) |

Two consequences worth knowing up front: `com.jamm87.dubsiren` is locked in
forever once you upload, so change it *now* if you ever want a different name.
And the **Data safety** form is no longer the trivial "nothing collected" it
was while the app was free — Play Billing is a Google SDK and purchases are
data. [Step 7](#step-7--declarations-now-that-money-is-involved) covers it.

---

## Step 0 — Retire the free full copies

This isn't bureaucracy, it's the whole business case. Today the identical app
is free in two places, so nobody has a reason to pay:

- **The sideloadable APK** on the `android-latest` rolling release. Delete that
  release and drop the publish step from `.github/workflows/android.yml` (keep
  the build, so CI still proves the Android app compiles). Note that a
  sideloaded copy could never verify a purchase anyway — Play Billing only
  answers for installs that came from Play — so leaving it published ships an
  app that is permanently locked for whoever downloads it.
- **The PWA** on GitHub Pages. A password in front of a static site is not
  protection: the check lives in JavaScript the browser has already downloaded,
  and this repo is public, so the password would be readable on GitHub. Either
  cut the Pages build down to a demo (no presets, no Mem), move the web app to
  a host with real access control, or take it down — but keep `privacy.html`
  and `guide.html` publicly served either way.

## Step 1 — Payments profile

Play Console → **Setup → Payments profile**. Create or link a Google payments
profile, then complete the tax forms and bank details. Until this clears,
the Monetization section won't let you create products. Do it first.

## Step 2 — Create the app entry

Play Console → **Create app**:

- **App name**: `Portable Dub Siren` (up to 30 characters)
- **Default language**: your choice
- **App or game**: App
- **Free or paid**: **Free** — see the warning at the top
- Tick the declarations about Play policies and US export law.

## Step 3 — Upload key and the signed bundle

Play signs the app for users with a key Google holds, but *you* sign each
upload with your own **upload key**. Create it once and never lose it.

```bash
keytool -genkeypair -v \
  -keystore upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias upload
```

Keep `upload.jks` and the passwords in a password manager, backed up somewhere
that isn't only your laptop. Then hand them to CI:

```bash
base64 -w0 upload.jks > upload.jks.base64   # macOS: base64 -i upload.jks -o upload.jks.base64
```

GitHub → repo **Settings → Secrets and variables → Actions**, add four:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the whole contents of `upload.jks.base64` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | the key password |

Delete `upload.jks.base64` afterwards. `.gitignore` already blocks `*.jks`,
`*.keystore` and `keystore.properties`.

Then tag a version:

```bash
git tag v1.0
git push origin v1.0
```

`release.yml` builds a signed **AAB** — an Android App Bundle, which is what
Play takes; the debug APK used for sideloading is a different artifact and Play
rejects it — checks it really is signed, and attaches it to a GitHub release.
Download `DubSiren-1.0.aab` from there.

The tag sets `versionName`; the workflow's run number sets `versionCode`. Play
rejects any upload whose `versionCode` isn't higher than the last one.

> **Upload one build before creating products.** The Monetization screens need
> a package that already knows about billing, so the first `.aab` should be one
> that includes the work in Step 5.

## Step 4 — Create the two products

Both live under **Monetize** in Play Console.

### The yearly subscription with a 7-day trial

**Monetize → Subscriptions → Create subscription**

- **Product ID**: e.g. `siren_yearly` — **permanent**, can't be reused or renamed
- **Name**: what buyers see, e.g. "Portable Dub Siren — yearly"

Then inside it:

1. **Add a base plan.** Billing period **Yearly**, renewal **auto-renewing**.
   Give it an ID (e.g. `yearly`) and set prices per country.
2. **Add an offer** on that base plan. Eligibility **New customer
   acquisition**, then one phase of type **Free trial** with a duration of
   **1 week**. Play allows anywhere from 3 days to 3 years, so a week is fine.
3. **Activate** both the base plan and the offer — created is not the same as
   active, and an inactive plan simply won't appear in the app.

The trial is once per user per subscription: cancelling and resubscribing does
not grant a second one.

### The one-time unlock

**Monetize → In-app products → Create product**

- **Product ID**: e.g. `siren_lifetime` — also permanent
- Type: a **one-time product**, and it must be **non-consumable** — it's an
  entitlement the buyer keeps, not something they use up
- Set prices per country

**Price the two so the choice makes sense.** With a perpetual unlock on the
shelf, most people take it and the subscription barely sells, so the yearly
price only has a job if it's clearly the cheap way in — something like a
perpetual unlock at three to four times the yearly price. If you'd rather not
run two products, drop the subscription: the one-time unlock is the easier sell
for a tool like this, and the free tier does the trial's job.

## Step 5 — The code that has to exist

None of this is built yet. The parts:

1. **Billing client.** `cordova-plugin-purchase` (13.18.0 at the time of
   writing) ships `com.android.billingclient:billing:9.0.0`, which clears
   Play's floor — **Billing Library 8 or later has been mandatory for all new
   apps and updates since 31 August 2026**. It works through the Cordova
   compatibility layer this project already has, and adds no third-party data
   processor, unlike a service such as RevenueCat.
2. **An entitlement gate.** One predicate —
   `entitled = activeSubscription || ownsLifetime` — and a paywall shown when
   it's false, offering both products plus a **Restore purchases** button (for
   reinstalls and new devices).
3. **Offline tolerance, which matters more here than in most apps.** This is an
   offline-first instrument: working with no network is the point. A purchase
   check needs one. So cache the entitlement and keep playing on the cached
   answer for a grace window (a week is reasonable) rather than locking the
   instrument the moment a session happens to be out of coverage. The one-time
   unlock is simpler — verified once, kept forever.
4. **Review access.** Reviewers have to be able to see the app work, so add
   license testers (below) and write test instructions on the release.

## Step 6 — Test purchases without paying

Play Console → **Setup → License testing**. Add the Google accounts that should
get test purchases: they see the real flow, are never charged, and their
renewals run on an accelerated clock (a yearly subscription renews in minutes),
which is the only practical way to test renewal and cancellation.

Then **Testing → Internal testing**: create a release, upload the `.aab`, add
yourself, install from the opt-in link, and check the whole path — trial start,
entitlement after the trial, cancellation, restore on a reinstall, and the
offline grace window with aeroplane mode on.

Internal testing has no review wait, so this loop is fast.

## Step 7 — Declarations, now that money is involved

Play Console → **Policy → App content**. What changed from the free version:

- **Privacy policy** — still required, still
  <https://jamm87.github.io/portable-siren/privacy.html>, and it **must be
  updated**: `www/privacy.html` currently says the app has no third-party SDKs
  and collects nothing. With Play Billing that is no longer true. It needs to
  say that purchases are processed by Google Play, what is stored on the device
  (entitlement state, alongside the Mem slots and layout choice), and that no
  payment details ever reach us.
- **Data safety** — no longer "nothing collected". Declare purchase history,
  and go through the form against what Play Billing actually handles rather
  than guessing.
- **Ads** — no.
- **Content rating** — a music tool with no user content, no ads, and paid
  products rates as suitable for everyone.
- **Target audience** — an adult age band. Aiming at under-13s pulls in the
  Families policy and a lot of extra requirements for no benefit.
- **Government apps / financial features / health** — no to all.

## Step 8 — Store listing

Play Console → **Grow → Store presence → Main store listing**:

- **Short description** — 80 characters max
- **Full description** — 4000 max. Say plainly what the trial is, what it costs
  after, and that a one-time unlock exists. Play requires subscription terms to
  be clear, and burying them is the usual reason a listing gets pulled.
- **App icon** — 512×512 PNG, from `www/icons/icon-512.png`
- **Feature graphic** — 1024×500, required
- **Phone screenshots** — 2 to 8. The dark ground photographs better than the
  amber one; take them with a preset loaded so the sliders aren't all at their
  defaults.

## Step 9 — Publish

**Production → Create new release** → upload the `.aab` → release notes →
**Send for review**.

First reviews typically take a few days. Paid apps get looked at a little
harder than free ones, and the usual rejection is unclear subscription terms in
the listing, not the code.

> **New personal accounts:** Google requires personal developer accounts created
> from late 2023 onward to run a **closed test with at least 12 testers for 14
> days** before Production unlocks. Check whether that banner appears on your
> Production page — if it does, plan for those two weeks and recruit early.
> Company accounts are exempt.

---

## Releasing an update later

```bash
git tag v1.1
git push origin v1.1
```

Download the new `.aab`, upload it as a new Production release, write the
notes, submit. `versionCode` increments on its own.

---

## Things that catch people out

- **The package name is permanent.** So are every product ID you create.
- **Losing the upload keystore is the expensive mistake.** Back it up twice.
- **A product that exists but isn't activated doesn't appear in the app**, and
  the failure looks like a bug in your billing code.
- **Target API rules move every year.** Google raises the required
  `targetSdkVersion` annually, around August. Bumping it in
  `android/variables.gradle` is usually the whole fix.
- **Billing Library deadlines move every year too.** Version 8 became mandatory
  on 31 August 2026; version 9's deadline is 31 August 2027. Check the
  [deprecation FAQ](https://developer.android.com/google/play/billing/deprecation-faq)
  before each release rather than trusting this line.
- **The screenshots and feature graphic are the actual blockers.** The code is
  the predictable part; the artwork is what people stall on.
