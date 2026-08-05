# On-Device Live Transcription for Self-Hosted Cap

**Date:** 2026-08-05
**Status:** Draft — pending review
**Owner:** OneAway
**Upstream base:** `CapSoftware/Cap` @ `1bd1ccd09`

---

## 1. Goal

Run a self-hosted Cap instance for the OneAway team that replaces Loom, with
transcription performed **on the recorder's own machine** rather than by a paid
cloud ASR API.

Success looks like: a teammate on macOS or Windows installs one app, records,
and by the time they stop, a share link exists with a near-complete transcript —
and no per-minute bill was incurred.

## 2. Non-goals

- Replacing Cap's editor, recording pipeline, or share pages.
- Building a product for external customers. Note this is *not* the same as
  "only internal viewers" — share links go to clients and prospects (see §12).

  An earlier draft claimed AGPL obligations were satisfied by making the fork
  available to whoever we distribute binaries to. That is wrong. AGPL §13
  triggers on **network interaction**, not distribution: every prospect who
  loads a share page is a remote user of modified software. Publish the fork, or
  carry a source link in the share-page footer.
- Speaker diarization. Screen recordings are near-always single-speaker.
- On-device LLM summarization. Titles, summaries, and chapters stay in the cloud
  (see §6.4).

## 3. What upstream already provides

The build is small because Cap already ships most of it. Verified against
`1bd1ccd09`:

| Capability | Location | State |
|---|---|---|
| On-device ASR, two engines | `apps/desktop/src-tauri/src/captions.rs` (2,898 LOC) | Works. `whisper-rs 0.11` + `parakeet-rs 0.3.4` |
| Word-level timestamps | `CaptionSegment.words: {text,start,end}[]` | Works. Both engines emit them |
| Model download / cache / delete | Tauri commands, warm contexts | Works |
| Hardware-aware model selection | `supportsParakeetTranscription()`, `resolveCaptionModel()` | Works. Intel Macs auto-fall back to whisper |
| Vocabulary biasing | `settings/transcription.tsx` → `transcriptionHints` | Works |
| Chunk scheduling logic | `apps/web/lib/live-transcribe-core.ts` (358 LOC, **pure**) | Works, but server-side and AssemblyAI-bound |
| Parity tests for that logic | `apps/web/__tests__/unit/live-transcribe-core.test.ts` (355 LOC) | Reusable as a porting oracle |
| Segment streaming during recording | `SegmentUploader` in `recording.rs` | Works |
| Cross-platform signed release CI | `.github/workflows/desktop-release.yml` | Works. 4 targets, notarization, SignPath, Tauri updater |
| S3-abstracted storage | `CAP_AWS_*`, `S3_PUBLIC_ENDPOINT`, `S3_INTERNAL_ENDPOINT` | Works. MinIO and R2 are the same interface |

## 4. The gap

Cap has two transcription paths that never meet:

```
DESKTOP   record → captions.rs (Parakeet / whisper, on-device)
                     └─→ editor captions, burn-in.  Never uploaded.

WEB       upload → workflows/live-transcribe.ts → AssemblyAI (cloud, paid)
                     └─→ share page, search, AI summaries
```

Confirmed: the strings `transcript` and `vtt` appear nowhere in the desktop's
`upload.rs`, `web_api.rs`, or `api.rs`. The local transcript never leaves the
machine.

Additionally, self-hosted Cap ships with **no `ASSEMBLY_API_KEY`**, so a stock
self-hosted instance has *zero* transcription. This work is what makes our
instance useful, not a nice-to-have.

## 5. Architecture

### 5.1 Where the orchestrator lives: Rust backend

The chunk loop runs in the Tauri **Rust backend**, not the SolidStart frontend.

Rationale:

1. **Thread and QoS control is a hard requirement.** Transcribing every ~10s
   while the encoder runs needs explicit thread caps and background priority
   (§7.1). Only the Rust side can set these.
2. **It must survive the UI.** A recording can outlive any given webview window;
   an orchestrator in the frontend dies with it.
3. **Segments are produced in Rust.** `SegmentUploader` already streams them.
4. **No IPC per chunk.** `transcribe_audio` is already a Rust function; calling
   it in-process avoids a serialization round-trip every few seconds.

The cost is porting ~350 lines of pure TypeScript to Rust. We accept it, and
contain it (§5.3).

### 5.2 Flow

