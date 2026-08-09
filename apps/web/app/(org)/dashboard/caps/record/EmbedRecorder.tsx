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
					// Return the user to the portal Tapes board. Browsers BLOCK programmatic cross-tab focus, so
					// the old window.opener.focus()+close() could NOT reliably bring the board tab forward — the
					// recorder tab just closed and the browser landed on whatever tab was adjacent. Instead we
					// NAVIGATE this tab to the board URL the portal signed into the recorder URL (returnTo), so
					// we deterministically land on the board. The finished tape appears via the portal's
					// server-side reconcile regardless. Only absolute https URLs are honored.
					let returnTo = "";
					try {
						returnTo = new URLSearchParams(window.location.search).get("returnTo") ?? "";
					} catch {
						returnTo = "";
					}
					if (returnTo && /^https:\/\/[^/]+/i.test(returnTo)) {
						window.location.replace(returnTo); // replace() so Back doesn't return to the finished recorder
						return;
					}
					// No returnTo (older launcher, or the param was stripped) → best-effort self-close; the
					// reconcile still surfaces the tape on the board whenever the user gets back to it.
					try {
						window.close();
					} catch {
						/* ignore */
					}
				}}
			/>
		</div>
	);
}
