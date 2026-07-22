import { describe, expect, it } from "vitest";
import {
	BROWSING,
	CODING,
	COMMUNICATION,
	CONTEXTS,
	classifyProcessName,
	createInitialContextState,
	nextContextState,
} from "./context-detection.cjs";

// ---------------------------------------------------------------------------
// The pure context detector (WP-2.8). Every clock reading is an explicit
// number, so a 45-second dwell rule is exercised in microseconds and the
// no-flapping criterion is tested directly rather than inferred.
// ---------------------------------------------------------------------------

// Scaled-down stand-ins for the real 45s dwell / 12s gap. The same ratio
// holds: observations arrive well inside the gap tolerance, so an
// uninterrupted challenger accumulates, and the tolerance is far below the
// dwell.
const DWELL = 1000;
const GAP = 600;
const OPTIONS = { dwellMs: DWELL, candidateGapMs: GAP };

// Feeds a scripted sequence of [processName, at] observations through the
// reducer and returns the final state plus every tick a switch happened on.
function run(script, { initial = createInitialContextState(0), options = OPTIONS } = {}) {
	let state = initial;
	const switches = [];
	for (const [processName, at] of script) {
		state = nextContextState(state, { context: classifyProcessName(processName), at }, options);
		if (state.changed) {
			switches.push({ context: state.context, at });
		}
	}
	return { state, switches };
}

describe("classifyProcessName", () => {
	it("maps real process names to each of the three required contexts", () => {
		expect(classifyProcessName("Code")).toBe(CODING);
		expect(classifyProcessName("slack")).toBe(COMMUNICATION);
		expect(classifyProcessName("msedge")).toBe(BROWSING);
		// All three the plan requires are actually reachable.
		expect(new Set([CODING, COMMUNICATION, BROWSING])).toEqual(new Set(CONTEXTS));
	});

	it("is case-insensitive and tolerates surrounding whitespace", () => {
		expect(classifyProcessName("  DEVENV  ")).toBe(CODING);
	});

	it("returns null for anything it does not recognise, rather than guessing", () => {
		expect(classifyProcessName("explorer")).toBeNull();
		expect(classifyProcessName("some-inhouse-tool")).toBeNull();
		expect(classifyProcessName("")).toBeNull();
		expect(classifyProcessName(null)).toBeNull();
		expect(classifyProcessName(undefined)).toBeNull();
		expect(classifyProcessName(42)).toBeNull();
		// The platform adapter's own "couldn't identify the window" answer.
		expect(classifyProcessName("Unknown")).toBeNull();
	});

	it("does not match on substrings -- a coincidental name is not a signal", () => {
		// "code" is a substring of both; neither is an editor.
		expect(classifyProcessName("qrcodegen")).toBeNull();
		expect(classifyProcessName("barcode")).toBeNull();
	});
});

describe("nextContextState -- sustained signal before switching", () => {
	it("does not switch on a signal shorter than the dwell", () => {
		const { state, switches } = run([
			["code", 0],
			["code", 400],
			["code", 900],
		]);
		expect(switches).toHaveLength(0);
		expect(state.context).toBeNull();
		// It is tracking the challenger, it just hasn't committed.
		expect(state.candidate).toBe(CODING);
	});

	it("switches once the dwell is met, and reports the change exactly once", () => {
		const { state, switches } = run([
			["code", 0],
			["code", 500],
			["code", 1000],
			["code", 1500],
		]);
		expect(switches).toEqual([{ context: CODING, at: 1000 }]);
		expect(state.context).toBe(CODING);
		expect(state.candidate).toBeNull();
	});

	// The acceptance criterion, stated directly: alt-tabbing away briefly must
	// not move the layout.
	it("a brief alt-tab away does not change the committed context", () => {
		const script = [
			["code", 0],
			["code", 500],
			["code", 1000], // commits to coding
			["slack", 1100], // a glance at a message...
			["slack", 1200],
			["code", 1300], // ...and straight back
			["code", 1400],
		];
		const { state, switches } = run(script);
		expect(switches).toEqual([{ context: CODING, at: 1000 }]);
		expect(state.context).toBe(CODING);
		// The glance left no half-built challenger behind either.
		expect(state.candidate).toBeNull();
	});

	it("does not flap when two contexts alternate rapidly, however long it goes on", () => {
		const script = [];
		for (let i = 0; i <= 40; i += 1) {
			script.push([i % 2 === 0 ? "code" : "slack", i * 100]);
		}
		const { switches } = run(script);
		// Neither ever holds the foreground for a full dwell, so nothing is
		// ever committed -- 4 seconds of frantic alt-tabbing, zero layout moves.
		expect(script.length).toBeGreaterThan(0);
		expect(switches).toHaveLength(0);
	});

	it("a challenger that gives up resets, so its next attempt starts from scratch", () => {
		const { switches } = run([
			["slack", 0],
			["slack", 500],
			["slack", 900], // nearly there...
			["code", 950], // ...but a different app interrupts
			["slack", 1000], // slack restarts its dwell here, not at 0
			["slack", 1500],
			["slack", 1900], // only 900ms since the restart: still short
		]);
		expect(switches).toHaveLength(0);
	});
});

