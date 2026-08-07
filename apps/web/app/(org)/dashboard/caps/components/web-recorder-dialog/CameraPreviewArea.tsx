"use client";

import { Video, VideoOff } from "lucide-react";
import { CameraLaunchPositioner } from "./CameraLaunchPositioner";
import type { BubblePosition } from "./cameraCompositor";

// The big right-hand preview on the recorder setup screen. Shows WHERE the camera bakes onto the recording
// (a 16:9 frame with the live camera bubble snapped to a corner), with an explicit how-it-works card + an
// on/off toggle overlaid in the middle. When the camera is off, the whole area becomes a large "turn it on"
// call-to-action so the behaviour is impossible to miss.
export function CameraPreviewArea({
	cameraStream,
	cameraOn,
	canEnableCamera,
	onToggleCamera,
	position,
	onPositionChange,
}: {
	cameraStream: MediaStream | null;
	cameraOn: boolean;
	canEnableCamera: boolean;
	onToggleCamera: () => void;
	position: BubblePosition;
	onPositionChange: (p: BubblePosition) => void;
}) {
	return (
		<div
			className="relative w-full overflow-hidden rounded-xl border border-gray-4 bg-gray-1"
			style={{ aspectRatio: "16 / 9" }}
			data-testid="tape-camera-preview"
		>
			{cameraOn ? (
				<>
					<CameraLaunchPositioner
						cameraStream={cameraStream}
						position={position}
						onChange={onPositionChange}
					/>
					{/* Explainer + toggle, overlaid dead-center. Only the card takes pointer events, so the
					    corner targets around it stay clickable. */}
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
						<div className="pointer-events-auto max-w-[400px] rounded-2xl border border-gray-5 bg-gray-2/85 px-7 py-6 text-center shadow-xl backdrop-blur-sm">
							<div className="flex items-center justify-center gap-2 text-[17px] font-medium text-gray-12">
								<Video className="h-5 w-5" style={{ color: "#FD4F03" }} />
								Camera is on
							</div>
							<p className="mt-2.5 text-[14px] leading-relaxed text-gray-11">
								You won't see it while you record — it's painted onto the video.
								Click a corner to place it.
							</p>
							<button
								type="button"
								onClick={onToggleCamera}
								className="mt-4 inline-flex items-center gap-2 rounded-lg border border-gray-6 px-4 py-2 text-[14px] text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12"
							>
								<VideoOff className="h-4 w-4" />
								Turn camera off
							</button>
						</div>
					</div>
				</>
			) : (
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
					<button
						type="button"
						onClick={onToggleCamera}
						disabled={!canEnableCamera}
						data-testid="tape-camera-enable"
						className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[14px] font-semibold text-white shadow-lg transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50"
						style={{ background: "#FD4F03" }}
					>
						<Video className="h-4 w-4" />
						Turn camera on
					</button>
					<p className="max-w-[320px] text-[12px] leading-relaxed text-gray-11">
						Your camera is added straight onto the video. Turn it on to place it
						in a corner of your recording — you won't see it while recording,
						only on the finished tape.
					</p>
					{!canEnableCamera && (
						<p className="text-[11px] text-gray-9">No camera detected.</p>
					)}
				</div>
			)}
		</div>
	);
}
