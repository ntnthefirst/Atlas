import { describe, expect, it } from "vitest";
import {
	ISOLATION_MODES,
	VALID_ISOLATION_MODES,
	DEFAULT_ISOLATION_MODE,
	isValidIsolationMode,
	CROSS_ENVIRONMENT_SIGNALS,
	CROSS_ENVIRONMENT_ALLOWLIST,
	isAllowlistedSignal,
	isCrossEnvironmentReadAllowed,
} from "./isolation.cjs";

// ---------------------------------------------------------------------------
// The isolation POLICY (WP-0.8), tested as pure data -- no database, no IPC.
// The most important assertion in this file is the allowlist's exact
// contents: per the WP, widening it must always be a deliberate, reviewable
// code change, which only works if a test pins the list down precisely
// rather than merely checking "contains at least X".
// ---------------------------------------------------------------------------

describe("isolation modes", () => {
	it("defines exactly two modes: connected and enclosed", () => {
		expect(ISOLATION_MODES).toEqual({ CONNECTED: "connected", ENCLOSED: "enclosed" });
		expect(VALID_ISOLATION_MODES).toEqual(["connected", "enclosed"]);
	});

	it("defaults to connected", () => {
		expect(DEFAULT_ISOLATION_MODE).toBe(ISOLATION_MODES.CONNECTED);
	});

	it("validates only the two known modes", () => {
		expect(isValidIsolationMode("connected")).toBe(true);
		expect(isValidIsolationMode("enclosed")).toBe(true);
		expect(isValidIsolationMode("private")).toBe(false);
		expect(isValidIsolationMode("shared")).toBe(false);
		expect(isValidIsolationMode("")).toBe(false);
		expect(isValidIsolationMode(null)).toBe(false);
		expect(isValidIsolationMode(undefined)).toBe(false);
	});
});

describe("the cross-environment allowlist -- exact contents", () => {
	// This is THE test the WP calls out by name: "The allowlist is a single
	// exported constant with a test asserting its exact contents -- so
	// widening it is always a deliberate, reviewable act." toEqual (not
	// "contains" / "toMatchObject") is deliberate: adding an entry without
	// updating this test must fail, not pass silently.
	it("contains exactly one signal: environment_time_totals", () => {
		expect(CROSS_ENVIRONMENT_ALLOWLIST).toEqual(["environment_time_totals"]);
	});

	it("names that one signal via CROSS_ENVIRONMENT_SIGNALS", () => {
		expect(CROSS_ENVIRONMENT_SIGNALS).toEqual({ ENVIRONMENT_TIME_TOTALS: "environment_time_totals" });
	});

	it("is frozen, so a call site cannot widen it by mutation", () => {
		expect(Object.isFrozen(CROSS_ENVIRONMENT_ALLOWLIST)).toBe(true);
		expect(Object.isFrozen(CROSS_ENVIRONMENT_SIGNALS)).toBe(true);
		expect(() => CROSS_ENVIRONMENT_ALLOWLIST.push("something_else")).toThrow();
	});

	it("recognizes only the allowlisted signal, nothing invented or hypothetical", () => {
		expect(isAllowlistedSignal("environment_time_totals")).toBe(true);
		expect(isAllowlistedSignal("app_frecency")).toBe(false);
		expect(isAllowlistedSignal("task_titles")).toBe(false);
		expect(isAllowlistedSignal("note_bodies")).toBe(false);
		expect(isAllowlistedSignal("")).toBe(false);
		expect(isAllowlistedSignal(undefined)).toBe(false);
	});
});

describe("isCrossEnvironmentReadAllowed() -- the single decision point", () => {
	const SIGNAL = CROSS_ENVIRONMENT_SIGNALS.ENVIRONMENT_TIME_TOTALS;

	it("allows a connected requester to read the allowlisted signal about another connected environment", () => {
		expect(
			isCrossEnvironmentReadAllowed({
				requesterMode: ISOLATION_MODES.CONNECTED,
				targetMode: ISOLATION_MODES.CONNECTED,
				signal: SIGNAL,
			}),
		).toBe(true);
	});

	it("denies a connected requester reading about an enclosed target -- the enclosed side contributes nothing", () => {
		expect(
			isCrossEnvironmentReadAllowed({
				requesterMode: ISOLATION_MODES.CONNECTED,
				targetMode: ISOLATION_MODES.ENCLOSED,
				signal: SIGNAL,
			}),
		).toBe(false);
	});

	it("denies an enclosed requester reading about a connected target -- the enclosed side sees nothing global", () => {
		expect(
			isCrossEnvironmentReadAllowed({
				requesterMode: ISOLATION_MODES.ENCLOSED,
				targetMode: ISOLATION_MODES.CONNECTED,
				signal: SIGNAL,
			}),
		).toBe(false);
	});

	it("denies enclosed-to-enclosed too, for good measure", () => {
		expect(
			isCrossEnvironmentReadAllowed({
				requesterMode: ISOLATION_MODES.ENCLOSED,
				targetMode: ISOLATION_MODES.ENCLOSED,
				signal: SIGNAL,
			}),
		).toBe(false);
	});

	it("denies any signal not on the allowlist, even between two connected environments", () => {
		expect(
			isCrossEnvironmentReadAllowed({
				requesterMode: ISOLATION_MODES.CONNECTED,
				targetMode: ISOLATION_MODES.CONNECTED,
				signal: "task_titles",
			}),
		).toBe(false);
		expect(
			isCrossEnvironmentReadAllowed({
				requesterMode: ISOLATION_MODES.CONNECTED,
				targetMode: ISOLATION_MODES.CONNECTED,
				signal: undefined,
			}),
		).toBe(false);
	});

	it("fails closed on an unrecognized mode string instead of assuming connected", () => {
		expect(
			isCrossEnvironmentReadAllowed({
				requesterMode: "super-admin",
				targetMode: ISOLATION_MODES.CONNECTED,
				signal: SIGNAL,
			}),
		).toBe(false);
		expect(
			isCrossEnvironmentReadAllowed({
				requesterMode: ISOLATION_MODES.CONNECTED,
				targetMode: "super-admin",
				signal: SIGNAL,
			}),
		).toBe(false);
	});

	it("fails closed when called with no arguments at all", () => {
		expect(isCrossEnvironmentReadAllowed()).toBe(false);
		expect(isCrossEnvironmentReadAllowed({})).toBe(false);
	});
});
