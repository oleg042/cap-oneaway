"use client";

import { useEffect } from "react";
import { WebRecorderDialog } from "../components/web-recorder-dialog/web-recorder-dialog";

// Minimal OneAway-branded recorder shown when the portal opens this route (?embed=1) in a NEW TAB. No
// Cap chooser, desktop-app upsell, or FAQ — just a clean full-page branded recorder. Cap remains the
// upload/storage/transcription engine underneath. `portalOrigin` (passed by the portal through the SSO
// redirect) is the exact origin we message on completion via window.opener, then this tab self-closes.
export function EmbedRecorder({
	portalOrigin,
}: {
	portalOrigin?: string;
} = {}) {
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
				onRecorded={(info) => {
					// The portal opened this recorder in a new tab, so window.opener IS the portal tab. Tell it
					// the tape is done (it optimistically inserts + selects the row), then close this tab so the
					// user is left back on their content/portal tab. Message ONLY the exact portalOrigin the
					// portal passed through the SSO redirect — never "*", since the payload carries a share URL.
					// Falls back to window.parent if this is ever iframed instead of opened as a tab.
					let target: string | null = null;
					try {
						if (portalOrigin && new URL(portalOrigin).origin === portalOrigin) {
							target = portalOrigin;
						}
					} catch {
						target = null;
					}
					const opener = (window.opener as Window | null) ?? null;
					const dest =
						opener && opener !== window
							? opener
							: window.parent !== window
								? window.parent
								: null;
					if (dest && target) {
						try {
							dest.postMessage(
								{
									type: "tape:recorded",
									videoId: info.videoId,
									shareUrl: info.shareUrl,
								},
								target,
							);
						} catch {
							/* ignore */
						}
					}
					// Standalone tab opened by the portal → hand off then close.
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
