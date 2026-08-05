# Handover — Self-Hosted Video Platform (Loom replacement)

**Date:** 2026-08-06
**Repo:** `~/Projects/cap` · branch `oneaway/local-transcription`
**Upstream:** `CapSoftware/Cap` @ `1bd1ccd09`, remote named `upstream` (not `origin`)
**Written for:** an agent with context on `oneaway-app` (the client portal) and the
Neon estate, picking this up to add portal launch controls and sync transcripts
and metadata into Neon.

---

## 0. Read this first

Two things will save you the most time:

1. **§7 (Traps)** — every one of these cost real time to find, and several fail
   *silently*, meaning the system reports success while doing the wrong thing.
2. **§4 (Transcription)** — the architecture reversed twice under review. The
   conclusion is not what the original spec says, and the spec file has been
   annotated rather than rewritten so the reasoning survives.

The single most important finding: **Cloudflare Workers AI transcribes with
byte-identical output to the local Whisper this team already trusts, free at
their volume, and it now runs on the same Cloudflare account as the video
storage.** That removes the entire justification for forking Cap's desktop app.
See §4.3.

---

## 1. What this is

OneAway (~15-person B2B GTM agency) is replacing Loom with a self-hosted fork of
[Cap](https://github.com/CapSoftware/Cap) — an AGPL screen recorder with a
Next.js web app and a Tauri desktop app.

Goals, in the user's words:
- Works locally first, then videos stored in the cloud (R2). ✅ **done**
- Transcription without paying a per-minute vendor. ✅ **solved, see §4**
- Team on Mac and Windows, easy to install. ✅ **solved via browser extension**
- Portal launch controls + transcripts/metadata in Neon. ⬅️ **your job**

## 2. Current state

| Piece | State |
|---|---|
| Self-hosted Cap stack | ✅ running locally, `localhost:3900` |
| Storage | ✅ **live on Cloudflare R2** (bucket `cap`, Western Europe) |
| Storage round-trip | ✅ proven byte-identical via `smoke-test.sh` |
| Chrome extension recorder | ✅ built + packaged, points at our instance |
| Transcription | ⚠️ **decided + credentials live, not yet wired into Cap** — see §4 |
| Desktop app | ❌ blocked on full Xcode; **probably unnecessary now** |
| Production hosting | ❌ not started, still localhost |
| Portal / Neon integration | ❌ not started — **this is you** |
| DB backups | ❌ **blocking before client-facing use** (§6.4) |

### Running it

```bash
colima start --cpu 4 --memory 8 --disk 60
cd ~/Projects/cap && docker compose up -d
```

Full details in `.oneaway/RUNBOOK.md`. Login codes print to
`docker compose logs cap-web` (no Resend key set on purpose).

## 3. Architecture as it stands

```
┌── recorder ──────────────┐
│ Chrome extension         │   apps/chrome-extension, built + packaged
│ (screen + cam + mic)     │   server URL baked in at build time
└──────────┬───────────────┘
           │ presigned PUT
┌──────────▼───────────────┐
│ cap-web  (Next.js)       │   localhost:3900 → will be video.oneaway.io
│ cap-media-server (ffmpeg)│
│ cap-mysql                │   ⚠️ MySQL, not Postgres. Share-ID → object map
│ cap-minio                │   rollback only; storage is on R2
└──────────┬───────────────┘
           │ S3 API
┌──────────▼───────────────┐
│ Cloudflare R2 · bucket   │   05fd8b27a383fcad5bab69af4b1a1ddf
│ `cap` · Western Europe   │   .r2.cloudflarestorage.com
└──────────────────────────┘
```

**Cap's DB is MySQL. The portal's is Neon Postgres.** Any sync is cross-engine —
see §5.

## 4. Transcription — the decision, and how it moved

### 4.1 Where it started

The original spec (`.oneaway/specs/2026-08-05-…-design.md`) proposed porting
Cap's chunk-scheduling logic to Rust and running Parakeet/whisper on-device
during recording. `crates/live-captions-core` was built for this: 26 passing
tests, clippy-clean, ported from upstream's own suite.

### 4.2 What review found

Three adversarial reviews (systems architect, agency founder, RevOps lead) took
it apart. Verified findings:

- The spec's framing was misleading, and I wrote it. It claimed self-hosted Cap
  has no transcription; in fact `workflows/transcribe.ts` and
  `live-transcribe.ts` are complete. What's missing is an **API key, not code**.
- **`serverUrl` is a shipped user setting** (`general.tsx:748`), so Cap's own
  *signed* binary points at a self-hosted instance. Forking the desktop app is
  therefore not a cost of self-hosting — it is a cost of *modifying* the app,
  which we'd only do for on-device ASR.
- Upstream ships ~594 commits/month; `recording.rs` changed 50× in 90 days. A
  fork that hooks it carries a permanent rebase tax.
- **Chunking during recording is unnecessary on-device.** It exists because
  AssemblyAI is remote and per-minute-billed. Transcribing the finished file at
  stop costs ~1 min of latency and deletes crash-resume, two-writer contention,
  and encoder contention entirely.

### 4.3 Where it landed — Cloudflare Workers AI

The user's requirement was "no third-party transcription vendor." Cloudflare
satisfies the spirit of it, because **Cloudflare already stores the videos** —
and since 2026-08-06 it is literally the *same account*, so audio and video sit
under one billing relationship. No new party.

Credentials are in `~/Projects/cap/.env` as `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_AI_TOKEN`, `CLOUDFLARE_AI_MODEL`. **Nothing in Cap reads them yet** —
wiring is the remaining work.

Measured on this account, real data:

| | |
|---|---|
| Model | `@cf/openai/whisper-large-v3-turbo` |
| Speed | **2.9s for 22s of audio** (RTF ≈ 0.13) |
| Cost | ~2,800 neurons/hour ≈ **$0.031/hr**; 10,000 neurons/day free |
| At 30 h/month | **$0.00** — free tier covers ~107 h/month |
| Output | `text`, `segments` with **word-level timings**, and a ready-made **`vtt`** |

**Quality: 46/46 words identical** to Scribe's local transcript of the same real
recording (`~/Projects/scribe/data/dictate/clips/20260721-195339-*.wav`).

Not a coincidence: Scribe runs `whisper-turbo-4bit` (large-v3-turbo, 4-bit) via
mlx-whisper. Cloudflare runs `whisper-large-v3-turbo`. **Same model.**

Also available: `@cf/deepgram/nova-3`, `@cf/deepgram/flux`,
`@cf/openai/whisper`, `@cf/openai/whisper-tiny-en`.

**Known weakness:** proper nouns. On a synthetic sample it produced "email
Bison", "Maildozo", "one-away". Cap has a `transcriptionHints` vocabulary
setting for its *local* engines; whether Workers AI accepts an equivalent
prompt is **unverified and worth checking** — it directly affects transcript
usefulness for this team.

### 4.4 Options still open

| Option | Audio goes to | Cost | Install | Status |
|---|---|---|---|---|
| **Workers AI** | Cloudflare (already holds the videos) | ~$0 | none | ✅ verified working |
| Browser `parakeet.js` | nowhere | $0 | none | spike built, **never run** (§8) |
| Desktop fork + Parakeet | nowhere | $0 | Xcode + signing + Rust | blocked, likely unnecessary |
| AssemblyAI | a genuinely new vendor | ~$5/mo | none | rejected by user |

`crates/live-captions-core` is **off the critical path** but kept on the branch.
Don't let its existence pull the chunked orchestrator back in.

### 4.5 The gate you must not miss

`apps/web/app/s/[videoId]/page.tsx:497`:

```ts
const transcriptionGenerationAvailable =
  !video.isScreenshot && Boolean(env.ASSEMBLY_API_KEY) && !rules.settings.disableTranscript;
```

**The share page hides the transcript UI unless `ASSEMBLY_API_KEY` is set.**
Same check in `actions/videos/get-status.ts:64`. If transcripts come from
Workers AI, this must become a capability flag or perfectly good transcripts
will never render. `get-live-transcript.ts:62-72` also treats `SKIPPED` as
terminal and stops polling.

## 5. Portal + Neon integration — what you need

### 5.1 Where the data lives

**MySQL — `videos` table** (`packages/database/schema.ts`):

```
id, ownerId, orgId, name, bucket, storageIntegrationId, duration,
width, height, fps, metadata, public, settings, transcriptionStatus,
source, folderId, createdAt, effectiveCreatedAt, updatedAt, password,
xStreamInfo, firstViewEmailSentAt, isScreenshot, awsRegion, awsBucket,
videoStartTime, audioStartTime, jobId, jobStatus, skipProcessing
```

**R2 object layout** (`packages/s3/README.md`), keyed `{userId}/{videoId}/`:

```
/transcription.vtt                  ← canonical transcript (WebVTT)
/transcription.edit.v3.json         ← EDIT_TRANSCRIPT_KEY_SUFFIX, word-level
/transcription.live.json            ← provisional, live path only
/result.mp4                         ← the video
/screenshot/screen-capture.jpg
```

**Share URL:** `{CAP_URL}/s/{videoId}`

### 5.2 Integration surfaces, ranked

1. **`developer_api_keys` table exists** (`schema.ts:1394`, plus `auth_api_keys`
   and `agent_api_keys`). There is a `/api/v1/[...route]` Hono app. This is the
   intended programmatic surface — **start here**, and confirm what the v1
   routes actually expose since I did not enumerate them.
2. **Read MySQL directly.** Cap's DB is ours; a read-only user plus a poller
   into Neon is the least-coupled option and survives upstream changes better
   than patching app code.
3. **No user-facing outbound webhooks exist.** `apps/web/app/api/webhooks/`
   contains only `media-server` and `stripe` (both internal). If you want
   push-on-recording-complete you'd be adding it — a new route plus a hook where
   `transcriptionStatus` flips to complete.

### 5.3 Suggested sync shape

Poll or trigger on `videos.transcriptionStatus` reaching completion, then into
Neon write: `videoId`, `ownerId`, share URL, `duration`, `createdAt`, the
transcript text, and the AI summary. Keep the **video bytes in R2** — do not
copy media into Neon.

⚠️ **The share-ID → object mapping lives in MySQL, not R2.** Losing that
database orphans every client link even though the bytes survive. If the portal
becomes the system of record, mirroring `videoId → object key` into Neon is
cheap insurance and arguably reason enough to do this sync.

### 5.4 "Launch controls" — ambiguous, needs the user

Could mean (a) start/manage recordings from the portal, or (b) admin controls
for the instance. Worth clarifying before building. Note (a) has a hard limit:
**browsers cannot start a screen recording without the user picking a
share target in a browser dialog** — that's a security guarantee, not a
limitation to engineer around. The portal can deep-link into a recorder; it
cannot silently start one.

## 6. Decisions already made (don't relitigate)

1. **No third-party transcription vendor.** User was asked twice. Cloudflare is
   acceptable because it already holds the videos; AssemblyAI is not.
2. **Transcribe at stop, not chunked during recording** (§4.2).
3. **Both ASR engines stay; never delete upstream capability.** Express
   preferences as defaults/config so rebases stay cheap.
4. **Fork hygiene:** new files over edits; fork-owned docs in `.oneaway/`
   (upstream gitignores `/docs`). User intends to hard-fork and cherry-pick
   fixes rather than track upstream — `upstream-fixes.sh` supports that.
5. **R2 bucket location: Automatic (Western Europe).** Not changeable.
6. **Storage quality:** Cap's defaults (1080p, 30fps instant) are correct.
   Screen content needs resolution for legibility, not framerate. A year of
   team recordings costs ~$1/month.

### 6.4 Blocking before client-facing use

- **Database backups with PITR** — see §5.3.
- Real domain + TLS.
- Google SSO (currently log-scraped OTP codes).
- **Viewer analytics do not exist self-hosted** — every view metric sources from
  Tinybird, which disables itself without `TINYBIRD_TOKEN`/`TINYBIRD_HOST`. "Did
  the prospect watch it" currently has no answer. A minimal `video_views` table
  is probably the right call over adopting Tinybird.
- **Custom domains are Vercel-locked** (`domain-utils.ts` calls `api.vercel.com`).
  Serve the instance from our domain via `CAP_URL`; that in-app feature is dead
  code on other infrastructure.
- **AGPL §13 triggers on network interaction, not distribution.** Every prospect
  loading a share page is a remote user of modified software. Publish the fork
  or carry a source link in the share-page footer.

## 7. Traps — all verified, most fail silently

1. **Docker maps an occupied host port without erroring.** This machine had
   another dev server on 3000 and an ssh tunnel on 9000/9001. Compose reported
   healthy while every request hit *other apps*. Hence ports **3900 / 9900 /
   9901**.
2. **Setting `CAP_AWS_*` in `.env` does nothing on its own.** The base
   `docker-compose.yml` hardcodes `CAP_AWS_BUCKET`, `CAP_AWS_REGION`,
   `S3_INTERNAL_ENDPOINT` and maps credentials to `MINIO_ROOT_*`. Our
   `docker-compose.override.yml` wires them through. **The first R2 cutover
   reported success while still writing to MinIO because of this.**
3. **The only reliable signal for which storage is live is the host in a
   presigned URL.** Healthy containers, a rendering share page, and a passing
   round-trip are all satisfied by the *wrong* backend.
   `smoke-test.sh | grep "signed for"`.
4. **Node must be ≥ 20.12 despite `engines: >=20`.** `scripts/setup.js` uses
   `fs.Dirent.parentPath` (added 20.12). On 20.11 setup dies with an
   `ERR_INVALID_ARG_TYPE` that never mentions Node. Use `node@24` (Cap's CI
   version) via `/opt/homebrew/opt/node@24/bin`.
5. **The desktop app needs full Xcode, not Command Line Tools.** `cidre` shells
   out to `xcodebuild`.
6. **`docs/` is gitignored upstream** — fork docs live in `.oneaway/`.
7. **Colima does not mount `/private/tmp`** into its VM; build fixtures inside a
   container and `docker cp` them out.
8. **BSD sed lacks `\?` in BREs** — bit the URL trimming in `smoke-test.sh`.
9. **`find` (the Chrome MCP tool) returns a 403 OAuth error** in this
   environment. Use `read_page` + refs instead.

## 8. Scripts

All in `.oneaway/scripts/`, all tested unless noted:

| Script | Does |
|---|---|
| `smoke-test.sh` | Login → create video → presigned upload → read back → compare bytes → clean up. **Run after any storage change.** |
| `cutover-to-r2.sh` | One-command MinIO→R2 with auto-rollback. Asserts the signing host. Already used. |
| `migrate-minio-to-r2.sh` | Object copy + verification diff. Idempotent. `R2_ENDPOINT` overrides for rehearsal. |
| `upstream-fixes.sh` | Lists upstream `fix:` commits touching our dependencies, trial-applies each to flag conflicts. **First run found a CoreAudio leak fix that applies cleanly.** |
| `package-extension.sh` | Builds the Chrome extension with the server URL baked in, emits a zip. |
| `../spike/` | Browser-Parakeet feasibility page + COOP/COEP server. **Built, never run** — `index.html` + `serve.py`, page verified to load with `crossOriginIsolated: true` and WebGPU available. |

## 9. Credentials and coordinates

**Real secrets are in `.oneaway/CREDENTIALS.local.md` — gitignored, on disk
next to this file.** Kept out of git because §6.4 flags that AGPL §13 may
require publishing this fork, and committed secrets live in history forever.

### One Cloudflare account

Everything is on **`05fd8b27a383fcad5bab69af4b1a1ddf`** — R2 storage and
Workers AI transcription. Unified billing, one 10,000 neurons/day free
allowance, one dashboard.

This was briefly split across two accounts and was consolidated on 2026-08-06 by
creating a `cap-workers-ai` token on the R2 account. An older Cloudflare token
in `~/Projects/oneawaygent/.env` belongs to a different account and has no
access here — **it is not relevant to this project, don't reach for it.**

Two tokens, because R2 needs S3-style credentials and Workers AI needs a
standard API token. Both account-level, not user-level.

- **Bucket:** `cap`, Automatic location → Western Europe, **not changeable**
- **R2 token:** account-level, `cap-selfhost`, Object Read & Write scoped to
  `cap`. Account-level on purpose — a user token dies if that person leaves the
  org, which was a bus-factor risk raised in review.
- **Cap `.env`:** freshly generated `NEXTAUTH_SECRET`,
  `DATABASE_ENCRYPTION_KEY`, `MEDIA_SERVER_WEBHOOK_SECRET`. Upstream ships a
  **public default** `DATABASE_ENCRYPTION_KEY` — it encrypts video passwords and
  stored S3 credentials, so never deploy with it.

## 10. Open questions

1. **Proper nouns transcribe badly** — "email Bison", "Maildozo", "one-away".
   Two independent fixes, and the second does not depend on the first:
   - Does Workers AI accept a vocabulary/initial prompt? **Unverified.**
   - **`~/Projects/scribe/lessons/corrections.py` already solves this**, and it
     is this team's own code. It applies vocabulary correction *over stored
     output* rather than biasing the model: exact pair replacement for known
     heard-forms ("Advan Jobstead Done" → "Advanced Jobs To Be Done"), then
     fuzzy near-miss for casing drift. Because it runs against stored
     transcripts, **adding a pair later fixes every past transcript without
     re-running the model** — which is exactly what you want when a new client
     name enters the vocabulary. Porting this into the transcript pipeline is
     probably higher value than chasing a prompt parameter.
2. **What exactly are "launch controls"?** (§5.4)
3. **Where does production run** — Railway (Cap ships a one-click deploy) or
   existing OneAway infrastructure?
4. **Is the browser-Parakeet path still wanted** now Workers AI is proven? Only
   matters if a client contract demands audio never leave the device.
5. **Retention policy.** Nobody deletes recordings. This is the real cost lever
   over three years — not quality settings. Numbers to reason with, from
   measured encodes at Cap's defaults (1080p, 30fps):

   | Content | Per 5-min video | Fits in 10 GB free |
   |---|---|---|
   | Static (code, docs, slides) | ~15 MB | ~680 |
   | Typical screenshare + webcam | ~45 MB | ~228 |
   | Busy (scrolling, video playback) | ~94 MB | ~109 |

   Storage is cumulative, not monthly. Past the free 10 GB it is $0.015/GB/month
   with **zero egress** — 50 GB ≈ $0.60/month, 250 GB ≈ $3.60/month. A year of
   team recordings costs about a dollar a month, so do not degrade quality to
   save storage; screen content needs resolution for text legibility. If the
   portal surfaces storage, R2 lifecycle rules can expire internal clips while
   keeping client-facing ones — that is the lever worth building.
