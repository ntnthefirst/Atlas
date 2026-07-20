import { describe, expect, it } from "vitest";
import { sessionElapsedMs } from "./sessionHelpers";
import type { Session } from "../types";

// A fixed "now" so every elapsed-time assertion is deterministic: 20 July 2026,
// midday local time. All session timestamps below are built relative to it.
const NOW = new Date(2026, 6, 20, 12, 0, 0).getTime();
const STARTED_AT = new Date(2026, 6, 20, 10, 0, 0).toISOString(); // 2h before NOW

const HOUR = 3_600_000;
const MINUTE = 60_000;

const session = (overrides: Partial<Session> = {}): Session => ({
	id: "session-1",
	map_id: "map-1",
	started_at: STARTED_AT,
	ended_at: null,
	total_duration: 0,
	paused_duration: 0,
	is_active: 1,
	is_paused: 0,
	pause_started_at: null,
	created_at: STARTED_AT,
	...overrides,
});

describe("sessionElapsedMs — ended sessions", () => {
	it("uses ended_at instead of now, minus any accumulated pause time", () => {
		const s = session({
			ended_at: new Date(2026, 6, 20, 11, 30, 0).toISOString(), // 90 minutes after start
			paused_duration: 10 * MINUTE,
			is_active: 0,
			is_paused: 0,
		});
		// 90 minutes elapsed, minus 10 minutes paused = 80 minutes.
		expect(sessionElapsedMs(s, NOW)).toBe(80 * MINUTE);
	});

	it("ignores now entirely once a session has ended", () => {
		const s = session({
			ended_at: new Date(2026, 6, 20, 10, 30, 0).toISOString(),
			is_active: 0,
		});
		const farFuture = NOW + 1000 * HOUR;
		expect(sessionElapsedMs(s, farFuture)).toBe(sessionElapsedMs(s, NOW));
	});

	it("does not add live pause overhead for an ended session, even if pause fields are stale/left set", () => {
		// is_active is 0 (session over), but is_paused/pause_started_at were left
		// populated. The live top-up only applies while is_active is truthy, so
		// it must be skipped here regardless of the other two fields.
		const s = session({
			ended_at: new Date(2026, 6, 20, 11, 0, 0).toISOString(), // 1h after start
			paused_duration: 5 * MINUTE,
			is_active: 0,
			is_paused: 1,
			pause_started_at: new Date(2026, 6, 20, 10, 45, 0).toISOString(),
		});
		expect(sessionElapsedMs(s, NOW)).toBe(HOUR - 5 * MINUTE);
	});
});

describe("sessionElapsedMs — active, running sessions", () => {
	it("measures from started_at up to now when not paused", () => {
		const s = session({ is_active: 1, is_paused: 0 });
		// Started 2 hours before NOW, no pauses.
		expect(sessionElapsedMs(s, NOW)).toBe(2 * HOUR);
	});

	it("subtracts prior accumulated pause time even while running", () => {
		const s = session({ is_active: 1, is_paused: 0, paused_duration: 15 * MINUTE });
		expect(sessionElapsedMs(s, NOW)).toBe(2 * HOUR - 15 * MINUTE);
	});

	it("does not add extra pause time when is_paused is set but pause_started_at is missing", () => {
		const s = session({ is_active: 1, is_paused: 1, pause_started_at: null, paused_duration: 15 * MINUTE });
		expect(sessionElapsedMs(s, NOW)).toBe(2 * HOUR - 15 * MINUTE);
	});
});

describe("sessionElapsedMs — active, currently paused sessions", () => {
	it("adds the live pause span on top of any prior accumulated pause time", () => {
		const s = session({
			is_active: 1,
			is_paused: 1,
			paused_duration: 10 * MINUTE, // from an earlier pause segment
			pause_started_at: new Date(2026, 6, 20, 11, 0, 0).toISOString(), // paused for the last 1h
		});
		// 2h total span, minus (10m prior pause + 1h current pause) = 50 minutes.
		expect(sessionElapsedMs(s, NOW)).toBe(2 * HOUR - (10 * MINUTE + HOUR));
	});

	it("treats a pause_started_at in the future as zero extra pause time, not negative", () => {
		const s = session({
			is_active: 1,
			is_paused: 1,
			paused_duration: 0,
			pause_started_at: new Date(NOW + MINUTE).toISOString(),
		});
		expect(sessionElapsedMs(s, NOW)).toBe(2 * HOUR);
	});
});

describe("sessionElapsedMs — never returns negative elapsed time", () => {
	it("clamps to zero when the session started after now", () => {
		const s = session({
			started_at: new Date(NOW + HOUR).toISOString(),
			is_active: 1,
			is_paused: 0,
		});
		expect(sessionElapsedMs(s, NOW)).toBe(0);
	});

	it("clamps to zero when accumulated pause time exceeds the running span", () => {
		const s = session({
			is_active: 1,
			is_paused: 0,
			paused_duration: 100 * HOUR,
		});
		expect(sessionElapsedMs(s, NOW)).toBe(0);
	});
});
