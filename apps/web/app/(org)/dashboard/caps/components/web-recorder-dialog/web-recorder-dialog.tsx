"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import { MonitorIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "../../../Contexts";
import { CameraPreviewArea } from "./CameraPreviewArea";
import {
	CameraPreviewWindow,
	type CameraPreviewWindowHandle,
} from "./CameraPreviewWindow";
import { CameraSelector } from "./CameraSelector";
import { type BubblePosition, isCompositorSupported } from "./cameraCompositor";
import { HowItWorksButton } from "./HowItWorksButton";
import { HowItWorksPanel } from "./HowItWorksPanel";
import { InProgressRecordingBar } from "./InProgressRecordingBar";
import { MicrophoneSelector } from "./MicrophoneSelector";
import { RecordingButton } from "./RecordingButton";
import { RecordingCapToggle } from "./RecordingCapToggle";
import {
	type RecordingMode,
} from "./RecordingModeSelector";
import { RememberDevicesToggle } from "./RememberDevicesToggle";
import { SystemAudioToggle } from "./SystemAudioToggle";
import { useCameraDevices } from "./useCameraDevices";
import { useDevicePreferences } from "./useDevicePreferences";
import { useDialogInteractions } from "./useDialogInteractions";
import { useMicrophoneDevices } from "./useMicrophoneDevices";
import { useWebRecorder } from "./useWebRecorder";
import {
	dialogVariants,
	FREE_PLAN_MAX_RECORDING_MS,
} from "./web-recorder-constants";
import { WebRecorderDialogHeader } from "./web-recorder-dialog-header";

const recoveredRecordingTimeFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

const waitForNextFrame = () =>
	new Promise<void>((resolve) => {
		if (typeof window === "undefined") {
			resolve();
			return;
		}

		window.requestAnimationFrame(() => resolve());
	});

