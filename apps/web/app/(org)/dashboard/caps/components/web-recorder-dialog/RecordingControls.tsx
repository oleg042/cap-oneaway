"use client";

import { Button } from "@cap/ui";
import { Mic, MicOff, Pause, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MicLevelMeter } from "./MicLevelMeter";

const fmtDuration = (ms: number): string => {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
};

// Big live preview of the EXACT composited capture (screen + camera bubble) being recorded — fills the same
// right column the camera preview occupies during setup. Read-only: srcObject only, muted, never the tracks
// stopped (they belong to the active recording).
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
		const attach = () => {
			if (cancelled) return;
			const stream = getStream();
			if (stream) {
				v.srcObject = stream;
				void v.play().catch(() => {});
			} else {
				setTimeout(attach, 200); // composited stream not live yet — retry briefly
			}
		};
		attach();
		return () => {
			cancelled = true;
			if (v) v.srcObject = null;
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: attach once on mount
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
	onCancel: () => void;
}

// The left-panel control set WHILE recording — the launcher panel becomes this. Timer + status, a live mic
// level, Stop & save / Pause·Resume, and a confirm-gated Cancel & discard (which wipes the pending video +
// any R2 chunks upstream).
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
	onCancel,
}: RecordingControlsProps) {
	const [confirmCancel, setConfirmCancel] = useState(false);
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
					className="flex size-[2.25rem] shrink-0 items-center justify-center rounded-lg border border-gray-3 text-gray-11 transition-colors hover:bg-gray-3/50 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{isPaused ? <Play className="size-4" /> : <Pause className="size-4" />}
				</button>
			</div>

			{/* cancel & discard — confirm-gated (destructive: deletes the recording + any uploaded chunks) */}
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
							className="flex-grow rounded-lg border border-gray-4 py-1.5 text-[0.8rem] text-gray-12 transition-colors hover:bg-gray-3/50 disabled:opacity-50"
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
				<button
					type="button"
					onClick={() => setConfirmCancel(true)}
					disabled={busy}
					className="text-[0.8rem] text-gray-11 transition-colors hover:text-red-11 disabled:opacity-50"
				>
					Cancel &amp; discard
				</button>
			)}
		</div>
	);
}
