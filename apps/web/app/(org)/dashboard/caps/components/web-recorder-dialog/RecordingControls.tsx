"use client";

import { Button } from "@cap/ui";
import { Mic, MicOff, Pause, Play, RotateCcw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MicLevelMeter } from "./MicLevelMeter";

const fmtDuration = (ms: number): string => {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
};

// Big live preview of the EXACT composited capture (screen + camera bubble) being recorded — fills the same
// right column the camera preview occupies during setup. Read-only: srcObject only, muted, never the tracks
// stopped (they belong to the active recording). Polls getStream so a RESTART (which swaps in a brand-new
// mixedStream) re-attaches without a remount — otherwise the <video> would freeze on the old, stopped frame.
export function LiveCaptureView({
	getStream,
}: {
	getStream: () => MediaStream | null;
}) {
	const videoRef = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		const v = videoRef.current;
		if (!v) return;
		let cancelled = false;
		let attached: MediaStream | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			if (cancelled) return;
			const stream = getStream();
			if (stream && stream !== attached) {
				attached = stream;
				v.srcObject = stream;
				void v.play().catch(() => {});
			}
			// Re-check on a short interval: the stream isn't live on the first tick, and a restart replaces it.
			timer = setTimeout(tick, 250);
		};
		tick();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
			if (v) v.srcObject = null;
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: getStream reads live refs; poll handles swaps
	}, []);
	return (
		<div className="relative w-full overflow-hidden rounded-xl border border-gray-4 bg-black">
			<video
				ref={videoRef}
				muted
				autoPlay
				playsInline
				className="block aspect-video w-full bg-black object-contain"
			/>
			<div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
				<span className="inline-block size-1.5 animate-pulse rounded-full bg-red-500" />
				What you're capturing
			</div>
		</div>
	);
}

interface RecordingControlsProps {
	durationMs: number;
	isPaused: boolean;
	hasAudioTrack: boolean;
	micDeviceId?: string | null;
	busy?: boolean;
	canPause?: boolean;
	onStop: () => void;
	onPause?: () => void;
	onResume?: () => void;
	onRestart?: () => void;
	onCancel: () => void;
}

// The left-panel control set WHILE recording — the launcher panel becomes this. Timer + status, a live mic
// level, Stop & save / Pause·Resume, a one-click Restart (scrap this take → wipes the pending video + any R2
// chunks, then re-records), and a confirm-gated Cancel & discard (same wipe, but back to setup).
export function RecordingControls({
	durationMs,
	isPaused,
	hasAudioTrack,
	micDeviceId,
	busy = false,
	canPause = true,
	onStop,
	onPause,
	onResume,
	onRestart,
	onCancel,
}: RecordingControlsProps) {
	const [confirmCancel, setConfirmCancel] = useState(false);
	// Shared look for the two secondary actions so they clearly read as buttons (not caption text).
	const secondaryBtn =
		"flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-gray-5 py-[0.5rem] text-[0.8rem] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
	return (
		<div className="flex flex-col gap-[0.75rem] text-gray-12">
			{/* status + timer */}
			<div className="flex h-[2rem] items-center gap-2 rounded-lg border border-gray-3 px-[0.5rem]">
				<span
					className={`inline-block size-2 rounded-full bg-red-500 ${isPaused ? "" : "animate-pulse"}`}
				/>
				<span className="text-[0.875rem] font-medium">
					{isPaused ? "Paused" : "Recording"}
				</span>
				<span className="ml-auto font-mono text-[0.95rem] tabular-nums">
					{fmtDuration(durationMs)}
				</span>
			</div>

			{/* live mic level */}
			<div className="flex h-[2rem] items-center gap-[0.375rem] rounded-lg border border-gray-3 px-[0.5rem]">
				{hasAudioTrack ? (
					<Mic className="size-4 shrink-0 text-gray-11" />
				) : (
					<MicOff className="size-4 shrink-0 text-gray-9" />
				)}
				<span className="flex-1 truncate text-left text-[0.875rem]">
					{hasAudioTrack ? "Microphone" : "No microphone"}
				</span>
				{hasAudioTrack && !isPaused && (
					// Default brand orange (var(--orange-9)) — matches the setup mic meter; a cobalt override
					// here made the meter flip orange→blue the instant recording started.
					<MicLevelMeter deviceId={micDeviceId ?? ""} />
				)}
			</div>

			{/* primary controls */}
			<div className="flex gap-2">
				<Button
					variant="blue"
					size="md"
					onClick={onStop}
					disabled={busy}
					className="flex flex-grow items-center justify-center"
				>
					<Square className="mr-1.5 size-3.5" /> Stop &amp; save
				</Button>
				<button
					type="button"
					onClick={isPaused ? onResume : onPause}
					disabled={busy || !canPause}
					aria-label={isPaused ? "Resume recording" : "Pause recording"}
					className="flex size-[2.25rem] shrink-0 items-center justify-center rounded-lg border border-gray-5 text-gray-11 transition-colors hover:bg-gray-3 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{isPaused ? <Play className="size-4" /> : <Pause className="size-4" />}
				</button>
			</div>

			{/* secondary actions: Restart (one-click, scrap & re-record) + Cancel & discard (confirm-gated). */}
			{confirmCancel ? (
				<div className="rounded-lg border border-red-6 bg-[var(--red-3)] p-2.5 dark:bg-[var(--red-4)]">
					<p className="text-[0.8rem] leading-snug text-red-12">
						Discard this recording? It deletes the video and any chunks already
						uploaded. This can't be undone.
					</p>
					<div className="mt-2.5 flex gap-2">
						<button
							type="button"
							onClick={() => setConfirmCancel(false)}
							disabled={busy}
							className="flex-grow rounded-lg border border-gray-5 py-1.5 text-[0.8rem] text-gray-12 transition-colors hover:bg-gray-3 disabled:opacity-50"
						>
							Keep recording
						</button>
						<button
							type="button"
							onClick={onCancel}
							disabled={busy}
							className="flex-grow rounded-lg bg-[var(--red-9)] py-1.5 text-[0.8rem] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
						>
							Discard
						</button>
					</div>
				</div>
			) : (
				<div className="flex gap-2">
					{onRestart && (
						<button
							type="button"
							onClick={onRestart}
							disabled={busy}
							title="Scrap this take and start over — deletes the recording and any uploaded chunks"
							className={`${secondaryBtn} text-gray-12 hover:bg-gray-3`}
						>
							<RotateCcw className="size-3.5" /> Restart
						</button>
					)}
					<button
						type="button"
						onClick={() => setConfirmCancel(true)}
						disabled={busy}
						className={`${secondaryBtn} text-gray-11 hover:bg-gray-3 hover:text-red-11`}
					>
						Cancel &amp; discard
					</button>
				</div>
			)}
		</div>
	);
}