```
recording starts
   │
   ├─ SegmentUploader writes segments  ──────────────┐
   │                                                  │
   └─ live_captions loop (background QoS thread)      │
         │                                            │
         ├─ plan_next_chunk()      ←── segment state ─┘
         ├─ extract chunk WAV → temp
         ├─ transcribe_audio(path, model, lang, engine)   [existing]
         │      ├─ Whisper  → whisper-rs   ─┐
         │      └─ Parakeet → parakeet-rs  ─┴→ CaptionData{segments[].words[]}
         ├─ offset_chunk_words()   → recording timeline
         ├─ apply_chunk()          → live transcript state
         └─ PUT transcription.live.json  → S3 (MinIO now, R2 later)
                                              │
recording stops                               │
   └─ transcribe final tail, mark complete ───┘
                                              │
                              share page renders growing transcript
                                     (already implemented upstream)
```

### 5.3 Robustness we inherit rather than build

Reading the pure core in full surfaced three safety mechanisms that come free:

- **Idempotent chunk merge.** `applyChunkToLiveTranscript` evicts any words at
  or after the incoming chunk's start before appending, so a retried chunk
  cannot duplicate words.
- **Gap-aware promotion.** `canPromoteLiveTranscript` refuses to promote a live
  transcript to canonical unless the manifest is complete, has no index gap, and
  is covered through its last segment. A skipped chunk sets `hasGaps` and
  disqualifies the artifact — the full-pass fallback covers the recording
  instead. Locally that fallback is "transcribe the whole file on-device after
  stop," which we get by reusing the existing editor path.
- **Model provenance.** `liveTranscriptToEditTranscript(artifact,
  speechModelUsed)` records which model produced a transcript. We set it to the
  concrete local model (e.g. `parakeet-tdt-0.6b-v3-int8`), which makes quality
  regressions attributable after the fact.

One function does *not* port: `isNoSpokenAudioError` exists because AssemblyAI
reports silence as a transcript error. Local engines simply return no words for
a silent chunk, so the empty-chunk case needs no special handling.

### 5.4 Containing upstream drift

We will be rebasing on an actively-developed upstream — Cap shipped live
transcription on 2026-08-03, three days before this spec. Merge cost is a
first-class design constraint.

Rules:

1. **New files, not edits.** The orchestrator lands in a new
   `apps/desktop/src-tauri/src/live_captions.rs`. Upstream files get
   registration lines only, never logic.
2. **Never delete upstream capability.** Whisper vs Parakeet, AssemblyAI vs
   local — express preferences as *defaults and config*, never by removing
   code. A one-line default change survives a rebase; a deleted module does not.
3. **Port the tests, not just the code.** `live-transcribe-core.test.ts` (355
   LOC) becomes the Rust port's test suite. It is our proof of behavioral parity
   and our tripwire when upstream changes the algorithm.

## 6. Decisions

### 6.1 Both ASR engines stay; Parakeet is the default

Parakeet v3 (`parakeet-tdt-0.6b-v3`, int8, ~640MB) is default: substantially
faster, which directly shortens the post-stop tail and reduces machine
contention. Covers 25 European languages with word-level timestamps, CC-BY-4.0.

whisper.cpp remains available and is the automatic fallback on Intel Macs, where
`parakeet-rs` is excluded at the Cargo target level and therefore not merely
slow but absent. It is also the correct choice for anyone needing languages
outside Parakeet's European set (CJK, Arabic, Hindi).

Both paths already converge on `CaptionData`, so the orchestrator is
engine-agnostic and this decision costs nothing to reverse.

### 6.2 Language is pinned per recording — and upstream already does this

Parakeet auto-detects language, but chunks are 5–10 seconds. Detection on a
short chunk of hesitation ("okay, so…") is unreliable and would let language
flap mid-recording, corrupting the transcript.

Upstream already solves it. `applyChunkToLiveTranscript` merges with:

```ts
languageCode: artifact.languageCode ?? chunk.languageCode
```

First non-null wins and no later chunk can overwrite it, and `languageCode` is
already a field on `LiveTranscriptArtifact`. So this is **inherited behaviour we
must preserve in the port**, not new work. A user-set language in settings still
overrides detection entirely.

### 6.3 Storage: MinIO locally, R2 in production

Cap's storage is fully env-driven. MinIO and R2 are both S3 implementations, so
promotion is a five-variable change with no code delta:

```
CAP_AWS_ACCESS_KEY, CAP_AWS_SECRET_KEY, CAP_AWS_BUCKET,
S3_PUBLIC_ENDPOINT, S3_INTERNAL_ENDPOINT   (+ S3_PATH_STYLE=false for R2)
```

R2 is the production target: $0.015/GB/month with **zero egress fees**, which is
the entire economic argument versus per-seat Loom pricing.

Building against MinIO first is therefore free of architectural debt.

### 6.4 AI summaries stay in the cloud, pointed at our own Claude agent

