import { serverEnv } from "@cap/env";
import type { AiGenerationLanguage } from "@cap/web-domain";
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
 */

// Structurally identical to the workflow's local `TranscriptionArtifacts`.
interface TranscriptionArtifacts {
	vtt: string;
	editTranscript: string;
}

const DEFAULT_MODEL = "@cf/openai/whisper-large-v3-turbo";
// Guard the single-pass base64 request against the Workers AI body ceiling.
// Long recordings that exceed this fail cleanly to ERROR (a calm, non-fatal
// state — the tape still exists and plays); chunking is a documented follow-up.
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

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

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Flatten a Workers AI whisper result into the AssemblyAIEditResult shape.
 * Word times are seconds -> converted to ms. If a segment lacks word timings we
 * fall back to one coarse "word" per segment so a transcript is never empty.
 * Proper-noun correction runs here so both the VTT and the edit transcript come
 * out corrected.
 */
export function cloudflareResultToEditInput(
	result: CfResult,
): AssemblyAIEditResult {
	const raw: { text: string; start: number; end: number }[] = [];
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

	const corrected = correctTranscriptWords(raw);
	return {
		words: corrected,
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
			`Audio too large for Workers AI single-pass (${(buffer.byteLength / 1048576).toFixed(1)}MB > ${MAX_AUDIO_BYTES / 1048576}MB); chunking is a follow-up`,
		);
	}
	return buffer;
}

/** Drop-in replacement for `transcribeWithAssemblyAI` — same return shape. */
export async function transcribeWithCloudflare(
	audioUrl: string,
	_language: AiGenerationLanguage,
	videoDurationMs: number,
): Promise<TranscriptionArtifacts> {
	const audioBuffer = await fetchAudioBuffer(audioUrl);
	const result = await runWorkersAi(audioBuffer);
	const editInput = cloudflareResultToEditInput(result);
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
	const result = await runWorkersAi(audioBuffer);
	const editInput = cloudflareResultToEditInput(result);
	const durationMs =
		videoDurationSeconds > 0
			? videoDurationSeconds * 1000
			: estimateDurationMs(editInput);
	return serializeEditTranscript(createEditTranscript(editInput, durationMs));
}
