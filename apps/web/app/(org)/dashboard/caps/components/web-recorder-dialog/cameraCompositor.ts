// Canvas compositor for the round, adaptive, movable camera bubble baked into SCREEN/WINDOW/TAB
// recordings. The screen frames are drawn full-frame onto a canvas; the webcam is circle-clipped
// (object-fit: cover) and drawn at a movable position on top. The composited canvas becomes ONE
// video track that the recorder pipeline uses in place of the raw screen track — so the working
// record -> upload -> transcribe path is unchanged except for that single track swap.
//
// FRAME PIPELINE — WebCodecs "breakout box" (MediaStreamTrackProcessor -> compose -> MediaStreamTrackGenerator):
// The naive approach (requestAnimationFrame/requestVideoFrameCallback drawing + canvas.captureStream)
// FREEZES when the recording tab is backgrounded: rAF/rVFC are part of the document's rendering steps
// and are paused for a hidden document, and canvas.captureStream sampling is throttled too — so
// recording a *different* tab (the Cap tab is hidden the whole time) would encode a frozen last frame.
// Instead we pull frames via MediaStreamTrackProcessor (fed by the capturer, which keeps delivering
// regardless of page visibility), composite onto a canvas, and push VideoFrames into a
// MediaStreamTrackGenerator whose track is what gets recorded. Nothing here depends on rAF or on the
// page being visible, so a backgrounded recording stays live. Chrome exposes both APIs on the main
// thread; where they're absent (Firefox/Safari/old Chrome) createCameraCompositor throws and the
// caller falls back to the raw screen track (screen-only, no bubble) — never a frozen recording.

export type BubbleCorner = "tl" | "tr" | "bl" | "br";
export type BubblePosition =
	| { mode: "corner"; corner: BubbleCorner }
	| { mode: "free"; nx: number; ny: number };
export interface BubbleConfig {
	position: BubblePosition;
	mirror: boolean;
}

export const clamp = (value: number, lo: number, hi: number) => {
	if (Number.isNaN(value)) return lo;
	if (hi < lo) return lo;
	return Math.min(Math.max(value, lo), hi);
};

// Geometry is derived as a FRACTION of the shorter dimension so the bubble reads the same on a 4K
// screen and a 1280 one, with an inset margin so it's never edge-glued. The absolute px clamps below
// only make sense in RECORDING pixels; the preview pad (a small element) must use pure proportions
// (PREVIEW_GEOM), otherwise the 112px floor makes the bubble larger than the pad and zeroes vertical
// travel. Same fraction => the preview thumb lands exactly where the bubble bakes.
export interface BubbleGeometryOptions {
	diameterFraction: number;
	marginFraction: number;
	minD: number;
	maxD: number;
	minMargin: number;
}
export const RECORDING_GEOM: BubbleGeometryOptions = {
	diameterFraction: 0.18,
	marginFraction: 0.04,
	minD: 112,
	maxD: 360,
	minMargin: 16,
};
export const PREVIEW_GEOM: BubbleGeometryOptions = {
	diameterFraction: 0.18,
	marginFraction: 0.04,
	minD: 0,
	maxD: Number.POSITIVE_INFINITY,
	minMargin: 0,
};

export interface BubbleMetrics {
	D: number;
	r: number;
	M: number;
	travelX: number;
	travelY: number;
}

export const computeBubbleMetrics = (
	W: number,
	H: number,
	geom: BubbleGeometryOptions = RECORDING_GEOM,
): BubbleMetrics => {
	const short = Math.min(W, H);
	const D = clamp(
		Math.round(short * geom.diameterFraction),
		geom.minD,
		geom.maxD,
	);
	const M = Math.max(geom.minMargin, Math.round(short * geom.marginFraction));
	const travelX = Math.max(0, W - 2 * M - D);
	const travelY = Math.max(0, H - 2 * M - D);
	return { D, r: D / 2, M, travelX, travelY };
};