Local ASR gets us the transcript. Titles, summaries, and chapters remain a cloud
LLM call, re-pointed from Groq/OpenAI to OneAway's own Claude agent. This is a
provider swap in one service, not an architectural change, and on-device LLM
summarization is not worth the memory footprint.

## 7. Risks

### 7.1 Resource contention with the recorder

**Risk:** inference every ~10s competes with the recording pipeline, causing
dropped frames or thermal throttling.

Analysis: video encoding runs on dedicated media-engine silicon (VideoToolbox,
Media Foundation), so CPU cores are *not* the scarce resource. The real
contention is GPU (against Cap's own wgpu compositor), memory bandwidth on
Apple Silicon's unified memory, and sustained-load thermals on laptops.

Cap currently sets **no** thread or priority controls — transcription runs on an
unprioritized `tokio::spawn_blocking` pool, because today it only runs in the
editor after recording, when nothing competes.

**Mitigations:**
- Cap whisper `n_threads` and ONNX intra/inter-op threads explicitly. Do not let
  either grab all cores.
- Run the loop at background QoS (macOS steers this onto efficiency cores;
  Windows uses `SetThreadAffinityMask` + `BELOW_NORMAL`).
- Pin Parakeet to the **CPU** execution provider so the GPU stays with the
  compositor. Parakeet int8 is designed for CPU inference. Target split:
  *video owns GPU + media engine, speech owns efficiency cores.*
- Backpressure already exists upstream (`MAX_CHUNK_TAKE_SECONDS: 60`): a slow
  machine degrades into "transcript lags and catches up," never an unbounded
  queue.

**Validation gate:** measure on the slowest Windows laptop on the team before
shipping. If frames drop, fall back to transcribe-on-stop for that machine.

### 7.2 Upstream divergence

**Risk:** Cap is shipping fast; our fork rots.

**Mitigation:** §5.3 rules, plus a scheduled upstream rebase. The parity tests
are the tripwire — if upstream changes chunk-planning semantics, they fail.

### 7.3 Model download weight

**Risk:** first run pulls ~640MB (Parakeet int8) or 466MB–1.5GB (whisper).

**Mitigation:** upstream already handles this — on-demand download with progress
UI and status polling. Not bundled into the installer. No work required.

## 8. Milestones

| # | Deliverable | Exit criteria |
|---|---|---|
| 0 | Self-hosted stack running locally | Record → upload → play back at a share link, MinIO-backed |
| 1 | Desktop app built from source, pointed at local server | Official flow works against `localhost:3000` |
| 2 | Parakeet quality validated on real team voices | Subjective pass on accent, jargon, filler |
| 3 | `live_captions.rs` — ported pure logic + parity tests | Ported tests green against upstream's suite |
| 4 | Orchestrator wired to `SegmentUploader` | Transcript exists on share page seconds after stop |
| 5 | Thread/QoS tuning | No dropped frames on the slowest team machine |
| 6 | Claude agent for summaries | Titles/summaries/chapters generated from our own agent |
| 7 | R2 promotion | Five env vars swapped; videos serve from R2 |
| 8 | Signed cross-platform release | Teammates install a notarized `.dmg` / signed `.exe` and auto-update |

## 9. Testing

- **Parity:** upstream's `live-transcribe-core.test.ts` ported to Rust, run in CI.
- **Integration:** record → chunked transcript → stop → complete transcript,
  asserting the post-stop tail stays under one chunk window.
- **Degradation:** simulate a slow machine (throttled thread cap) and assert
  catch-up behavior rather than queue growth.
- **Platform matrix:** Apple Silicon (Parakeet), Intel Mac (auto-fallback to
  whisper), Windows (Parakeet).
- **Storage:** the same test suite green against MinIO and against R2.

## 10. Cost

| Item | Cost |
|---|---|
| R2 storage | ~$0.015/GB/mo, **zero egress**. ~30GB/mo ≈ $0.45 |
| Transcription | $0 — on-device |
| AI summaries | Pennies, our own Claude usage |
| Apple Developer (signing + notarization) | $99/yr |
| Windows signing | Likely $0 via SignPath's OSS tier |
| **Total** | **~$100–200/yr** vs Loom Business at $15/user/mo |

## 11. Open questions

1. Does anyone on the team have an Intel Mac? If not, §6.1's fallback path is
   untested-but-inherited rather than a supported configuration we must verify.
2. Which languages does the team actually record in? If anything falls outside
   Parakeet's 25 European languages, §6.1's default flips to whisper.
3. Where does the production instance run — Railway (one-click Cap deploy exists)
   or existing OneAway infrastructure?