export const WebRecorderDialog = ({
	embed,
	onRecorded,
}: {
	embed?: boolean;
	onRecorded?: (info: { videoId: string; shareUrl: string }) => void;
} = {}) => {
	const [open, setOpen] = useState(false);
	// In the portal embed the recorder is the only thing on screen and it's always in-browser, so open the
	// controls immediately — no "Record in Browser" landing/click.
	useEffect(() => {
		if (embed) setOpen(true);
	}, [embed]);
	const [howItWorksOpen, setHowItWorksOpen] = useState(false);
	// Off by default → the 20-min auto-stop guardrail is active. Deliberately re-defaults off each time the
	// dialog opens (reset in handleOpenChange) so lifting the cap is always a conscious per-recording choice.
	const [overrideDefaultCap, setOverrideDefaultCap] = useState(false);
	const [recordingMode, setRecordingMode] =
		useState<RecordingMode>("fullscreen");
	const [cameraSelectOpen, setCameraSelectOpen] = useState(false);
	const [micSelectOpen, setMicSelectOpen] = useState(false);
	const dialogContentRef = useRef<HTMLDivElement>(null);
	const startSoundRef = useRef<HTMLAudioElement | null>(null);
	const stopSoundRef = useRef<HTMLAudioElement | null>(null);
	const cameraPreviewRef = useRef<CameraPreviewWindowHandle>(null);
	// Composited camera: where the bubble bakes onto a screen recording (set on the launch positioner), and
	// a live preview stream the positioner draws from.
	const [bubblePosition, setBubblePosition] = useState<BubblePosition>({
		mode: "corner",
		corner: "bl",
	});
	const [previewCameraStream, setPreviewCameraStream] =
		useState<MediaStream | null>(null);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}

		const startSound = new Audio("/sounds/start-recording.ogg");
		startSound.preload = "auto";
		const stopSound = new Audio("/sounds/stop-recording.ogg");
		stopSound.preload = "auto";

		startSoundRef.current = startSound;
		stopSoundRef.current = stopSound;

		return () => {
			startSound.pause();
			stopSound.pause();
			startSoundRef.current = null;
			stopSoundRef.current = null;
		};
	}, []);

	const playAudio = useCallback((audio: HTMLAudioElement | null) => {
		if (!audio) {
			return;
		}
		audio.currentTime = 0;
		void audio.play().catch(() => {
			/* ignore */
		});
	}, []);

	const handleRecordingStartSound = useCallback(() => {
		playAudio(startSoundRef.current);
	}, [playAudio]);

	const handleRecordingStopSound = useCallback(() => {
		playAudio(stopSoundRef.current);
	}, [playAudio]);

	const { activeOrganization, user } = useDashboardContext();
	const organisationId = activeOrganization?.organization.id;
	const { devices: availableMics, refresh: refreshMics } =
		useMicrophoneDevices(open);
	const { devices: availableCameras, refresh: refreshCameras } =
		useCameraDevices(open);

	const {
		rememberDevices,
		selectedCameraId,
		selectedMicId,
		systemAudioEnabled,
		setSelectedCameraId,
		handleCameraChange,
		handleMicChange,
		handleSystemAudioChange,
		handleRememberDevicesChange,
	} = useDevicePreferences({
		open,
		availableCameras,
		availableMics,
	});

	const micEnabled = selectedMicId !== null;

	useEffect(() => {
		if (
			recordingMode === "camera" &&
			!selectedCameraId &&
			availableCameras.length > 0
		) {
			setSelectedCameraId(availableCameras[0]?.deviceId ?? null);
		}
	}, [recordingMode, selectedCameraId, availableCameras, setSelectedCameraId]);

	// Camera ON by default: the first time cameras are available after the dialog opens, select one. Guarded
	// to fire once per open so turning the camera off during a session sticks (we don't re-enable it).
	const cameraDefaultedRef = useRef(false);
	useEffect(() => {
		if (!open) {
			cameraDefaultedRef.current = false;
			return;
		}
		if (cameraDefaultedRef.current || availableCameras.length === 0) return;
		cameraDefaultedRef.current = true;
		if (selectedCameraId === null) {
			setSelectedCameraId(availableCameras[0]?.deviceId ?? null);
		}
	}, [open, availableCameras, selectedCameraId, setSelectedCameraId]);

	const {
		phase,
		durationMs,
		hasAudioTrack,
		chunkUploads,
		errorDownload,
		completedShareUrl,
		recoveredDownloads,
		isSettingUp,
		isRecording,
		isBusy,
		isRestarting,
		canStartRecording,
		isBrowserSupported,
		unsupportedReason,
		supportsDisplayRecording,
		supportCheckCompleted,
		screenCaptureWarning,
		getCaptureStream,
		startRecording,
		pauseRecording,
		resumeRecording,
		stopRecording,
		openCompletedShareUrl,
		restartRecording,
		resetState,
		dismissRecoveredDownload,
	} = useWebRecorder({
		organisationId,
		selectedMicId,
		micEnabled,
		systemAudioEnabled,
		recordingMode,
		selectedCameraId,
		bubblePosition,
		isProUser: user.isPro,
		overrideDefaultCap,
		onRecordingSurfaceDetected: (mode) => {
			setRecordingMode(mode);
		},
		onRecordingStart: handleRecordingStartSound,
		onRecordingStop: handleRecordingStopSound,
		embed,
		onRecorded,
	});

	useEffect(() => {
		if (
			!supportCheckCompleted ||
			supportsDisplayRecording ||
			recordingMode === "camera"
		) {
			return;
		}

		setRecordingMode("camera");
	}, [supportCheckCompleted, supportsDisplayRecording, recordingMode]);

	const {
		handlePointerDownOutside,
		handleFocusOutside,
		handleInteractOutside,
	} = useDialogInteractions({
		dialogContentRef,
		isRecording,
		isBusy,
	});

	const handleOpenChange = (next: boolean) => {
		// The portal embed recorder IS the whole page — never let an outside-click or Esc close it (that would
		// drop the user to a blank loading screen with no way back).
		if (embed && !next) return;
		if (next && supportCheckCompleted && !isBrowserSupported) {
			toast.error(
				"This browser isn't compatible with the Tape recorder. We recommend Google Chrome or other Chromium-based browsers.",
			);
			return;
		}

		if (!next && isBusy) {
			toast.info("Keep this dialog open while your upload finishes.");
			return;
		}

		if (!next) {
			void resetState();
			setSelectedCameraId(null);
			setRecordingMode("fullscreen");
			setHowItWorksOpen(false);
			setOverrideDefaultCap(false);
		}
		setOpen(next);
	};

	const handleStopClick = () => {
		stopRecording().catch((err: unknown) => {
			console.error("Stop recording error", err);
		});
	};

	const handleStartClick = useCallback(async () => {
		if (recordingMode === "camera") {
			cameraPreviewRef.current?.stopStream();
			await waitForNextFrame();
		}

		await startRecording();
	}, [recordingMode, startRecording]);

	const handleClose = () => {
		if (!isBusy) {
			handleOpenChange(false);
		}
	};

	const handleHowItWorksOpen = () => {
		setHowItWorksOpen(true);
	};

	const showInProgressBar = isRecording || isBusy || phase === "error";
	const canComposite = isCompositorSupported();
	const cameraOn = !!selectedCameraId;
	const canEnableCamera = availableCameras.length > 0;
	const onToggleCamera = () =>
		handleCameraChange(
			cameraOn ? null : (availableCameras[0]?.deviceId ?? null),
		);
	// Big camera preview column: shown for screen captures whenever the compositor is available (it also
	// hosts the "turn camera on" CTA, so it appears even when the camera is off). Setup state only.
	const showPreviewColumn =
		recordingMode !== "camera" && canComposite && !isRecording && !isBusy;
	// Native PiP self-view: only for camera-only mode, or the non-Chromium fallback for screen modes so a
	// screen recording still gets a camera. Never shown when we're compositing.
	const showCameraPreview =
		cameraOn &&
		(recordingMode === "camera" || !canComposite) &&
		(recordingMode !== "camera" || (!isSettingUp && !isBusy));

	// Live camera stream for the launch positioner (its own acquisition; Chrome allows the recorder's
	// compositor to open the same device again at record time). Released as soon as the positioner hides.
	useEffect(() => {
		if (!showPreviewColumn || !cameraOn || !selectedCameraId) {
			setPreviewCameraStream(null);
			return;
		}
		let cancelled = false;
		let acquired: MediaStream | null = null;
		navigator.mediaDevices
			.getUserMedia({
				video: { deviceId: { exact: selectedCameraId } },
				audio: false,
			})
			.then((stream) => {
				if (cancelled) {
					stream.getTracks().forEach((t) => {
						t.stop();
					});
					return;
				}
				acquired = stream;
				setPreviewCameraStream(stream);
			})
			.catch(() => {
				/* camera unavailable — the positioner shows an empty bubble */
			});
		return () => {
			cancelled = true;
			setPreviewCameraStream(null);
			acquired?.getTracks().forEach((t) => {
				t.stop();
			});
		};
	}, [showPreviewColumn, cameraOn, selectedCameraId]);
	const recordingTimerDisplayMs = user.isPro
		? durationMs
		: Math.max(0, FREE_PLAN_MAX_RECORDING_MS - durationMs);

	return (
		<>
			<Dialog open={open} onOpenChange={handleOpenChange}>
				{/* No launch button in the portal embed — the dialog auto-opens (browser is the only option). */}
				{!embed && (
					<DialogTrigger asChild>
						<Button
							variant="blue"
							size="sm"
							className="flex items-center gap-2"
						>
							<MonitorIcon className="size-3.5" />
							Record in Browser
						</Button>
					</DialogTrigger>
				)}
				<DialogContent
					ref={dialogContentRef}
					// !max-w-* overrides the base DialogContent's `max-w-md` (448px), which would otherwise cram
					// the two columns. In the portal embed (full-window recorder) the two-column view fills the
					// window; the in-dashboard modal stays compact. (Can't use an inline style — the base
					// hardcodes its centering transform in `style`, and props.style would replace it.)
					className={`${
						embed && showPreviewColumn
							? "w-[96vw] !max-w-[1600px]"
							: showPreviewColumn
								? "w-[760px] !max-w-[760px]"
								: "w-[300px]"
					} border-none bg-transparent p-0 [&>button]:hidden`}
					onPointerDownOutside={handlePointerDownOutside}
					onFocusOutside={handleFocusOutside}
					onInteractOutside={handleInteractOutside}
				>
					<DialogTitle className="sr-only">Instant Mode Recorder</DialogTitle>
					<AnimatePresence mode="wait">
						{open && (
							<motion.div
								variants={dialogVariants}
								initial="hidden"
								animate="visible"
								exit="exit"
								className="relative flex justify-center flex-col p-[1rem] pt-[2rem] gap-[0.75rem] text-[0.875rem] font-[400] text-[--text-primary] bg-gray-2 rounded-lg min-h-[350px]"
							>
								<HowItWorksPanel
									open={howItWorksOpen}
									onClose={() => setHowItWorksOpen(false)}
								/>
								<WebRecorderDialogHeader
									isBusy={isBusy}
									onClose={handleClose}
								/>
								{/* Two columns for screen captures: a control menu on the left, the big camera preview
								    on the right. `display: contents` keeps camera-only mode a single column. */}
								<div
									className={
										showPreviewColumn ? "flex items-stretch gap-4" : "contents"
									}
								>
									<div
										className={
											showPreviewColumn
												? "flex w-[264px] shrink-0 flex-col gap-[0.75rem]"
												: "contents"
										}
									>
										{/* OneAway: the Full Screen / Window / Tab / Camera picker is hidden. Chrome's native
										    getDisplayMedia dialog already asks screen vs window vs tab at Start, so pre-picking
										    here was redundant. Recording is always screen (default 'fullscreen') + the optional
										    camera bubble; webcam-only mode was intentionally dropped for the screen-first tool. */}
										{screenCaptureWarning && (
											<div className="rounded-md border border-amber-6 bg-amber-3/60 px-3 py-2 text-xs leading-snug text-amber-12">
												{screenCaptureWarning}
											</div>
										)}
										<CameraSelector
											selectedCameraId={selectedCameraId}
											availableCameras={availableCameras}
											dialogOpen={open}
											disabled={isBusy}
											open={cameraSelectOpen}
											onOpenChange={(isOpen) => {
												setCameraSelectOpen(isOpen);
												if (isOpen) {
													setMicSelectOpen(false);
												}
											}}
											onCameraChange={handleCameraChange}
											onRefreshDevices={refreshCameras}
										/>
										<MicrophoneSelector
											selectedMicId={selectedMicId}
											availableMics={availableMics}
											dialogOpen={open}
											disabled={isBusy || isRecording}
											open={micSelectOpen}
											onOpenChange={(isOpen) => {
												setMicSelectOpen(isOpen);
												if (isOpen) {
													setCameraSelectOpen(false);
												}
											}}
											onMicChange={handleMicChange}
											onRefreshDevices={refreshMics}
										/>
										{recordingMode !== "camera" && (
											<SystemAudioToggle
												enabled={systemAudioEnabled}
												disabled={isBusy}
												recordingMode={recordingMode}
												onToggle={handleSystemAudioChange}
											/>
										)}
										<RecordingCapToggle
											overridden={overrideDefaultCap}
											disabled={isBusy || isRecording}
											onToggle={setOverrideDefaultCap}
										/>
										<RememberDevicesToggle
											enabled={rememberDevices}
											disabled={isBusy || isRecording}
											onToggle={handleRememberDevicesChange}
										/>
										<RecordingButton
											isRecording={isRecording}
											disabled={!canStartRecording || (isBusy && !isRecording)}
											onStart={handleStartClick}
											onStop={handleStopClick}
										/>
									</div>
									{showPreviewColumn && (
										<div className="flex min-w-0 flex-1 items-start pt-[2px]">
											<CameraPreviewArea
												cameraStream={previewCameraStream}
												cameraOn={cameraOn}
												canEnableCamera={canEnableCamera}
												onToggleCamera={onToggleCamera}
												position={bubblePosition}
												onPositionChange={setBubblePosition}
											/>
										</div>
									)}
								</div>
								{!isBrowserSupported && unsupportedReason && (
									<div className="rounded-md border border-red-6 bg-red-3/70 px-3 py-2 text-xs leading-snug text-red-12">
										{unsupportedReason}
									</div>
								)}
								{phase === "completed" && completedShareUrl && (
									<div className="rounded-md border border-green-6 bg-green-3/70 px-3 py-3 text-xs text-green-12">
										<div className="font-medium">Share link ready</div>
										<div className="mt-1 leading-snug">
											If it did not open automatically, open it here.
										</div>
										<Button
											variant="blue"
											size="sm"
											className="mt-3 w-full"
											onClick={openCompletedShareUrl}
										>
											Open Share Link
										</Button>
									</div>
								)}
								{phase === "idle" && recoveredDownloads.length > 0 && (
									<div className="rounded-md border border-blue-6 bg-blue-3/60 px-3 py-2">
										<div className="text-xs font-medium text-blue-12">
											Recovered recordings
										</div>
										<div className="mt-2 flex flex-col gap-2">
											{recoveredDownloads.map((download) => (
												<div
													key={download.id}
													className="flex items-center justify-between gap-3 rounded-md bg-white/70 px-2.5 py-2 text-xs text-gray-12"
												>
													<div className="min-w-0">
														<div className="truncate font-medium">
															{download.fileName}
														</div>
														<div className="text-gray-10">
															{recoveredRecordingTimeFormatter.format(
																new Date(download.createdAt),
															)}
														</div>
													</div>
													<div className="flex shrink-0 items-center gap-3">
														<a
															href={download.url}
															download={download.fileName}
															className="font-medium text-blue-11 hover:text-blue-12"
															onClick={() =>
																setTimeout(
																	() => dismissRecoveredDownload(download.id),
																	500,
																)
															}
														>
															Download
														</a>
														<button
															type="button"
															className="text-gray-10 hover:text-gray-12"
															onClick={() =>
																dismissRecoveredDownload(download.id)
															}
														>
															Dismiss
														</button>
													</div>
												</div>
											))}
										</div>
									</div>
								)}
								<HowItWorksButton onClick={handleHowItWorksOpen} />
							</motion.div>
						)}
					</AnimatePresence>
				</DialogContent>
			</Dialog>
			{showInProgressBar && (
				<InProgressRecordingBar
					phase={phase}
					durationMs={recordingTimerDisplayMs}
					hasAudioTrack={hasAudioTrack}
					micDeviceId={selectedMicId}
					getPreviewStream={getCaptureStream}
					chunkUploads={chunkUploads}
					errorDownload={errorDownload}
					onStop={handleStopClick}
					onPause={pauseRecording}
					onResume={resumeRecording}
					onRestart={restartRecording}
					isRestarting={isRestarting}
				/>
			)}
			{showCameraPreview && (
				<CameraPreviewWindow
					ref={cameraPreviewRef}
					cameraId={selectedCameraId}
					onClose={() => handleCameraChange(null)}
				/>
			)}
		</>
	);
};