// Corners are exactly the extremes of the free-drag coordinate space: tl=(0,0) tr=(1,0) bl=(0,1) br=(1,1).
export const cornerToNormalized = (
	corner: BubbleCorner,
): { nx: number; ny: number } => {
	switch (corner) {
		case "tl":
			return { nx: 0, ny: 0 };
		case "tr":
			return { nx: 1, ny: 0 };
		case "bl":
			return { nx: 0, ny: 1 };
		case "br":
			return { nx: 1, ny: 1 };
	}
};

// Arrow-key corner switching: an arrow sets ONE axis of the corner (Left/Right = horizontal,
// Up/Down = vertical) and keeps the other, so the bubble hops between the four corners. From a free
// (dragged) position it derives the current axes from where it sits. Returns null for non-arrow keys.
export const nextCorner = (
	position: BubblePosition,
	key: string,
): BubbleCorner | null => {
	let vert: "t" | "b";
	let horiz: "l" | "r";
	if (position.mode === "corner") {
		vert = position.corner[0] === "t" ? "t" : "b";
		horiz = position.corner[1] === "l" ? "l" : "r";
	} else {
		vert = position.ny < 0.5 ? "t" : "b";
		horiz = position.nx < 0.5 ? "l" : "r";
	}
	switch (key) {
		case "ArrowLeft":
			horiz = "l";
			break;
		case "ArrowRight":
			horiz = "r";
			break;
		case "ArrowUp":
			vert = "t";
			break;
		case "ArrowDown":
			vert = "b";
			break;
		default:
			return null;
	}
	return `${vert}${horiz}` as BubbleCorner;
};

// Resolve the bubble CENTER in target pixels for a given position. Guards degenerate cases (capture
// narrower than bubble+margins) by centering rather than letting the circle drift off-screen.
export const resolveBubbleCenter = (
	position: BubblePosition,
	W: number,
	H: number,
	geom: BubbleGeometryOptions = RECORDING_GEOM,
): { cx: number; cy: number } => {
	const { r, M, travelX, travelY } = computeBubbleMetrics(W, H, geom);
	const { nx, ny } =
		position.mode === "corner"
			? cornerToNormalized(position.corner)
			: { nx: clamp(position.nx, 0, 1), ny: clamp(position.ny, 0, 1) };
	const cx = travelX <= 0 ? W / 2 : M + r + nx * travelX;
	const cy = travelY <= 0 ? H / 2 : M + r + ny * travelY;
	return { cx, cy };
};

// Inverse of resolveBubbleCenter: map a pointer coordinate (in target/pad pixels) back to normalized
// (0..1) so a drag on the preview pad produces the same inset-aware placement as the baked bubble.
export const normalizedFromPoint = (
	px: number,
	py: number,
	W: number,
	H: number,
	geom: BubbleGeometryOptions = RECORDING_GEOM,
): { nx: number; ny: number } => {
	const { r, M, travelX, travelY } = computeBubbleMetrics(W, H, geom);
	const nx = travelX <= 0 ? 0.5 : clamp((px - M - r) / travelX, 0, 1);
	const ny = travelY <= 0 ? 0.5 : clamp((py - M - r) / travelY, 0, 1);
	return { nx, ny };
};

export interface CameraCompositorOptions {
	screenStream: MediaStream;
	cameraStream: MediaStream;
	width: number;
	height: number;
	fps: number;
	getConfig: () => BubbleConfig;
}

export interface CameraCompositorController {
	videoTrack: MediaStreamTrack;
	canvas: HTMLCanvasElement;
	setCameraEnded: () => void;
	destroy: () => void;
}

// Thrown when the breakout-box APIs are unavailable (non-Chromium / old Chrome), so the caller falls
// back to the raw screen track instead of crashing the start flow.
export class CompositorUnsupportedError extends Error {
	constructor() {
		super(
			"MediaStreamTrack insertable streams are not supported in this browser",
		);
		this.name = "CompositorUnsupportedError";
	}
}

