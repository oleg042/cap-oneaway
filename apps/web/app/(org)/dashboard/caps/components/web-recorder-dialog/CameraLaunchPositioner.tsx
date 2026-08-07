"use client";

import { useEffect, useRef, useState } from "react";
import {
	type BubblePosition,
	computeBubbleMetrics,
	normalizedFromPoint,
	PREVIEW_GEOM,
	resolveBubbleCenter,
} from "./cameraCompositor";

// Launch-screen camera positioner. A large 16:9 preview of the recording frame with the LIVE camera drawn
// as the bubble exactly where it will composite onto the video — drag it anywhere to place it. Uses the
// compositor's own geometry (PREVIEW_GEOM + resolveBubbleCenter/normalizedFromPoint) so the spot picked
// here is the spot it bakes. The camera is NOT shown during recording, so this is the ONE place to position
// it — hence the explicit note the parent renders beneath.
export function CameraLaunchPositioner({
	cameraStream,
	position,
	onChange,
	mirror = true,
	className,
}: {
	cameraStream: MediaStream | null;
	position: BubblePosition;
	onChange: (p: BubblePosition) => void;
	mirror?: boolean;
	className?: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const posRef = useRef(position);
	const draggingRef = useRef(false);
	const [dragging, setDragging] = useState(false);
	posRef.current = position;

	// Hidden <video> we sample the live camera from.
	useEffect(() => {
		const v = document.createElement("video");
		v.muted = true;
		v.playsInline = true;
		v.autoplay = true;
		videoRef.current = v;
		return () => {
			try {
				v.srcObject = null;
			} catch {
				/* ignore */
			}
			videoRef.current = null;
		};
	}, []);
	useEffect(() => {
		const v = videoRef.current;
		if (!v) return;
		v.srcObject = cameraStream ?? null;
		if (cameraStream) v.play().catch(() => {});
	}, [cameraStream]);

	// rAF draw loop — this is the visible launch screen, so rAF is fine (no background-tab concern here).
	useEffect(() => {
		let raf = 0;
		const draw = () => {
			const canvas = canvasRef.current;
			const video = videoRef.current;
			if (canvas) {
				const dpr = Math.min(window.devicePixelRatio || 1, 2);
				const cssW = canvas.clientWidth;
				const cssH = canvas.clientHeight;
				if (
					cssW > 0 &&
					(canvas.width !== Math.round(cssW * dpr) ||
						canvas.height !== Math.round(cssH * dpr))
				) {
					canvas.width = Math.round(cssW * dpr);
					canvas.height = Math.round(cssH * dpr);
				}
				const ctx = canvas.getContext("2d");
				if (ctx && cssW > 0) {
					ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
					ctx.clearRect(0, 0, cssW, cssH);
					// Neutral "your screen" backdrop.
					const g = ctx.createLinearGradient(0, 0, 0, cssH);
					g.addColorStop(0, "#161616");
					g.addColorStop(1, "#0b0b0b");
					ctx.fillStyle = g;
					ctx.fillRect(0, 0, cssW, cssH);
					ctx.strokeStyle = "rgba(255,255,255,0.06)";
					ctx.lineWidth = 1;
					ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);
					ctx.fillStyle = "rgba(255,255,255,0.14)";
					ctx.font = "500 12px ui-sans-serif, system-ui, sans-serif";
					ctx.textAlign = "center";
					ctx.textBaseline = "middle";
					ctx.fillText("your screen", cssW / 2, cssH / 2);

					const { r } = computeBubbleMetrics(cssW, cssH, PREVIEW_GEOM);
					const { cx, cy } = resolveBubbleCenter(
						posRef.current,
						cssW,
						cssH,
						PREVIEW_GEOM,
					);
					// Soft shadow disc (the only edge treatment — no ring).
					ctx.save();
					ctx.beginPath();
					ctx.arc(cx, cy, r, 0, Math.PI * 2);
					ctx.shadowColor = "rgba(0,0,0,0.55)";
					ctx.shadowBlur = r * 0.3;
					ctx.shadowOffsetY = r * 0.06;
					ctx.fillStyle = "#000";
					ctx.fill();
					ctx.restore();
					// Clip to circle + draw the live camera (object-fit: cover, mirrored).
					ctx.save();
					ctx.beginPath();
					ctx.arc(cx, cy, r, 0, Math.PI * 2);
					ctx.clip();
					if (video && video.readyState >= 2 && video.videoWidth) {
						const vw = video.videoWidth;
						const vh = video.videoHeight;
						const scale = Math.max((2 * r) / vw, (2 * r) / vh);
						const dw = vw * scale;
						const dh = vh * scale;
						ctx.translate(cx, cy);
						if (mirror) ctx.scale(-1, 1);
						ctx.drawImage(video, -dw / 2, -dh / 2, dw, dh);
					} else {
						ctx.fillStyle = "#1c1c1c";
						ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
					}
					ctx.restore();
					// Brand ring while dragging, as a grab affordance.
					if (draggingRef.current) {
						ctx.save();
						ctx.beginPath();
						ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
						ctx.strokeStyle = "rgba(253,79,3,0.95)";
						ctx.lineWidth = 2.5;
						ctx.stroke();
						ctx.restore();
					}
				}
			}
			raf = requestAnimationFrame(draw);
		};
		raf = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(raf);
	}, [mirror]);

	const applyPointer = (clientX: number, clientY: number) => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const { nx, ny } = normalizedFromPoint(
			clientX - rect.left,
			clientY - rect.top,
			rect.width,
			rect.height,
			PREVIEW_GEOM,
		);
		onChange({ mode: "free", nx, ny });
	};

	return (
		<canvas
			ref={canvasRef}
			data-testid="camera-launch-positioner"
			aria-label="Drag to position your camera on the recording"
			onPointerDown={(e) => {
				draggingRef.current = true;
				setDragging(true);
				try {
					e.currentTarget.setPointerCapture(e.pointerId);
				} catch {
					/* ignore */
				}
				applyPointer(e.clientX, e.clientY);
			}}
			onPointerMove={(e) => {
				if (draggingRef.current) applyPointer(e.clientX, e.clientY);
			}}
			onPointerUp={(e) => {
				draggingRef.current = false;
				setDragging(false);
				try {
					e.currentTarget.releasePointerCapture(e.pointerId);
				} catch {
					/* ignore */
				}
			}}
			className={className}
			style={{
				width: "100%",
				aspectRatio: "16 / 9",
				borderRadius: 12,
				display: "block",
				cursor: dragging ? "grabbing" : "grab",
				touchAction: "none",
			}}
		/>
	);
}
