import { describe, expect, it } from "vitest";
import {
	computeEffectiveMaxRecordingMs,
	DEFAULT_MAX_RECORDING_MS,
	FREE_PLAN_MAX_RECORDING_MS,
	HARD_MAX_RECORDING_MS,
} from "../app/(org)/dashboard/caps/components/web-recorder-dialog/web-recorder-constants";

// Guardrail math for the web recorder's max-duration auto-stop. The recorder tab is hidden the entire time
// you record, so nothing on screen reminds you it's running — these bounds are what stop a forgotten
// session from running forever. Proven here in isolation because the real ceilings are 20–45 min and can't
// be wall-clock tested.
describe("computeEffectiveMaxRecordingMs", () => {
	it("has the expected constant values", () => {
		expect(DEFAULT_MAX_RECORDING_MS).toBe(20 * 60 * 1000);
		expect(HARD_MAX_RECORDING_MS).toBe(45 * 60 * 1000);
		// Cap's free-plan cap is 5 min; it never binds our all-Pro fork but must still bind genuine free users.
		expect(FREE_PLAN_MAX_RECORDING_MS).toBe(5 * 60 * 1000);
		expect(DEFAULT_MAX_RECORDING_MS).toBeLessThan(HARD_MAX_RECORDING_MS);
	});

	it("caps at 20 min by default (Pro / self-hosted, no override)", () => {
		expect(computeEffectiveMaxRecordingMs({ isFreePlan: false })).toBe(
			DEFAULT_MAX_RECORDING_MS,
		);
		expect(
			computeEffectiveMaxRecordingMs({
				isFreePlan: false,
				overrideDefaultCap: false,
			}),
		).toBe(DEFAULT_MAX_RECORDING_MS);
	});

	it("lifts to the 45-min hard cap when overridden (Pro / self-hosted)", () => {
		expect(
			computeEffectiveMaxRecordingMs({
				isFreePlan: false,
				overrideDefaultCap: true,
			}),
		).toBe(HARD_MAX_RECORDING_MS);
	});

	it("the override can never exceed the 45-min hard ceiling", () => {
		const overridden = computeEffectiveMaxRecordingMs({
			isFreePlan: false,
			overrideDefaultCap: true,
		});
		expect(overridden).toBeLessThanOrEqual(HARD_MAX_RECORDING_MS);
		expect(overridden).toBe(HARD_MAX_RECORDING_MS);
	});

	it("free-plan cap (5 min) is the tightest bound and wins over the default", () => {
		expect(computeEffectiveMaxRecordingMs({ isFreePlan: true })).toBe(
			FREE_PLAN_MAX_RECORDING_MS,
		);
	});

	it("a free user's override cannot escape the free-plan cap", () => {
		// Even with "Record past 20 min" on, a genuinely free user stays capped at 5 min — the free bound is
		// tighter than the 45-min ceiling the override would otherwise grant.
		expect(
			computeEffectiveMaxRecordingMs({
				isFreePlan: true,
				overrideDefaultCap: true,
			}),
		).toBe(FREE_PLAN_MAX_RECORDING_MS);
	});

	it("always returns a finite ceiling ≤ the hard cap for every input combination", () => {
		for (const isFreePlan of [true, false]) {
			for (const overrideDefaultCap of [true, false, undefined]) {
				const ms = computeEffectiveMaxRecordingMs({
					isFreePlan,
					overrideDefaultCap,
				});
				expect(Number.isFinite(ms)).toBe(true);
				expect(ms).toBeGreaterThan(0);
				expect(ms).toBeLessThanOrEqual(HARD_MAX_RECORDING_MS);
			}
		}
	});
});