describe("nextContextState -- unclassified apps are not evidence", () => {
	it("an unclassified app neither commits nor disturbs the committed context", () => {
		const { state, switches } = run([
			["code", 0],
			["code", 500],
			["code", 1000], // coding committed
			["explorer", 1100],
			["explorer", 5000],
		]);
		expect(switches).toEqual([{ context: CODING, at: 1000 }]);
		expect(state.context).toBe(CODING);
	});

	it("an unclassified app in the middle does not reset a challenger's progress", () => {
		const { switches } = run([
			["slack", 0],
			["explorer", 100], // a file dialog, say
			["slack", 200],
			["slack", 700],
			["slack", 1000],
		]);
		expect(switches).toEqual([{ context: COMMUNICATION, at: 1000 }]);
	});

	it("never commits to a context on unclassified input alone", () => {
		const { state } = run([
			["explorer", 0],
			["notepad", 1000],
			["some-tool", 9000],
		]);
		expect(state.context).toBeNull();
		expect(state.candidate).toBeNull();
	});
});

describe("nextContextState -- the gap rule", () => {
	// Without this, two isolated glances minutes apart would satisfy a
	// wall-clock dwell and flip the layout. See the module header.
	it("restarts the dwell when a challenger vanishes for longer than the gap tolerance", () => {
		const { state, switches } = run([
			["slack", 0], // one glance
			["explorer", 100],
			["explorer", 5000], // five seconds elsewhere -- far beyond GAP
			["slack", 5100], // second glance: must NOT satisfy the 1000ms dwell
		]);
		expect(switches).toHaveLength(0);
		expect(state.candidateSince).toBe(5100);
	});

	it("tolerates a gap shorter than the tolerance -- a missed poll is a hiccup, not an absence", () => {
		const { switches } = run([
			["slack", 0],
			["explorer", 100], // one poll's worth of interruption (< GAP)
			["slack", 250],
			["slack", 750],
			["slack", 1000],
		]);
		expect(switches).toEqual([{ context: COMMUNICATION, at: 1000 }]);
	});
});

describe("nextContextState -- switching between committed contexts", () => {
	it("moves from one committed context to another only after a full dwell", () => {
		const { state, switches } = run([
			["code", 0],
			["code", 500],
			["code", 1000], // coding
			["slack", 1100],
			["slack", 1600], // 500ms -- not yet
			["slack", 2100], // 1000ms since 1100 -- now
		]);
		expect(switches).toEqual([
			{ context: CODING, at: 1000 },
			{ context: COMMUNICATION, at: 2100 },
		]);
		expect(state.context).toBe(COMMUNICATION);
		expect(state.changedAt).toBe(2100);
	});

	it("reaches all three contexts in one run", () => {
		const { switches } = run([
			["code", 0],
			["code", 500],
			["code", 1000],
			["slack", 1100],
			["slack", 1600],
			["slack", 2100],
			["chrome", 2200],
			["chrome", 2700],
			["chrome", 3200],
		]);
		expect(switches.map((entry) => entry.context)).toEqual([CODING, COMMUNICATION, BROWSING]);
	});
});

describe("nextContextState -- robustness on a polling path", () => {
	it("tolerates a missing state, observation or clock without throwing", () => {
		expect(() => nextContextState(undefined, undefined, undefined)).not.toThrow();
		const state = nextContextState(undefined, { context: CODING }, OPTIONS);
		expect(state.candidate).toBe(CODING);
	});

	it("never mutates the state it was handed", () => {
		const initial = createInitialContextState(0);
		const frozen = Object.freeze({ ...initial });
		expect(() => nextContextState(frozen, { context: CODING, at: 10 }, OPTIONS)).not.toThrow();
		expect(frozen.candidate).toBeNull();
	});
});
