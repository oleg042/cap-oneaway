"use client";

import { useEffect } from "react";
import { WebRecorderDialog } from "../components/web-recorder-dialog/web-recorder-dialog";

// Minimal OneAway-branded recorder shown when the portal opens this route (?embed=1) in a NEW TAB. No
// Cap chooser, desktop-app upsell, or FAQ — just a clean full-page branded recorder. Cap remains the
// upload/storage/transcription engine underneath. On completion this tab simply self-closes; the portal
// surfaces the finished tape by reconciling from Cap server-side (it polls), so there's no cross-tab
// postMessage — nothing for a forged opener to receive a share URL from.
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
		// NB: the tape_embed cookie is durable + scoped to this record route (set httpOnly by the SSO route),
		// so the recorder stays bare across reloads and we never touch it client-side. Path-scoping keeps bare
		// mode confined to this page; Cap's other dashboard routes are also proxy-locked to the portal anyway.
		return () => {
			if (!had) el.classList.remove("dark");
			el.style.background = "";
			document.body.style.background = "";
		};
	}, []);

	return (
		<div className="dark relative min-h-screen w-full bg-gray-1">
			{/* Browser is the only way to record here, so there's no "Record in Browser" step — the launcher
			    opens straight away and fills the window. This spinner is just the brief loading state, covered
			    the moment the controls appear. */}
			<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
				<span
					className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-gray-6"
					style={{ borderTopColor: "#FD4F03" }}
					aria-hidden="true"
				/>
				<span className="text-[13px] text-gray-9">Starting recorder…</span>
			</div>
			<WebRecorderDialog
				embed
				onRecorded={() => {
					// The portal opened this recorder in a new tab and reconciles the finished tape server-side
					// (it polls Cap), so there's nothing to hand back here — just close this tab so the user
					// lands back on their content/portal tab. No cross-tab postMessage → no share URL to leak.
					const opener = (window.opener as Window | null) ?? null;
					if (opener && opener !== window) {
						setTimeout(() => {
							try {
								window.close();
							} catch {
								/* ignore */
							}
						}, 600);
					}
				}}
			/>
		</div>
	);
}
