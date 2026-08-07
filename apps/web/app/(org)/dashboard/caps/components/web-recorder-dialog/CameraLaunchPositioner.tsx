"use client";

import { useEffect, useRef, useState } from "react";
import {
	type BubbleCorner,
	type BubblePosition,
	computeBubbleMetrics,
	PREVIEW_GEOM,
	resolveBubbleCenter,
} from "./cameraCompositor";

const CORNERS: BubbleCorner[] = ["tl", "tr", "bl", "br"];

const activeCorner = (p: BubblePosition): BubbleCorner =>
	p.mode === "corner"
		? p.corner
		: (`${p.ny < 0.5 ? "t" : "b"}${p.nx < 0.5 ? "l" : "r"}` as BubbleCorner);

// Launch-screen camera positioner. A preview of the recording frame with your LIVE camera as the bubble,
// snapping to one of FOUR corners — click a corner to place it; the other three show a ghost target so it's
// obvious you can move it. Uses the compositor's own geometry so the corner you pick is exactly where it
// bakes. The camera is NOT shown during recording — this is the one place you position it.
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
	const hoverRef = useRef<BubbleCorner | null>(null);
	const [hoverCorner, setHoverCorner] = useState<BubbleCorner | null>(null);
	posRef.current = position;
	hoverRef.current = hoverCorner;

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

	// rAF draw loop — visible launch screen, so rAF is fine.
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

					const { r } = computeBubbleMetrics(cssW, cssH, PREVIEW_GEOM);
					const active = activeCorner(posRef.current);
					for (const corner of CORNERS) {
						const { cx, cy } = resolveBubbleCenter(
							{ mode: "corner", corner },
							cssW,
							cssH,
							PREVIEW_GEOM,
						);
						if (corner === active) {
							// Soft shadow disc + the live camera bubble (no ring).
							ctx.save();
							ctx.beginPath();
							ctx.arc(cx, cy, r, 0, Math.PI * 2);
							ctx.shadowColor = "rgba(0,0,0,0.55)";
							ctx.shadowBlur = r * 0.3;
							ctx.shadowOffsetY = r * 0.06;
							ctx.fillStyle = "#000";
							ctx.fill();
							ctx.restore();
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
						} else {
							// Ghost target: dashed ring + "+" — click to move the camera here.
							const hovered = hoverRef.current === corner;
							ctx.save();
							ctx.beginPath();
							ctx.arc(cx, cy, r, 0, Math.PI * 2);
							ctx.setLineDash([5, 5]);
							ctx.lineWidth = 1.5;
							ctx.strokeStyle = hovered
								? "rgba(253,79,3,0.95)"
								: "rgba(255,255,255,0.26)";
							ctx.stroke();
							ctx.setLineDash([]);
							ctx.fillStyle = hovered
								? "rgba(253,79,3,0.95)"
								: "rgba(255,255,255,0.38)";
							ctx.font = "600 18px ui-sans-serif, system-ui, sans-serif";
							ctx.textAlign = "center";
							ctx.textBaseline = "middle";
							ctx.fillText("+", cx, cy);
							ctx.restore();
						}
					}
				}
			}
			raf = requestAnimationFrame(draw);
		};
		raf = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(raf);
	}, [mirror]);

	const cornerAt = (clientX: number, clientY: number): BubbleCorner | null => {
		const canvas = canvasRef.current;
		if (!canvas) return null;
		const rect = canvas.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
		return `${y < rect.height / 2 ? "t" : "b"}${x < rect.width / 2 ? "l" : "r"}` as BubbleCorner;
	};

	return (
		<canvas
			ref={canvasRef}
			data-testid="camera-launch-positioner"
			aria-label="Click a corner to place your camera on the recording"
			onPointerMove={(e) => setHoverCorner(cornerAt(e.clientX, e.clientY))}
			onPointerLeave={() => setHoverCorner(null)}
			onClick={(e) => {
				const corner = cornerAt(e.clientX, e.clientY);
				if (corner) onChange({ mode: "corner", corner });
			}}
			className={className}
			style={{
				width: "100%",
				height: "100%",
				display: "block",
				cursor: "pointer",
				touchAction: "none",
			}}
		/>
	);
}
