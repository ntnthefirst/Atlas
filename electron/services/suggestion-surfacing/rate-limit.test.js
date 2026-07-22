import { describe, expect, it } from "vitest";
import { canSurfaceSuggestion, isSameCalendarDay } from "./rate-limit.cjs";

const HOUR = 60 * 60 * 1000;

// isSameCalendarDay() deliberately compares LOCAL calendar days (see its own
// header), so every fixture below is built from LOCAL date/time components
// (the `Date` constructor's year/month/day/hour form) rather than parsed from
// a UTC "Z" ISO string -- parsing a fixed UTC instant would silently land on
// a different local day depending on the machine's own timezone offset, which
// is exactly the kind of environment-dependent flakiness this suite must not
// have.
function localTime(year, month, day, hour = 0, minute = 0) {
	return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

describe("isSameCalendarDay", () => {
	it("is true for two timestamps on the same local day", () => {
		const a = localTime(2026, 1, 10, 0, 5);
		const b = localTime(2026, 1, 10, 23, 50);
		expect(isSameCalendarDay(a, b)).toBe(true);
	});

	it("is false across a midnight boundary, even less than an hour apart", () => {
		const a = localTime(2026, 1, 10, 23, 59);
		const b = localTime(2026, 1, 11, 0, 1);
		expect(isSameCalendarDay(a, b)).toBe(false);
	});
});

describe("canSurfaceSuggestion -- per-session limit", () => {
	const now = localTime(2026, 1, 10, 12, 0);
	const sessionStartMs = localTime(2026, 1, 10, 9, 0);
	const config = { maxPerSession: 2, maxPerDay: 50 }; // daily cap wide open, isolates the session check

	it("allows the Nth suggestion this session (N = maxPerSession)", () => {
		const history = { sessionStartMs, suggestedAtMsList: [sessionStartMs + HOUR] }; // 1 so far, cap is 2
		expect(canSurfaceSuggestion(history, now, config)).toEqual({ allowed: true, reason: null });
	});

	it("denies the (N+1)th suggestion this session", () => {
		const history = {
			sessionStartMs,
			suggestedAtMsList: [sessionStartMs + HOUR, sessionStartMs + 2 * HOUR], // 2 so far, cap is 2
		};
		expect(canSurfaceSuggestion(history, now, config)).toEqual({ allowed: false, reason: "session_limit" });
	});

	it("allows the very first suggestion of a session with empty history", () => {
		const history = { sessionStartMs, suggestedAtMsList: [] };
		expect(canSurfaceSuggestion(history, now, { maxPerSession: 1, maxPerDay: 50 })).toEqual({
			allowed: true,
			reason: null,
		});
	});

	it("denies a second suggestion once the default (1-per-session) cap is already used", () => {
		const history = { sessionStartMs, suggestedAtMsList: [sessionStartMs + HOUR] };
		expect(canSurfaceSuggestion(history, now, { maxPerSession: 1, maxPerDay: 50 })).toEqual({
			allowed: false,
			reason: "session_limit",
		});
	});

	it("ignores a suggestion timestamped BEFORE this session started -- it doesn't count against the session cap", () => {
		// Actively opposing fixture: without the sessionStartMs filter this would
		// obviously read as "1 suggestion already this session" and deny.
		const beforeSession = sessionStartMs - HOUR;
		const history = { sessionStartMs, suggestedAtMsList: [beforeSession] };
		expect(canSurfaceSuggestion(history, now, { maxPerSession: 1, maxPerDay: 50 })).toEqual({
			allowed: true,
			reason: null,
		});
	});
});

describe("canSurfaceSuggestion -- global per-day cap", () => {
	const now = localTime(2026, 1, 10, 18, 0);
	const config = { maxPerSession: 50, maxPerDay: 3 }; // session cap wide open, isolates the daily check

	it("allows the Nth suggestion today (N = maxPerDay)", () => {
		const sessionStartMs = now - HOUR;
		const history = {
			sessionStartMs,
			suggestedAtMsList: [localTime(2026, 1, 10, 1, 0), localTime(2026, 1, 10, 5, 0)], // 2 today so far, cap is 3
		};
		expect(canSurfaceSuggestion(history, now, config)).toEqual({ allowed: true, reason: null });
	});

	it("denies the (N+1)th suggestion today", () => {
		const sessionStartMs = now - HOUR;
		const history = {
			sessionStartMs,
			suggestedAtMsList: [
				localTime(2026, 1, 10, 1, 0),
				localTime(2026, 1, 10, 5, 0),
				localTime(2026, 1, 10, 9, 0),
			], // 3 today so far, cap is 3
		};
		expect(canSurfaceSuggestion(history, now, config)).toEqual({ allowed: false, reason: "daily_limit" });
	});

	it("does not count YESTERDAY's suggestions against today's cap", () => {
		// Actively opposing fixture: 3 suggestions exist in history (matching the
		// cap exactly), but every one of them is from a previous calendar day --
		// a naive "count every timestamp in history" implementation would wrongly
		// deny this.
		const sessionStartMs = now - HOUR;
		const history = {
			sessionStartMs,
			suggestedAtMsList: [
				localTime(2026, 1, 9, 1, 0),
				localTime(2026, 1, 9, 5, 0),
				localTime(2026, 1, 9, 9, 0),
			],
		};
		expect(canSurfaceSuggestion(history, now, config)).toEqual({ allowed: true, reason: null });
	});
});

describe("canSurfaceSuggestion -- a new session resets the per-session cap but NOT the daily cap", () => {
	const config = { maxPerSession: 1, maxPerDay: 1 };

	it("a fresh session (new sessionStartMs) with one suggestion already shown TODAY is denied by the daily cap alone", () => {
		const earlierToday = localTime(2026, 1, 10, 8, 0); // a previous session's own suggestion
		const newSessionStartMs = localTime(2026, 1, 10, 14, 0); // this process just started
		const now = localTime(2026, 1, 10, 14, 5);

		// The per-session slice is empty (the one prior suggestion predates this
		// session), so if the daily cap didn't exist independently this would be
		// wrongly allowed.
		const history = { sessionStartMs: newSessionStartMs, suggestedAtMsList: [earlierToday] };
		const result = canSurfaceSuggestion(history, now, config);
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("daily_limit");
	});

	it("the same fresh session on a NEW calendar day is allowed -- the daily cap resets, the session cap stays reset too", () => {
		const yesterday = localTime(2026, 1, 10, 8, 0);
		const newSessionStartMs = localTime(2026, 1, 11, 9, 0);
		const now = localTime(2026, 1, 11, 9, 5);

		const history = { sessionStartMs: newSessionStartMs, suggestedAtMsList: [yesterday] };
		expect(canSurfaceSuggestion(history, now, config)).toEqual({ allowed: true, reason: null });
	});
});

describe("canSurfaceSuggestion -- defensive input handling", () => {
	const now = localTime(2026, 1, 10, 12, 0);

	it("treats missing/malformed history as empty, never throwing", () => {
		expect(canSurfaceSuggestion(undefined, now, { maxPerSession: 1, maxPerDay: 1 })).toEqual({
			allowed: true,
			reason: null,
		});
		expect(canSurfaceSuggestion({ suggestedAtMsList: "nope" }, now, { maxPerSession: 1, maxPerDay: 1 })).toEqual({
			allowed: true,
			reason: null,
		});
	});

	it("drops non-finite entries from the history list rather than letting them corrupt a count", () => {
		const sessionStartMs = now - HOUR;
		const history = { sessionStartMs, suggestedAtMsList: [NaN, null, undefined, "garbage"] };
		expect(canSurfaceSuggestion(history, now, { maxPerSession: 1, maxPerDay: 1 })).toEqual({
			allowed: true,
			reason: null,
		});
	});
});

