"use client";

import { useEffect, useRef } from "react";

// Loom-style live input meter for the recorder's mic selector: a compact row of bars that pulse
// with your voice, in the brand orange (theme-aware via --orange-*). Opens its own short-lived
// audio stream off the selected device purely for analysis (never played back), and releases it
// the moment it unmounts — mic turned off, device changed, dialog closed, or recording started.
const BARS = 5;
const IDLE_SCALE = 0.16; // bars never fully collapse, so an idle mic still reads as "on"

export function MicLevelMeter({
	deviceId,
	className,
}: {
	deviceId: string;
	className?: string;
}) {
	const barRefs = useRef<Array<HTMLSpanElement | null>>([]);

	useEffect(() => {
		let stream: MediaStream | null = null;
		let ctx: AudioContext | null = null;
		let raf = 0;
		let cancelled = false;

		navigator.mediaDevices
			.getUserMedia({
				audio: deviceId ? { deviceId: { exact: deviceId } } : true,
			})
			.then((s) => {
				if (cancelled) {
					for (const t of s.getTracks()) t.stop();
					return;
				}
				stream = s;
				const Ctor =
					window.AudioContext ||
					(window as unknown as { webkitAudioContext?: typeof AudioContext })
						.webkitAudioContext;
				if (!Ctor) return;
				ctx = new Ctor();
				void ctx.resume().catch(() => {});
				const analyser = ctx.createAnalyser();
				analyser.fftSize = 64;
				analyser.smoothingTimeConstant = 0.78;
				ctx.createMediaStreamSource(s).connect(analyser);
				const bins = analyser.frequencyBinCount;
				const data = new Uint8Array(bins);
				// Sample the low-mid band, where voice energy lives.
				const usable = Math.max(BARS, Math.floor(bins * 0.6));

				const draw = () => {
					analyser.getByteFrequencyData(data);
					for (let i = 0; i < BARS; i++) {
						const lo = Math.floor((i / BARS) * usable);
						const hi = Math.max(lo + 1, Math.floor(((i + 1) / BARS) * usable));
						let sum = 0;
						// data[j] is in-bounds (lo..hi within the array); assertion only satisfies
						// tsconfig's noUncheckedIndexedAccess.
						for (let j = lo; j < hi; j++) sum += data[j]!;
						const avg = sum / (hi - lo) / 255; // 0..1
						const el = barRefs.current[i];
						if (el) {
							const scale = IDLE_SCALE + avg * (1 - IDLE_SCALE);
							el.style.transform = `scaleY(${scale.toFixed(3)})`;
						}
					}
					raf = requestAnimationFrame(draw);
				};
				draw();
			})
			.catch(() => {
				/* mic unavailable — the meter just sits at idle */
			});

		return () => {
			cancelled = true;
			if (raf) cancelAnimationFrame(raf);
			if (stream) for (const t of stream.getTracks()) t.stop();
			if (ctx) void ctx.close().catch(() => {});
		};
	}, [deviceId]);

	return (
		<span
			aria-hidden
			className={className}
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: "2px",
				height: "14px",
			}}
		>
			{Array.from({ length: BARS }).map((_, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static bar list
					key={i}
					ref={(el) => {
						barRefs.current[i] = el;
					}}
					style={{
						width: "2.5px",
						height: "14px",
						borderRadius: "2px",
						background: "var(--orange-9)",
						transform: `scaleY(${IDLE_SCALE})`,
						transformOrigin: "center",
						willChange: "transform",
					}}
				/>
			))}
		</span>
	);
}
