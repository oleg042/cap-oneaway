import { useCallback, useRef } from "react";
import type { CameraCompositorController } from "./cameraCompositor";

export const useStreamManagement = () => {
	const displayStreamRef = useRef<MediaStream | null>(null);
	const cameraStreamRef = useRef<MediaStream | null>(null);
	const micStreamRef = useRef<MediaStream | null>(null);
	const mixedStreamRef = useRef<MediaStream | null>(null);
	// Round-camera canvas compositor for screen+camera recordings. Torn down FIRST in cleanupStreams so
	// its rAF/rVFC loop + hidden <video> elements are released before the source tracks it reads are stopped.
	const cameraCompositorRef = useRef<CameraCompositorController | null>(null);
	const audioContextRef = useRef<AudioContext | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const detectionTimeoutsRef = useRef<number[]>([]);
	const detectionCleanupRef = useRef<Array<() => void>>([]);

	const clearDetectionTracking = useCallback(() => {
		detectionTimeoutsRef.current.forEach((timeoutId) => {
			window.clearTimeout(timeoutId);
		});
		detectionTimeoutsRef.current = [];
		detectionCleanupRef.current.forEach((cleanup) => {
			try {
				cleanup();
			} catch {
				/* ignore */
			}
		});
		detectionCleanupRef.current = [];
	}, []);

	const cleanupStreams = useCallback(() => {
		// Destroy the compositor FIRST: stop its draw loop + release its hidden <video> elements before
		// the source screen/camera tracks it reads are stopped below. Every recorder exit (normal stop,
		// reset, error, restart, unmount) funnels through cleanupStreams, so this one call covers them all.
		if (cameraCompositorRef.current) {
			try {
				cameraCompositorRef.current.destroy();
			} catch {
				/* ignore */
			}
			cameraCompositorRef.current = null;
		}
		clearDetectionTracking();
		const stopTracks = (stream: MediaStream | null) => {
			stream?.getTracks().forEach((track) => {
				track.stop();
			});
		};
		stopTracks(displayStreamRef.current);
		stopTracks(cameraStreamRef.current);
		stopTracks(micStreamRef.current);
		stopTracks(mixedStreamRef.current);
		displayStreamRef.current = null;
		cameraStreamRef.current = null;
		micStreamRef.current = null;
		mixedStreamRef.current = null;

		if (audioContextRef.current) {
			audioContextRef.current.close().catch(() => {});
			audioContextRef.current = null;
		}

		if (videoRef.current) {
			videoRef.current.srcObject = null;
		}
	}, [clearDetectionTracking]);

	return {
		displayStreamRef,
		cameraStreamRef,
		micStreamRef,
		mixedStreamRef,
		cameraCompositorRef,
		audioContextRef,
		videoRef,
		detectionTimeoutsRef,
		detectionCleanupRef,
		clearDetectionTracking,
		cleanupStreams,
	};
};
