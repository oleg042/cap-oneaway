"use client";

import { useEffect } from "react";
import { WebRecorderDialog } from "../components/web-recorder-dialog/web-recorder-dialog";

// Minimal OneAway-branded recorder shown when the portal iframes this route (?embed=1). No Cap chooser,
// desktop-app upsell, or FAQ — just a clean surface with the browser recorder. The controls live inside
// the portal's UI via this iframe; Cap remains the upload/storage/transcription engine underneath.
export function EmbedRecorder() {
	// The recorder DIALOG + floating control bar are Radix portals mounted at document.body — OUTSIDE any
	// wrapper we style — so a `.dark` class on a container can't reach them. Stamp `.dark` on the document
	// root while the embed is mounted so the whole surface (dialog included) matches the dark portal.
	useEffect(() => {
		const el = document.documentElement;
		const had = el.classList.contains("dark");
		el.classList.add("dark");
		el.style.background = "#0a0a0a";
		document.body.style.background = "#0a0a0a";
		// Clear the embed flag now that the recorder has rendered, so navigating Cap's other dashboard
		// pages later doesn't strip their nav (bare mode is only for this recorder iframe).
		document.cookie = "tape_embed=; Max-Age=0; Path=/; SameSite=None; Secure";
		return () => {
			if (!had) el.classList.remove("dark");
			el.style.background = "";
			document.body.style.background = "";
		};
	}, []);

	return (
		<div className="dark min-h-screen w-full flex flex-col items-center justify-center gap-6 px-6 text-center bg-gray-1">
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
