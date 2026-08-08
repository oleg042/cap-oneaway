"use client";

import { useEffect, useRef, useState } from "react";

// Cross-tab guard: warn when ANOTHER tab is already recording, so a stray second "Record" click doesn't
// silently start a parallel take. Concurrent recordings are technically safe (each tab = its own Cap video
// + R2 keys + IndexedDB spool), so this is a UX nudge, not a hard lock. Same-origin BroadcastChannel; a
// channel never receives its OWN posts, so our heartbeats warn peers without self-triggering.
const CHANNEL = "oa-tape-recording";
const BEAT_MS = 2000;
const STALE_MS = 6000;

export function useConcurrentRecordingWarning(isRecording: boolean): boolean {
	const [otherTabRecording, setOtherTabRecording] = useState(false);
	const chRef = useRef<BroadcastChannel | null>(null);

	// Listener (always on): a peer's heartbeat flips the warning; its "stopped" (or staleness) clears it.
	useEffect(() => {
		if (typeof BroadcastChannel === "undefined") return;
		const ch = new BroadcastChannel(CHANNEL);
		chRef.current = ch;
		let lastSeen = 0;
		const onMsg = (e: MessageEvent) => {
			const t = (e.data as { t?: string } | null)?.t;
			if (t === "recording") {
				lastSeen =
					typeof performance !== "undefined" ? performance.now() : Date.now();
				setOtherTabRecording(true);
			} else if (t === "stopped") {
				lastSeen = 0;
				setOtherTabRecording(false);
			}
		};
		ch.addEventListener("message", onMsg);
		const sweep = setInterval(() => {
			const now =
				typeof performance !== "undefined" ? performance.now() : Date.now();
			if (lastSeen && now - lastSeen > STALE_MS) {
				lastSeen = 0;
				setOtherTabRecording(false);
			}
		}, STALE_MS / 2);
		return () => {
			ch.removeEventListener("message", onMsg);
			clearInterval(sweep);
			ch.close();
			chRef.current = null;
		};
	}, []);

	// Broadcaster: while WE record, heartbeat so other tabs can warn; announce "stopped" on the way out.
	useEffect(() => {
		if (!isRecording) return;
		const ch = chRef.current;
		if (!ch) return;
		const beat = () => {
			try {
				ch.postMessage({ t: "recording" });
			} catch {
				/* channel closing */
			}
		};
		beat();
		const iv = setInterval(beat, BEAT_MS);
		return () => {
			clearInterval(iv);
			try {
				ch.postMessage({ t: "stopped" });
			} catch {
				/* channel closing */
			}
		};
	}, [isRecording]);

	return otherTabRecording;
}
