import type { DetectedDisplayRecordingMode } from "@cap/recorder-core/recorder-constants";
import { Video } from "@cap/web-domain";
import type { RecordingMode } from "./RecordingModeSelector";

export * from "@cap/recorder-core/recorder-constants";

// Derived here rather than in @cap/recorder-core so the framework-agnostic
// package carries no runtime dependency on the @cap/web-domain barrel (the
// extension bundles recorder-core and must not pull effect along with it).
export const FREE_PLAN_MAX_RECORDING_MS =
	Video.FREE_PLAN_MAX_RECORDING_SECONDS * 1000;

// Recording-length guardrails, independent of Cap's free-plan cap (a no-op on our self-hosted fork where
// everyone is Pro). By default a recording auto-stops at 20 min so a session you launch and forget can't
// run forever — the recorder tab is hidden the entire time you record, so nothing on screen reminds you
// it's still going. The launcher's "Record past 20 min" switch lifts the default toward the hard ceiling.
// 45 min is an absolute maximum that even the override can't cross.
export const DEFAULT_MAX_RECORDING_MS = 20 * 60 * 1000;
export const HARD_MAX_RECORDING_MS = 45 * 60 * 1000;

/**
 * Effective auto-stop ceiling (ms) for a recording — the single source of truth the recorder enforces.
 * Takes the tightest of three bounds so no single one can be escaped:
 *  - Cap's free-plan cap (only when `isFreePlan`; +Infinity otherwise, i.e. never binds Pro/self-hosted).
 *  - The user's launch choice: 20-min default, or the 45-min hard cap when `overrideDefaultCap` is on.
 *  - The 45-min hard ceiling, always — so even the override can't exceed it.
 * Always returns a finite number, so the auto-stop always has a real ceiling to enforce.
 */
export function computeEffectiveMaxRecordingMs(opts: {
	isFreePlan: boolean;
	overrideDefaultCap?: boolean;
}): number {
	return Math.min(
		opts.isFreePlan ? FREE_PLAN_MAX_RECORDING_MS : Number.POSITIVE_INFINITY,
		opts.overrideDefaultCap ? HARD_MAX_RECORDING_MS : DEFAULT_MAX_RECORDING_MS,
		HARD_MAX_RECORDING_MS,
	);
}

// Compile-time guard: recorder-core can't import RecordingModeSelector, so it
// hand-writes DetectedDisplayRecordingMode. Fail the build if the two unions
// ever diverge.
type MutuallyAssignable<A, B> = [A] extends [B]
	? [B] extends [A]
		? true
		: never
	: never;
const _detectedDisplayRecordingModeStaysInSync: MutuallyAssignable<
	DetectedDisplayRecordingMode,
	Exclude<RecordingMode, "camera">
> = true;
void _detectedDisplayRecordingModeStaysInSync;

export const dialogVariants = {
	hidden: {
		opacity: 0,
		scale: 0.9,
		y: 20,
	},
	visible: {
		opacity: 1,
		scale: 1,
		y: 0,
		transition: {
			type: "spring",
			duration: 0.4,
			damping: 25,
			stiffness: 500,
		},
	},
	exit: {
		opacity: 0,
		scale: 0.95,
		y: 10,
		transition: {
			duration: 0.2,
		},
	},
};
