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
	// The OneAway portal iframes this route with ?embed=1 → minimal branded recorder (no Cap chooser/FAQ).
	if (sp?.embed === "1") return <EmbedRecorder />;
	return <RecordVideoPage />;
}
