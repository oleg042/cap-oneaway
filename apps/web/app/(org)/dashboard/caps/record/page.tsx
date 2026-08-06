import type { Metadata } from "next";
import { EmbedRecorder } from "./EmbedRecorder";
import { RecordVideoPage } from "./RecordVideoPage";

export const metadata: Metadata = {
	title: "Record a Tape",
};

export default async function RecordVideoRoute({
	searchParams,
}: {
	searchParams: Promise<{ embed?: string; portal?: string }>;
}) {
	const sp = await searchParams;
	// The OneAway portal opens this route with ?embed=1 (minimal branded recorder, no Cap chooser/FAQ) in
	// a NEW TAB, passing &portal=<its origin> so the recorder can message the portal tab (window.opener)
	// on completion and then self-close.
	if (sp?.embed === "1") return <EmbedRecorder portalOrigin={sp.portal} />;
	return <RecordVideoPage />;
}
