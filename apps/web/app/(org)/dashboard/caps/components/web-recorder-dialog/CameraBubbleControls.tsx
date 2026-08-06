"use client";

import clsx from "clsx";
import {
	Camera,
	CornerDownLeft,
	CornerDownRight,
	CornerUpLeft,
	CornerUpRight,
	FlipHorizontal,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	type BubbleCorner,
	type BubblePosition,
	computeBubbleMetrics,
	nextCorner,
	normalizedFromPoint,
	PREVIEW_GEOM,
	resolveBubbleCenter,
} from "./cameraCompositor";

interface CameraBubbleControlsProps {
	position: BubblePosition;
	mirror: boolean;
	// Pad aspect ratio (width / height). Match the recording surface; 16/9 pre-record when the screen
	// isn't shared yet. Keeps the drag preview visually faithful to where the bubble lands in the video.
	aspect: number;
	onCorner: (corner: BubbleCorner) => void;
	onNormalized: (nx: number, ny: number) => void;
	onToggleMirror: () => void;
	previewStream?: MediaStream | null;
	className?: string;
}

const CORNERS: Array<{
	corner: BubbleCorner;
	label: string;
	Icon: typeof CornerUpLeft;
	pos: string;
}> = [
	{ corner: "tl", label: "Top left", Icon: CornerUpLeft, pos: "top-1 left-1" },
	{
		corner: "tr",
		label: "Top right",
		Icon: CornerUpRight,
		pos: "top-1 right-1",
	},
	{
		corner: "bl",
		label: "Bottom left",
		Icon: CornerDownLeft,
		pos: "bottom-1 left-1",
	},
	{
		corner: "br",
		label: "Bottom right",
		Icon: CornerDownRight,
		pos: "bottom-1 right-1",
	},
];

// Shared pre-record + mid-record control for the round camera bubble: snap to a corner, drag anywhere,
// or mirror. Reuses the compositor's own geometry so the on-screen thumb matches the baked bubble.
export const CameraBubbleControls = ({
	position,
	mirror,
	aspect,
	onCorner,
	onNormalized,
	onToggleMirror,
	previewStream,
	className,
}: CameraBubbleControlsProps) => {
	const padRef = useRef<HTMLDivElement>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const [pad, setPad] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
	const [dragging, setDragging] = useState(false);

	// Track the pad's rendered pixel size so thumb placement + pointer math use real coordinates.
	useLayoutEffect(() => {
		const el = padRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const measure = () => setPad({ w: el.clientWidth, h: el.clientHeight });
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.srcObject = previewStream ?? null;
		if (previewStream) void video.play().catch(() => {});
	}, [previewStream]);

	const applyFromEvent = (clientX: number, clientY: number) => {
		const el = padRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const { nx, ny } = normalizedFromPoint(
			clientX - rect.left,
			clientY - rect.top,
			rect.width,
			rect.height,
			PREVIEW_GEOM,
		);
		onNormalized(nx, ny);
	};

	const activeCorner = position.mode === "corner" ? position.corner : null;

	const metrics =
		pad.w > 0 ? computeBubbleMetrics(pad.w, pad.h, PREVIEW_GEOM) : null;
	const center =
		pad.w > 0
			? resolveBubbleCenter(position, pad.w, pad.h, PREVIEW_GEOM)
			: null;

	return (
		<div className={clsx("flex flex-col gap-2", className)}>
			<div className="flex items-center justify-between">
				<span className="text-[11px] font-medium uppercase tracking-wide text-gray-10">
					Camera bubble
				</span>
				<button
					type="button"
					onClick={onToggleMirror}
					aria-pressed={mirror}
					aria-label="Mirror camera"
					title="Mirror camera"
					className={clsx(
						"flex size-7 items-center justify-center rounded-lg text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12",
						mirror && "bg-gray-3 text-gray-12",
					)}
				>
					<FlipHorizontal className="size-4" />
				</button>
			</div>

			<div
				ref={padRef}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: custom pointer + arrow-key positioning control
				tabIndex={0}
				role="application"
				aria-label="Camera bubble position — drag, or use arrow keys to hop between corners"
				className="relative w-full overflow-hidden rounded-xl border border-gray-5 bg-gray-1 select-none touch-none focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-8"
				style={{
					aspectRatio: String(aspect),
					cursor: dragging ? "grabbing" : "crosshair",
				}}
				onKeyDown={(e) => {
					const c = nextCorner(position, e.key);
					if (c) {
						e.preventDefault();
						onCorner(c);
					}
				}}
				onPointerDown={(e) => {
					if ((e.target as HTMLElement).closest("[data-corner-btn]")) return;
					e.preventDefault();
					(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
					setDragging(true);
					applyFromEvent(e.clientX, e.clientY);
				}}
				onPointerMove={(e) => {
					if (!dragging) return;
					applyFromEvent(e.clientX, e.clientY);
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
				{/* Round thumb — the live self-view (or a camera glyph), placed exactly where the bubble bakes. */}
				{metrics && center && (
					<div
						className="pointer-events-none absolute flex items-center justify-center rounded-full bg-gray-4 ring-2 ring-white/80 shadow-lg overflow-hidden"
						style={{
							width: `${metrics.D}px`,
							height: `${metrics.D}px`,
							left: `${center.cx - metrics.r}px`,
							top: `${center.cy - metrics.r}px`,
						}}
					>
						{previewStream ? (
							<video
								ref={videoRef}
								autoPlay
								playsInline
								muted
								className="h-full w-full object-cover"
								style={{ transform: mirror ? "scaleX(-1)" : "scaleX(1)" }}
							/>
						) : (
							<Camera className="size-4 text-gray-11" />
						)}
					</div>
				)}

				{/* Corner-snap buttons, one at each pad corner. */}
				{CORNERS.map(({ corner, label, Icon, pos }) => (
					<button
						key={corner}
						type="button"
						data-corner-btn
						onPointerDown={(e) => e.stopPropagation()}
						onClick={(e) => {
							e.stopPropagation();
							onCorner(corner);
						}}
						aria-label={`Snap camera to ${label.toLowerCase()}`}
						aria-pressed={activeCorner === corner}
						className={clsx(
							"absolute flex size-6 items-center justify-center rounded-md border border-gray-5 text-gray-11 backdrop-blur-sm transition-colors hover:bg-gray-3 hover:text-gray-12",
							pos,
							activeCorner === corner
								? "bg-gray-3 text-gray-12"
								: "bg-gray-2/70",
						)}
					>
						<Icon className="size-3.5" />
					</button>
				))}
			</div>
			<span className="text-[10px] leading-snug text-gray-10">
				Drag, tap a corner, or use arrow keys. You can move it while recording.
			</span>
		</div>
	);
};
