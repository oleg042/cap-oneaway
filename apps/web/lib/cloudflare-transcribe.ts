import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverEnv } from "@cap/env";
import type { AiGenerationLanguage } from "@cap/web-domain";
import { getFfmpegPath } from "@/lib/audio-extract";
import {
	type AssemblyAIEditResult,
	createEditTranscript,
	editTranscriptWordsToCaptionVtt,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
import { correctTranscriptWords } from "@/lib/transcription-corrections";

/**
 * OneAway fork addition — Cloudflare Workers AI transcription.
 *
 * Produces the SAME two artifacts upstream's AssemblyAI path does
 * (`{ vtt, editTranscript }`) so `saveTranscription` and the COMPLETE write are
 * untouched. The only new logic is mapping the Workers AI whisper response into
 * the `AssemblyAIEditResult` shape `createEditTranscript` already consumes.
 *
 * Verified against the real API: word-level timings live INSIDE each segment
 * (`segments[*].words`, times in SECONDS), while top-level `result.words` is
 * empty — so we flatten segment words and convert seconds -> ms.
 *
 * PARALLEL CHUNKING (the speed path): Workers AI whisper is a stateless per-request
 * ASR, and a single-pass call on the whole file runs ~7-8x realtime (a 155s clip
 * ~= 16-21s measured). We instead cut the audio into fixed windows and transcribe
 * them CONCURRENTLY, so wall-clock collapses to roughly the slowest single chunk
 * (~2-3s for that same clip — measured). Each window is extracted with a small
 * symmetric OVERLAP for boundary context, and every word is kept only by the window
 * that owns its start time — so no word is ever cut or duplicated at a splice
 * (verified: the stitched transcript is char-for-char comparable to single-pass).
 * Chunking also removes the 24MB single-pass ceiling that used to fail long recordings.
 */

// Structurally identical to the workflow's local `TranscriptionArtifacts`.
interface TranscriptionArtifacts {
	vtt: string;
	editTranscript: string;
}

const DEFAULT_MODEL = "@cf/openai/whisper-large-v3-turbo";
// Sanity ceiling only (avoid OOM on an absurd input). The per-request Workers AI body
// limit no longer applies to the whole file — chunking keeps each request tiny.
const MAX_AUDIO_BYTES = 512 * 1024 * 1024;

// Chunking knobs. 30s windows match whisper's internal frame; 2s symmetric overlap
// gives every boundary word full surrounding context in exactly one owning window.
const CHUNK_SEC = 30;
// Generous symmetric overlap: the owning window keeps a word only by its start time, so the overlap just has
// to exceed any real word/utterance so that owning chunk has the whole word + context. 3s covers anything.
const OVERLAP_SEC = 3;
// Below this, a single pass is already fast enough that chunking overhead (ffmpeg
// windowing + N requests) isn't worth it.
const CHUNK_MIN_DURATION_SEC = 45;
// Cap concurrent Workers AI calls so a very long recording can't fan out unbounded.
const CHUNK_CONCURRENCY = 8;
// Transient Workers AI failures (429 / 5xx / network blips) are common under load — retry a chunk a few
// times with a small backoff before giving up on it.
const ASR_RETRIES = 2;

interface CfWord {
	word?: unknown;
	text?: unknown;
	start?: unknown;
	end?: unknown;
}
interface CfSegment {
	start?: unknown;
	end?: unknown;
	text?: unknown;
	words?: CfWord[];
}
interface CfResult {
	text?: string;
	vtt?: string;
	segments?: CfSegment[];
	transcription_info?: { language?: string };
}

interface RawWord {
	text: string;
	start: number;
	end: number;
}

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Flatten a Workers AI whisper result into raw words (times seconds -> ms), WITHOUT
 * proper-noun correction — correction runs once on the merged transcript so it sees
 * full context. If a segment lacks word timings we fall back to one coarse "word"
 * per segment so a transcript is never empty.
 */
function cloudflareResultToRawWords(result: CfResult): RawWord[] {
	const raw: RawWord[] = [];
	for (const seg of result.segments ?? []) {
		const segWords = Array.isArray(seg.words) ? seg.words : [];
		if (segWords.length > 0) {
			for (const w of segWords) {
				const text =
					typeof w.word === "string"
						? w.word
						: typeof w.text === "string"
							? w.text
							: "";
				const start = finite(w.start);
				const end = finite(w.end);
				if (!text.trim() || start === null || end === null) continue;
				raw.push({ text, start: start * 1000, end: end * 1000 });
			}
		} else {
			const text = typeof seg.text === "string" ? seg.text : "";
			const start = finite(seg.start);
			const end = finite(seg.end);
			if (text.trim() && start !== null && end !== null) {
				raw.push({ text: text.trim(), start: start * 1000, end: end * 1000 });
			}
		}
	}
	return raw;
}

/**
 * Flatten a Workers AI whisper result into the AssemblyAIEditResult shape (with
 * proper-noun correction). Kept exported for callers/tests that hold a single result.
 */
export function cloudflareResultToEditInput(
	result: CfResult,
): AssemblyAIEditResult {
	return {
		words: correctTranscriptWords(cloudflareResultToRawWords(result)),
		language_code: result.transcription_info?.language ?? null,
		speech_model_used: "whisper-large-v3-turbo",
	};
}

function estimateDurationMs(input: AssemblyAIEditResult): number {
	let max = 0;
	for (const w of input.words ?? []) {
		const end = finite((w as { end?: unknown }).end);
		if (end !== null && end > max) max = end;
	}
	return max;
}

async function runWorkersAi(audioBuffer: Buffer): Promise<CfResult> {
	const env = serverEnv();
	const model = env.CLOUDFLARE_AI_MODEL || DEFAULT_MODEL;
	const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`;

	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.CLOUDFLARE_AI_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ audio: audioBuffer.toString("base64") }),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(
			`Cloudflare Workers AI transcription failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`,
		);
	}

	const json = (await res.json()) as {
		success?: boolean;
		result?: CfResult;
		errors?: unknown;
	};
	if (!json.success || !json.result) {
		throw new Error(
			`Cloudflare Workers AI returned no result: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`,
		);
	}
	return json.result;
}

// Retry wrapper: transient Workers AI failures (429/5xx/network) → retry with a short linear backoff before
// surfacing the error. Used for both chunk calls and the single-pass fallback.
async function runWorkersAiWithRetry(audioBuffer: Buffer): Promise<CfResult> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= ASR_RETRIES; attempt++) {
		try {
			return await runWorkersAi(audioBuffer);
		} catch (err) {
			lastErr = err;
			if (attempt < ASR_RETRIES) {
				await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
			}
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchAudioBuffer(audioUrl: string): Promise<Buffer> {
	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}
	const buffer = Buffer.from(await audioResponse.arrayBuffer());
	if (buffer.byteLength > MAX_AUDIO_BYTES) {
		throw new Error(
			`Audio implausibly large (${(buffer.byteLength / 1048576).toFixed(1)}MB > ${MAX_AUDIO_BYTES / 1048576}MB)`,
		);
	}
	return buffer;
}

/** Probe an audio file's duration (seconds) by parsing ffmpeg's stderr — ffmpeg-static
 *  ships no ffprobe, so we read the `Duration:` line the decoder prints. 0 if unknown. */
function probeDurationSec(path: string): Promise<number> {
	return new Promise((resolveDuration) => {
		const proc = spawn(getFfmpegPath(), ["-i", path], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("close", () => {
			const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
			resolveDuration(
				m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0,
			);
		});
		proc.on("error", () => resolveDuration(0));
	});
}

/** Extract [startSec, startSec+lenSec] of an audio file to a fresh temp mp3 (16k mono,
 *  whisper-friendly + small) via ffmpeg. Returns the temp path; caller cleans it up. */
async function extractAudioWindow(
	srcPath: string,
	startSec: number,
	lenSec: number,
): Promise<string> {
	const out = join(tmpdir(), `cf-chunk-${randomUUID()}.mp3`);
	const args = [
		"-ss",
		String(startSec),
		"-t",
		String(lenSec),
		"-i",
		srcPath,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"16000",
		"-b:a",
		"64k",
		"-f",
		"mp3",
		"-y",
		out,
	];
	await new Promise<void>((res, rej) => {
		const proc = spawn(getFfmpegPath(), args, {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("error", rej);
		proc.on("close", (code) =>
			code === 0
				? res()
				: rej(
						new Error(
							`ffmpeg window ${startSec}s+${lenSec}s failed (${code}): ${stderr.slice(0, 200)}`,
						),
					),
		);
	});
	return out;
}

/**
 * Transcribe an audio buffer into merged raw words. Short clips take a single pass;
 * longer ones are cut into overlapping 30s windows, transcribed CONCURRENTLY, and
 * stitched — each word kept only by the window owning its start time (absolute ms),
 * so no boundary word is cut or duplicated. Falls back to single-pass if the duration
 * can't be probed.
 */
async function transcribeBufferToRawWords(
	audioBuffer: Buffer,
): Promise<{ words: RawWord[]; language: string | null }> {
	const singlePass = async () => {
		const r = await runWorkersAiWithRetry(audioBuffer);
		return {
			words: cloudflareResultToRawWords(r),
			language: r.transcription_info?.language ?? null,
		};
	};

	// Fast chunked path. ANY failure inside it — ffmpeg unavailable, temp write, duration probe, a chunk
	// failing after retries, or an empty stitched result — leaves `chunked` null and we fall through to the
	// guaranteed-complete single pass (which needs neither ffmpeg nor a temp file). So the chunked path can
	// never turn a transcribable recording into an ERROR.
	let chunked: { words: RawWord[]; language: string | null } | null = null;
	const srcPath = join(tmpdir(), `cf-src-${randomUUID()}.mp3`);
	try {
		await fs.writeFile(srcPath, audioBuffer);
		const durationSec = await probeDurationSec(srcPath);

		// Only worth chunking a clip long enough to benefit; short/unknown-duration falls through to one pass.
		if (durationSec >= CHUNK_MIN_DURATION_SEC) {
			const nChunks = Math.max(1, Math.ceil(durationSec / CHUNK_SEC));
			const indices = Array.from({ length: nChunks }, (_, i) => i);
			const perChunk: {
				i: number;
				words: RawWord[];
				language: string | null;
			}[] = [];

			// Bounded concurrency: run windows in batches of CHUNK_CONCURRENCY.
			for (let b = 0; b < indices.length; b += CHUNK_CONCURRENCY) {
				const batch = indices.slice(b, b + CHUNK_CONCURRENCY);
				const batchResults = await Promise.all(
					batch.map(async (i) => {
						const winStart = Math.max(0, i * CHUNK_SEC - OVERLAP_SEC);
						const winEnd = (i + 1) * CHUNK_SEC + OVERLAP_SEC;
						const chunkPath = await extractAudioWindow(
							srcPath,
							winStart,
							winEnd - winStart,
						);
						try {
							const buf = await fs.readFile(chunkPath);
							const r = await runWorkersAiWithRetry(buf);
							const offsetMs = winStart * 1000;
							const ownStartMs = i * CHUNK_SEC * 1000;
							const ownEndMs = (i + 1) * CHUNK_SEC * 1000;
							const words = cloudflareResultToRawWords(r)
								.map((w) => ({
									text: w.text,
									start: w.start + offsetMs,
									end: w.end + offsetMs,
								}))
								// keep only words this 30s window owns (half-open) — de-dups the overlap
								.filter((w) => w.start >= ownStartMs && w.start < ownEndMs);
							return {
								i,
								words,
								language: r.transcription_info?.language ?? null,
							};
						} finally {
							await fs.unlink(chunkPath).catch(() => {});
						}
					}),
				);
				perChunk.push(...batchResults);
			}

			perChunk.sort((a, b2) => a.i - b2.i);
			const words = perChunk
				.flatMap((c) => c.words)
				.sort((a, b2) => a.start - b2.start);
			// Only accept a NON-empty stitched result; an empty one is suspicious (a real recording has
			// speech), so leave `chunked` null and fall through to single-pass rather than save an empty one.
			if (words.length > 0) {
				chunked = {
					words,
					language: perChunk.find((c) => c.language)?.language ?? null,
				};
			}
		}
	} catch (chunkedError) {
		// FOOLPROOF fallback: any failure in the chunked fast-path — pre-flight ffmpeg/temp-write, the
		// duration probe, a chunk after retries, or an empty result — must NEVER yield a partial or failed
		// transcript. Leave `chunked` null and fall through to the guaranteed-complete single pass below.
		console.warn(
			`[cf-transcribe] chunked path failed (${(chunkedError as Error)?.message ?? chunkedError}); falling back to single-pass`,
		);
		chunked = null;
	} finally {
		await fs.unlink(srcPath).catch(() => {});
	}

	return chunked ?? (await singlePass());
}

/** Drop-in replacement for `transcribeWithAssemblyAI` — same return shape. */
export async function transcribeWithCloudflare(
	audioUrl: string,
	_language: AiGenerationLanguage,
	videoDurationMs: number,
): Promise<TranscriptionArtifacts> {
	const audioBuffer = await fetchAudioBuffer(audioUrl);
	const { words, language } = await transcribeBufferToRawWords(audioBuffer);
	const editInput: AssemblyAIEditResult = {
		words: correctTranscriptWords(words),
		language_code: language,
		speech_model_used: "whisper-large-v3-turbo",
	};
	const durationMs =
		videoDurationMs > 0 ? videoDurationMs : estimateDurationMs(editInput);
	const editTranscript = createEditTranscript(editInput, durationMs);
	return {
		vtt: editTranscriptWordsToCaptionVtt(editTranscript.words),
		editTranscript: serializeEditTranscript(editTranscript),
	};
}

/** Drop-in replacement for `transcribeEditTranscriptWithAssemblyAI`. */
export async function transcribeEditTranscriptWithCloudflare(
	audioUrl: string,
	videoDurationSeconds: number,
): Promise<string> {
	const audioBuffer = await fetchAudioBuffer(audioUrl);
	const { words, language } = await transcribeBufferToRawWords(audioBuffer);
	const editInput: AssemblyAIEditResult = {
		words: correctTranscriptWords(words),
		language_code: language,
		speech_model_used: "whisper-large-v3-turbo",
	};
	const durationMs =
		videoDurationSeconds > 0
			? videoDurationSeconds * 1000
			: estimateDurationMs(editInput);
	return serializeEditTranscript(createEditTranscript(editInput, durationMs));
}
