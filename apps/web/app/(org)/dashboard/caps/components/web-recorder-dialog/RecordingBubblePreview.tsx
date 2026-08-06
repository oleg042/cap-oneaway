"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	type BubbleGeometryOptions,
	type BubblePosition,
	computeBubbleMetrics,
	normalizedFromPoint,
	resolveBubbleCenter,
} from "./cameraCompositor";

// The on-screen live camera bubble shown WHILE recording, so you can see yourself and where the bubble
// sits — and drag it (or use the corner/arrow controls) to move it. The recording itself is composited
// separately; this is the live view + position handle. It maps the same normalized position into the
// viewport, so dragging it here moves the baked bubble to the matching corner of the frame.
//
// Note: when you share your WHOLE screen, this on-screen bubble is part of the screen, so it can also
// appear in the recording (alongside the composited one). For window/tab shares it's a pure guide.
const FLOATING_GEOM: BubbleGeometryOptions = {
	diameterFraction: 0.15,
	marginFraction: 0.035,
	minD: 104,
	maxD: 200,
	minMargin: 20,
};

interface RecordingBubblePreviewProps {
	stream: MediaStream | null;
	position: BubblePosition;
	mirror: boolean;
	onNormalized: (nx: number, ny: number) => void;
}

export function RecordingBubblePreview({
	stream,
	position,
	mirror,
	onNormalized,
}: RecordingBubblePreviewProps) {
	const [viewport, setViewport] = useState(() =>
		typeof window === "undefined"
			? { w: 1440, h: 900 }
			: { w: window.innerWidth, h: window.innerHeight },
	);
	const [dragging, setDragging] = useState(false);
	const videoRef = useRef<HTMLVideoElement>(null);

	useEffect(() => {
		const onResize = () =>
			setViewport({ w: window.innerWidth, h: window.innerHeight });
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.srcObject = stream ?? null;
		if (stream) void video.play().catch(() => {});
	}, [stream]);

	if (typeof document === "undefined") return null;

	const { D, r } = computeBubbleMetrics(viewport.w, viewport.h, FLOATING_GEOM);
	const { cx, cy } = resolveBubbleCenter(
		position,
		viewport.w,
		viewport.h,
		FLOATING_GEOM,
	);

	return createPortal(
		<div
			// biome-ignore lint/a11y/noStaticElementInteractions: draggable live camera bubble (position handle)
			className="fixed z-[660] overflow-hidden rounded-full bg-black ring-2 ring-white/85 shadow-[0_10px_40px_rgba(0,0,0,0.5)] touch-none"
			style={{
				width: `${D}px`,
				height: `${D}px`,
				left: `${cx - r}px`,
				top: `${cy - r}px`,
				cursor: dragging ? "grabbing" : "grab",
			}}
			onPointerDown={(e) => {
				e.preventDefault();
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
				setDragging(true);
			}}
			onPointerMove={(e) => {
				if (!dragging) return;
				const { nx, ny } = normalizedFromPoint(
					e.clientX,
					e.clientY,
					viewport.w,
					viewport.h,
					FLOATING_GEOM,
				);
				onNormalized(nx, ny);
			}}
			onPointerUp={(e) => {
				setDragging(false);
				try {
					(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
				} catch {
					/* ignore */
				}
			}}
			onPointerCancel={() => setDragging(false)}
		>
			<video
				ref={videoRef}
				autoPlay
				playsInline
				muted
				className="h-full w-full object-cover"
				style={{ transform: mirror ? "scaleX(-1)" : "scaleX(1)" }}
			/>
		</div>,
		document.body,
	);
}
