import { serverEnv } from "@cap/env";

/**
 * OneAway fork addition — provider selection + capability flag for transcription.
 *
 * Upstream Cap hard-codes AssemblyAI and gates the entire transcription pipeline
 * (and the share-page transcript UI) on ASSEMBLY_API_KEY. OneAway transcribes
 * with Cloudflare Workers AI (the same account already holds the videos in R2),
 * so we replace those five `serverEnv().ASSEMBLY_API_KEY` checks with
 * `transcriptionEnabled()` and dispatch the ASR call on `getTranscriptionProvider()`.
 *
 * Kept as a new file (not edits scattered through upstream) so upstream pulls
 * stay conflict-free.
 */

export type TranscriptionProvider = "cloudflare" | "assemblyai";

/**
 * Cloudflare Workers AI is preferred (no new vendor — it already stores the
 * videos). AssemblyAI stays selectable as a fallback when only its key is set.
 * Returns null when neither provider is configured.
 */
export function getTranscriptionProvider(): TranscriptionProvider | null {
	const env = serverEnv();
	if (env.CLOUDFLARE_AI_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) return "cloudflare";
	if (env.ASSEMBLY_API_KEY) return "assemblyai";
	return null;
}

/**
 * The single capability flag that replaces every `serverEnv().ASSEMBLY_API_KEY`
 * gate. Transcription is available whenever ANY provider is configured.
 */
export function transcriptionEnabled(): boolean {
	return getTranscriptionProvider() !== null;
}
