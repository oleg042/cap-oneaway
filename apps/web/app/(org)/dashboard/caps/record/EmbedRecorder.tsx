"use client";

import { WebRecorderDialog } from "../components/web-recorder-dialog/web-recorder-dialog";

// Minimal OneAway-branded recorder shown when the portal iframes this route (?embed=1). No Cap chooser,
// desktop-app upsell, or FAQ — just a clean surface with the browser recorder. The controls live inside
// the portal's UI via this iframe; Cap remains the upload/storage/transcription engine underneath.
export function EmbedRecorder() {
	return (
		<div className="min-h-screen w-full flex flex-col items-center justify-center gap-6 px-6 text-center bg-gray-1">
			<div className="flex items-center gap-2">
				<span
					className="inline-block w-3 h-3 rounded-full"
					style={{ background: "#FD4F03" }}
					aria-hidden="true"
				/>
				<span className="text-[15px] font-semibold lowercase tracking-tight text-gray-12">
					tape
				</span>
				<span className="text-[12px] text-gray-9">by OneAway</span>
			</div>
			<p className="max-w-sm text-sm text-gray-10">
				Record your screen and voice — pick a screen, hit record, and go.
			</p>
			<WebRecorderDialog />
		</div>
	);
}
