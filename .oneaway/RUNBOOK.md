# Self-Hosted Cap — Local Runbook

OneAway's fork of [CapSoftware/Cap](https://github.com/CapSoftware/Cap).
Branch: `oneaway/local-transcription`. Upstream remote is named `upstream`.

## Prerequisites

```bash
brew install colima docker docker-compose cmake node@24
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
corepack enable && corepack prepare pnpm@10.5.2 --activate
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.88.0
```

Rust version is pinned by `rust-toolchain.toml` (1.88.0). `cmake` is required
for the desktop build on macOS.

### Node must be >= 20.12, despite `engines: node >= 20`

`scripts/setup.js` uses `fs.Dirent.parentPath`, which Node only added in
**20.12.0**. On 20.11.x it is `undefined` and `pnpm cap-setup` dies with a
confusing `ERR_INVALID_ARG_TYPE` from `path.join` inside
`signMacOSFrameworkLibs` — nothing in the error mentions Node versions.

Cap's own CI runs Node 24, so that's what we match. Installing `node@24` via
Homebrew leaves any system Node at `/usr/local/bin/node` untouched; just prepend
it to `PATH` when working in this repo.

## Ports

**We do not use the defaults.** This machine already had another dev server on
3000 and an ssh tunnel on 9000/9001. Docker maps a busy host port *without
erroring* — the container reports healthy while `curl localhost:3000` silently
reaches the other process. That failure mode looks exactly like success, so
check before assuming.

| Service | Host port | Container |
|---|---|---|
| cap-web | **3900** | 3000 |
| MinIO API | **9900** | 9000 |
| MinIO console | **9901** | 9001 |

Before starting, confirm they're free:

```bash
for p in 3900 9900 9901; do lsof -nP -iTCP:$p -sTCP:LISTEN; done   # want no output
```

If any is taken, change `CAP_PORT` / `MINIO_PORT` / `MINIO_CONSOLE_PORT` in
`.env` — and update `CAP_URL` and `S3_PUBLIC_URL` to match, or playback breaks
(the client fetches media from `S3_PUBLIC_URL` directly).

## Start / stop

```bash
colima start --cpu 4 --memory 8 --disk 60   # once per boot
docker compose up -d
docker compose ps                            # want 4x healthy
docker compose down                          # stop (volumes persist)
```

Cap is then at <http://localhost:3900>, MinIO console at <http://localhost:9901>
(`cap-admin` / see `.env`).

### Compose plugin not found?

Homebrew installs it outside Docker's default search path:

```json
// ~/.docker/config.json
{ "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"] }
```

## Logging in

`RESEND_API_KEY` is intentionally unset, so no email is sent. Cap prints a
6-digit verification code to the container logs instead:

```bash
docker compose logs cap-web --tail 80 | grep -A4 "VERIFICATION CODE"
```

Enter your email at <http://localhost:3900/login>, then paste that code. It
expires in 10 minutes.

Google and WorkOS OAuth providers are also wired but need credentials in `.env`.
Add Google for team SSO when we deploy for real.

## Storage

**Live on Cloudflare R2** as of 2026-08-05. MinIO is still running as the
rollback and can be retired once an existing recording has been played by a
real person.

```bash
R2_ACCOUNT_ID=… R2_ACCESS_KEY=… R2_SECRET_KEY=… ./.oneaway/scripts/cutover-to-r2.sh
```

Copies objects, rewrites config, restarts, uploads and reads back real bytes,
then asserts the app is signing URLs against R2. Restores the previous `.env`
and returns to MinIO if any of that fails.

### Setting CAP_AWS_* in .env is not sufficient on its own

An earlier version of this runbook claimed storage was env-only. It isn't. The
base `docker-compose.yml` hardcodes most of the settings and maps the rest to
MinIO-specific names:

```yaml
CAP_AWS_ACCESS_KEY: ${MINIO_ROOT_USER:-cap-admin}   # not CAP_AWS_ACCESS_KEY
CAP_AWS_BUCKET: cap                                 # hardcoded
CAP_AWS_REGION: us-east-1                           # hardcoded
S3_INTERNAL_ENDPOINT: http://minio:9000             # hardcoded
```

`docker-compose.override.yml` (ours, merged automatically by compose) wires the
`.env` values through. Without it the container keeps talking to MinIO while
the config says R2 — and every check short of inspecting a presigned URL's host
still passes. That is exactly how the first cutover attempt reported success
while writing nowhere near R2.

### Verifying which storage is actually in use

```bash
./.oneaway/scripts/smoke-test.sh | grep "signed for"
```

The host in a presigned URL is the ground truth. Container health, a rendering
share page, and a passing round-trip are all satisfied by the *wrong* backend.

## Transcription

`ASSEMBLY_API_KEY` is deliberately blank. Stock self-hosted Cap therefore has
**no** transcription at all — that is expected, and is what
`.oneaway/specs/2026-08-05-local-live-transcription-design.md` exists to fix by
moving ASR on-device (Parakeet v3 / whisper.cpp, both already vendored in the
desktop app).

## Recording: two clients, very different costs

### Chrome extension — no Xcode, no signing, no fork

Cap ships a Chrome extension that records screen, window, tab, camera and mic,
uploading while it records. Its manifest requests `http://*/*` and `https://*/*`,
so it talks to a self-hosted instance with no repackaging, and the server
address is a normal setting rather than a build-time constant.

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
pnpm --filter @cap/chrome-extension build     # → apps/chrome-extension/dist
```

Then, per teammate: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select `apps/chrome-extension/dist` → open the extension's
**Options** → set the server URL to the instance (`http://localhost:3900`, later
`https://video.oneaway.io`).

This path avoids the entire desktop toolchain: no Xcode, no Apple Developer
account, no notarization, no Windows certificate, no auto-update channel, and
no per-seat commercial licence. For distribution beyond a handful of people,
publish it as an unlisted Chrome Web Store item instead of asking everyone to
load it unpacked.

What it cannot do: run a local ASR model. The extension path implies cloud
transcription.

### Desktop app — only needed for on-device transcription

```bash
pnpm cap-setup        # native deps (ffmpeg) — slow first run
pnpm dev:desktop      # builds sidecar binaries, then tauri dev
```

Point it at the instance via **Settings → Cap Server URL**.

Requires **full Xcode**, not just Command Line Tools — `cidre` shells out to
`xcodebuild`, and the failure message never mentions Xcode:

```
xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer
directory '/Library/Developer/CommandLineTools' is a command line tools instance
```

Fix with `sudo xcode-select -s /Applications/Xcode.app`.

Note that Cap's official signed binary already accepts a custom server URL, so
building the desktop app from source is only worth it if we are *modifying* it —
which, for us, means on-device transcription and nothing else.

## Staying current with upstream

Cap ships fast (live transcription landed 2026-08-03). Keep merges cheap:

```bash
git fetch upstream && git rebase upstream/main
```

Fork rules that make that survivable:
1. New files over edits to upstream files.
2. Never delete upstream capability — express preferences as defaults/config.
3. Fork-owned docs live in `.oneaway/` (upstream gitignores `/docs`).
