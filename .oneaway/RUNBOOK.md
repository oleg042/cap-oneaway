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

MinIO locally, Cloudflare R2 in production. Both are S3 implementations, so
promotion is env-only — no code change:

```
CAP_AWS_ACCESS_KEY, CAP_AWS_SECRET_KEY, CAP_AWS_BUCKET,
S3_PUBLIC_ENDPOINT, S3_INTERNAL_ENDPOINT, S3_PATH_STYLE=false
```

## Transcription

`ASSEMBLY_API_KEY` is deliberately blank. Stock self-hosted Cap therefore has
**no** transcription at all — that is expected, and is what
`.oneaway/specs/2026-08-05-local-live-transcription-design.md` exists to fix by
moving ASR on-device (Parakeet v3 / whisper.cpp, both already vendored in the
desktop app).

## Desktop app

```bash
pnpm cap-setup        # native deps (ffmpeg) — slow first run
pnpm dev:desktop      # builds sidecar binaries, then tauri dev
```

Point the app at this instance via **Settings → Cap Server URL** →
`http://localhost:3900`.

## Staying current with upstream

Cap ships fast (live transcription landed 2026-08-03). Keep merges cheap:

```bash
git fetch upstream && git rebase upstream/main
```

Fork rules that make that survivable:
1. New files over edits to upstream files.
2. Never delete upstream capability — express preferences as defaults/config.
3. Fork-owned docs live in `.oneaway/` (upstream gitignores `/docs`).
