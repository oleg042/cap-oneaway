import type { Metadata } from "next";
import { EmbedRecorder } from "./EmbedRecorder";
import { RecordVideoPage } from "./RecordVideoPage";

export const metadata: Metadata = {
	title: "Record a Tape",
};

export default async function RecordVideoRoute({
	searchParams,
}: {
	searchParams: Promise<{ embed?: string }>;
}) {
	const sp = await searchParams;
	// The OneAway portal opens this route with ?embed=1 (minimal branded recorder, no Cap chooser/FAQ) in
	// a NEW TAB. On completion the recorder self-closes; the portal reconciles the finished tape from Cap
	// server-side, so no callback/postMessage is needed.
	if (sp?.embed === "1") return <EmbedRecorder />;
	return <RecordVideoPage />;
}