// Minimal WebCodecs surface — these classes aren't in TS's lib.dom in all versions, so we reach them
// off globalThis and keep frame handling loosely typed. VideoFrame is a CanvasImageSource at runtime.
interface FrameLike {
	timestamp?: number;
	displayWidth?: number;
	displayHeight?: number;
	close: () => void;
}
interface TrackProcessorCtor {
	new (opts: {
		track: MediaStreamTrack;
	}): { readable: ReadableStream<FrameLike> };
}
interface TrackGeneratorCtor {
	new (opts: {
		kind: "video";
	}): MediaStreamTrack & { writable: WritableStream<FrameLike> };
}
interface VideoFrameCtor {
	new (source: CanvasImageSource, init?: { timestamp?: number }): FrameLike;
}
const webcodecs = globalThis as unknown as {
	MediaStreamTrackProcessor?: TrackProcessorCtor;
	MediaStreamTrackGenerator?: TrackGeneratorCtor;
	VideoFrame?: VideoFrameCtor;
};

export const isCompositorSupported = () =>
	typeof webcodecs.MediaStreamTrackProcessor === "function" &&
	typeof webcodecs.MediaStreamTrackGenerator === "function" &&
	typeof webcodecs.VideoFrame === "function";

const FIRST_FRAME_TIMEOUT_MS = 3000;

