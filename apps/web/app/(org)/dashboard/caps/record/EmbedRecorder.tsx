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
		// Clear the embed flag now that the recorder has rendered, so navigating Cap's other dashboard
		// pages later doesn't strip their nav (bare mode is only for this recorder iframe).
		// biome-ignore lint/suspicious/noDocumentCookie: clearing a single short-lived flag cookie
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