export const createCameraCompositor = async (
	opts: CameraCompositorOptions,
): Promise<CameraCompositorController> => {
	const { screenStream, cameraStream, getConfig } = opts;
	if (!isCompositorSupported()) throw new CompositorUnsupportedError();
	const ProcessorCtor =
		webcodecs.MediaStreamTrackProcessor as TrackProcessorCtor;
	const GeneratorCtor =
		webcodecs.MediaStreamTrackGenerator as TrackGeneratorCtor;
	const FrameCtor = webcodecs.VideoFrame as VideoFrameCtor;

	const screenTrack = screenStream.getVideoTracks()[0];
	if (!screenTrack) throw new CompositorUnsupportedError();
	const cameraTrack = cameraStream.getVideoTracks()[0] ?? null;

	const settings = screenTrack.getSettings();
	// Cap the composited canvas to 1080p (aspect-preserved). Compositing a native 4K external display — draw
	// + a per-frame canvas→VideoFrame readback at ~8 MP, 30×/sec — starved the frame rate to <1 fps; 1080p is
	// ~4× lighter and keeps 4K/external displays at ~30 fps. We do NOT downscale to the final 720p here:
	// canvas drawImage is a low-quality (bilinear) scaler that turns text to mush — the server transcode does
	// the 720p downscale with a proper lanczos filter. imageSmoothingQuality "high" (set below) sharpens the
	// only canvas resize left (native 4K → 1080p). Even dimensions for the h264 encoders downstream.
	const rawW = Math.max(2, Math.round(opts.width || settings.width || 1280));
	const rawH = Math.max(2, Math.round(opts.height || settings.height || 720));
	const capScale = Math.min(1, 2560 / rawW, 1440 / rawH); // canvas cap raised 1080p→1440p (M4 has headroom; overlay busy% verifies)
	const W = Math.max(2, Math.round((rawW * capScale) / 2) * 2);
	const H = Math.max(2, Math.round((rawH * capScale) / 2) * 2);
	// Output cadence follows the source rate (capped at 60). Do NOT cap this below the capture fps with this
	// simple min-interval throttle: capping a ~29–30fps source at 24 phase-aligns the throttle so it keeps
	// every OTHER frame (~14fps out) — dramatically worse than 24, and observed live via the overlay. It's
	// also unnecessary — the composite measured ~0.9ms/frame, so the compositor isn't the bottleneck; there's
	// no headroom to reclaim by throttling. Let every captured frame through.
	const fps = Math.max(1, Math.min(Math.round(opts.fps || 30), 60));
	const frameIntervalUs = 1_000_000 / fps;

	const canvas = document.createElement("canvas");
	canvas.width = W;
	canvas.height = H;
	// No desynchronized: we read the canvas back (VideoFrame from canvas), and desynchronized can hand
	// back a stale/torn surface on readback. alpha:false is enough and cheaper (no alpha channel).
	const ctx = canvas.getContext("2d", { alpha: false });
	if (!ctx) throw new CompositorUnsupportedError();
	// Best-quality resampling for any drawImage resize (4K→1080p screen, camera bubble scaling) — the default
	// "low" is bilinear and softens text badly. Cheap: only matters when a source is actually downscaled.
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";

	// Everything created past here must be released if setup fails (below returns/throws) — tracked so
	// the catch can tear it all down and the caller degrades to a clean screen-only path.
	let disposed = false;
	let cameraEnded = !cameraTrack;
	let latestCameraFrame: FrameLike | null = null;
	let lastWrittenUs = Number.NEGATIVE_INFINITY;

	const generator = new GeneratorCtor({ kind: "video" });
	const writer = generator.writable.getWriter();
	const screenReader = new ProcessorCtor({
		track: screenTrack,
	}).readable.getReader();
	const cameraReader = cameraTrack
		? new ProcessorCtor({ track: cameraTrack }).readable.getReader()
		: null;

	const closeCameraFrame = () => {
		if (latestCameraFrame) {
			try {
				latestCameraFrame.close();
			} catch {
				/* ignore */
			}
			latestCameraFrame = null;
		}
	};

	// --- TEMP instrumentation: 1 Hz snapshot of the compositor pipeline to diagnose the external-display
	// frame collapse. Tagged "[compositor]" for console filtering; remove once the cause is confirmed.
	let dbgSrcRead = 0;
	let dbgThrottle = 0;
	let dbgComposited = 0;
	let dbgCompositeMs = 0;
	let dbgWritten = 0;
	let dbgEncDrop = 0;
	let dbgInflight = 0;
	let dbgReadbackMs = 0;
	// TEMP on-screen readout: a fixed corner overlay so the live OUTPUT framerate is visible while recording
	// without opening DevTools. Green ≥20 / amber ≥10 / red <10 fps. Self-contained (appended to body,
	// removed on teardown) so it needs no UI wiring. Remove alongside the console instrumentation later.
	const dbgOverlay =
		typeof document !== "undefined" ? document.createElement("div") : null;
	if (dbgOverlay) {
		dbgOverlay.style.cssText =
			"position:fixed;top:10px;left:10px;z-index:2147483647;background:rgba(0,0,0,0.78);" +
			"color:#4ade80;font:600 12px/1.35 ui-monospace,Menlo,monospace;padding:5px 9px;" +
			"border-radius:7px;pointer-events:none;white-space:pre;box-shadow:0 2px 8px rgba(0,0,0,0.45);";
		dbgOverlay.textContent = "● starting…";
		document.body.appendChild(dbgOverlay);
	}
	const dbgTimer = setInterval(() => {
		const avg = dbgComposited
			? (dbgCompositeMs / dbgComposited).toFixed(1)
			: "0";
		console.log(
			`[compositor] src=${dbgSrcRead}/s written=${dbgWritten}/s encDrop=${dbgEncDrop}/s ` +
				`throttle=${dbgThrottle}/s composite=${avg}ms inflight=${dbgInflight} ` +
				`desiredSize=${writer.desiredSize} canvas=${W}x${H}@${fps}fps`,
		);
		if (dbgOverlay) {
			const out = dbgWritten;
			// work = draw + canvas→VideoFrame readback: the compositor's whole synchronous per-frame cost.
			// busy% = that work as a fraction of wall-clock — how much of ONE core our compositing eats.
			// (Browsers can't read system CPU/GPU; this is OUR process's cost, which is what was asked.)
			const workTotalMs = dbgCompositeMs + dbgReadbackMs;
			const work = dbgComposited
				? (workTotalMs / dbgComposited).toFixed(1)
				: "0";
			const busy = Math.round(workTotalMs / 10);
			dbgOverlay.style.color =
				out >= 20 ? "#4ade80" : out >= 10 ? "#fbbf24" : "#f87171";
			dbgOverlay.textContent = `● ${out} fps · src ${dbgSrcRead} · work ${work}ms · busy ${busy}% · drop ${dbgEncDrop}`;
		}
		dbgSrcRead = 0;
		dbgThrottle = 0;
		dbgComposited = 0;
		dbgCompositeMs = 0;
		dbgReadbackMs = 0;
		dbgWritten = 0;
		dbgEncDrop = 0;
	}, 1000);

	const teardown = () => {
		disposed = true;
		clearInterval(dbgTimer);
		dbgOverlay?.remove();
		try {
			screenReader.cancel().catch(() => {});
		} catch {
			/* ignore */
		}
		try {
			cameraReader?.cancel().catch(() => {});
		} catch {
			/* ignore */
		}
		try {
			writer.abort().catch(() => {});
		} catch {
			/* ignore */
		}
		closeCameraFrame();
		// Stop only the OUTPUT (generator) track — the hook owns the screen/camera SOURCE tracks (stopped
		// by cleanupStreams via displayStreamRef/cameraStreamRef); double-stopping them would race cleanup.
		try {
			generator.stop();
		} catch {
			/* ignore */
		}
	};

	const drawComposite = (screenFrame: FrameLike) => {
		try {
			ctx.drawImage(screenFrame as unknown as CanvasImageSource, 0, 0, W, H);
		} catch {
			/* keep last painted screen on a transient undrawable frame */
		}

		const cfg = getConfig();
		const { D, r } = computeBubbleMetrics(W, H);
		const { cx, cy } = resolveBubbleCenter(cfg.position, W, H);

		// Soft shadow disc behind the bubble for a clean, elevated Loom-style look.
		ctx.save();
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.shadowColor = "rgba(0,0,0,0.4)";
		ctx.shadowBlur = Math.round(D * 0.05);
		ctx.fillStyle = "#0a0a0a";
		ctx.fill();
		ctx.restore();

		// Camera, circle-clipped, object-fit: cover via a centered square crop of the source frame.
		ctx.save();
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.clip();
		const cam = latestCameraFrame;
		const vw = cam?.displayWidth ?? 0;
		const vh = cam?.displayHeight ?? 0;
		if (!cameraEnded && cam && vw > 0 && vh > 0) {
			// Zoom the bubble in ~5%: the raw webcam angle is wide, leaving the person small in the circle.
			// Crop a slightly smaller centered square (÷ZOOM) and let the same bubble destination scale it up.
			const CAMERA_BUBBLE_ZOOM = 1.05;
			const crop = Math.min(vw, vh) / CAMERA_BUBBLE_ZOOM;
			const sx = (vw - crop) / 2;
			const sy = (vh - crop) / 2;
			try {
				if (cfg.mirror) {
					ctx.translate(cx + r, cy - r);
					ctx.scale(-1, 1);
					ctx.drawImage(
						cam as unknown as CanvasImageSource,
						sx,
						sy,
						crop,
						crop,
						0,
						0,
						D,
						D,
					);
				} else {
					ctx.drawImage(
						cam as unknown as CanvasImageSource,
						sx,
						sy,
						crop,
						crop,
						cx - r,
						cy - r,
						D,
						D,
					);
				}
			} catch {
				/* ignore a transient undrawable camera frame */
			}
		} else {
			// Muted disc when the camera is absent/ended, so the bubble degrades gracefully.
			ctx.fillStyle = "#1a1a1a";
			ctx.fill();
		}
		ctx.restore();
		// No outline — the soft shadow disc above is the only edge treatment, so the bubble reads as a clean
		// cutout on the video rather than a ringed sticker. (White ring intentionally removed.)
	};

	// Camera loop: keep only the most recent frame (closing the previous to avoid exhausting GPU
	// buffers, which would stall the pipeline). Output cadence is driven by the SCREEN loop below.
	const pumpCamera = async () => {
		if (!cameraReader) return;
		try {
			while (!disposed) {
				const { value, done } = await cameraReader.read();
				if (done || !value) {
					cameraEnded = true;
					break;
				}
				closeCameraFrame();
				latestCameraFrame = value;
			}
		} catch {
			/* reader cancelled on teardown */
		}
	};

	// First-frame gate: MediaRecorder must not start on a generator that has never been written, or the
	// track can stall. Resolve once we've composited+written the first real screen frame; reject on a
	// screen timeout so the caller degrades to screen-only.
	let firstResolve!: () => void;
	let firstReject!: (err: unknown) => void;
	let firstSettled = false;
	const firstFrame = new Promise<void>((res, rej) => {
		firstResolve = res;
		firstReject = rej;
	});

	// Screen loop: every screen frame drives one composited output frame (throttled to fps). Frames MUST
	// be closed after use. This loop — not rAF — is the sole driver, so it survives a hidden tab.
	const pumpScreen = async () => {
		try {
			while (!disposed) {
				const { value: frame, done } = await screenReader.read();
				if (done || !frame) {
					// Screen track ended (e.g. share stopped immediately). If it ended before we ever wrote a
					// frame, settle the gate NOW so the caller degrades to screen-only at once instead of
					// waiting out the 3s timeout.
					if (!firstSettled) {
						firstSettled = true;
						firstReject(new Error("Screen track ended before first frame"));
					}
					break;
				}
				if (disposed) {
					frame.close();
					break;
				}
				dbgSrcRead++;
				const ts = frame.timestamp ?? 0;
				if (firstSettled && ts - lastWrittenUs < frameIntervalUs - 1000) {
					// Too soon since the last written frame — drop to cap output near `fps`.
					dbgThrottle++;
					frame.close();
					continue;
				}
				const compositeStart = performance.now();
				try {
					drawComposite(frame);
				} finally {
					frame.close();
				}
				dbgComposited++;
				dbgCompositeMs += performance.now() - compositeStart;

				if (!firstSettled) {
					// First frame: await exactly one write so the start-gate fires only once a real frame is
					// encoded. The generator queue is empty here, so awaiting a single frame cannot stall.
					lastWrittenUs = ts;
					const firstOut = new FrameCtor(canvas, { timestamp: ts });
					dbgWritten++;
					try {
						await writer.write(firstOut);
						firstSettled = true;
						firstResolve();
					} finally {
						firstOut.close();
					}
					continue;
				}

				// Steady state: NEVER await the encoder. Awaiting coupled a slow encoder's backpressure to this
				// read loop and collapsed output to <1fps. Enqueue only when the generator has queue room
				// (desiredSize > 0); otherwise DROP the composited frame. The loop then always runs at source
				// cadence — under encoder overload we shed frames (lower fps) instead of freezing.
				const ds = writer.desiredSize;
				if (ds !== null && ds <= 0) {
					dbgEncDrop++;
					// Emitted nothing, so leave lastWrittenUs unchanged (do not over-throttle the next frame).
					continue;
				}
				lastWrittenUs = ts;
				const rbStart = performance.now();
				const out = new FrameCtor(canvas, { timestamp: ts });
				dbgReadbackMs += performance.now() - rbStart;
				dbgInflight++;
				dbgWritten++;
				// VideoFrames are GPU-backed — close on both success and failure of the (unawaited) write.
				writer.write(out).then(
					() => {
						out.close();
						dbgInflight--;
					},
					() => {
						try {
							out.close();
						} catch {
							/* ignore */
						}
						dbgInflight--;
					},
				);
			}
		} catch (err) {
			if (!firstSettled) {
				firstSettled = true;
				firstReject(err);
			}
		}
	};

	try {
		void pumpCamera();
		void pumpScreen();
		let timer: ReturnType<typeof setTimeout> | null = null;
		const timeout = new Promise<never>((_, rej) => {
			timer = setTimeout(() => {
				if (!firstSettled) {
					firstSettled = true;
					rej(new Error("Screen frames did not arrive in time"));
				}
			}, FIRST_FRAME_TIMEOUT_MS);
		});
		try {
			await Promise.race([firstFrame, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	} catch (err) {
		// Release the generator/readers/writer/canvas frame we already created so the caller's fallback to
		// the raw screen track starts from a clean slate (no leaked, still-decoding pipeline).
		teardown();
		throw err;
	}

	return {
		videoTrack: generator,
		canvas,
		setCameraEnded: () => {
			cameraEnded = true;
		},
		destroy: teardown,
	};
};
