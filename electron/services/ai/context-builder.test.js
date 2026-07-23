import { describe, expect, it } from "vitest";
import { SECTION_ORDER, DEFAULT_BUDGET, buildContext, normalizeBudget } from "./context-builder.cjs";

// ---------------------------------------------------------------------------
// WP-4.2's fourth criterion: "context size is bounded and truncation is
// deterministic". Both halves are tested here -- the bound as an actual
// character-count assertion on the rendered text, and determinism as
// byte-identical output across repeated and reordered builds.
// ---------------------------------------------------------------------------

const lines = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

describe("bounded", () => {
	it("never renders more than maxChars, however much it is given", () => {
		const sources = {
			memory: lines("memory", 200),
			tasks: lines("task", 200),
			findings: lines("finding", 200),
			notes: lines("note", 200),
			activity: lines("activity", 200),
		};

		for (const maxChars of [100, 500, 2000, 6000]) {
			const built = buildContext(sources, { budget: { maxChars } });
			expect(built.text.length, `budget ${maxChars}`).toBeLessThanOrEqual(maxChars);
			expect(built.chars).toBe(built.text.length);
		}
	});

	it("counts the header against the budget too", () => {
		const header = "H".repeat(80);
		const built = buildContext({ tasks: lines("task", 50) }, { budget: { maxChars: 120 }, header });
		expect(built.text.length).toBeLessThanOrEqual(120);
	});

	it("applies the per-section item cap before the character budget", () => {
		const built = buildContext(
			{ tasks: lines("task", 100) },
			{ budget: { maxChars: 100_000, maxItems: { tasks: 3 } } },
		);
		const tasks = built.sections.find((section) => section.id === "tasks");
		expect(tasks.includedCount).toBe(3);
		expect(tasks.totalCount).toBe(100);
		expect(tasks.truncated).toBe(true);
	});

	it("clips a single item longer than the whole budget rather than dropping the section", () => {
		const built = buildContext({ tasks: ["x".repeat(5000)] }, { budget: { maxItemChars: 50, maxChars: 1000 } });
		const tasks = built.sections.find((section) => section.id === "tasks");
		expect(tasks.lines[0]).toContain("(truncated)");
		expect(tasks.lines[0].length).toBeLessThan(100);
		expect(built.truncated).toBe(true);
	});
});

describe("deterministic", () => {
	const sources = {
		memory: lines("memory", 20),
		tasks: lines("task", 40),
		findings: lines("finding", 20),
		notes: lines("note", 20),
		activity: lines("activity", 60),
	};

	it("produces byte-identical output for identical input, repeatedly", () => {
		const first = buildContext(sources, { budget: { maxChars: 800 } });
		for (let i = 0; i < 5; i += 1) {
			expect(buildContext(sources, { budget: { maxChars: 800 } }).text).toBe(first.text);
		}
	});

	// Sections are filled in a FIXED priority order, so the sections themselves
	// arriving in a different object order must change nothing.
	it("does not depend on the key order of the sources object", () => {
		const reordered = {
			activity: sources.activity,
			notes: sources.notes,
			tasks: sources.tasks,
			findings: sources.findings,
			memory: sources.memory,
		};
		expect(buildContext(reordered, { budget: { maxChars: 800 } }).text).toBe(
			buildContext(sources, { budget: { maxChars: 800 } }).text,
		);
	});

	it("always drops from the end of each list, never the middle", () => {
		const built = buildContext({ tasks: lines("task", 10) }, { budget: { maxChars: 100_000, maxItems: { tasks: 4 } } });
		expect(built.sections.find((section) => section.id === "tasks").lines).toEqual([
			"task 1",
			"task 2",
			"task 3",
			"task 4",
		]);
	});

	// Priority order is the product decision: memory is what the user
	// explicitly asked to be remembered, so it survives a squeeze that costs
	// activity everything.
	it("keeps memory and sacrifices activity when the budget is tight", () => {
		// Sized so memory's heading, items and reserved note fit and nothing
		// else does.
		const built = buildContext(
			{ memory: lines("memory", 5), activity: lines("activity", 50) },
			{ budget: { maxChars: 120 } },
		);
		expect(built.sections.find((section) => section.id === "memory").includedCount).toBeGreaterThan(0);
		expect(built.sections.find((section) => section.id === "activity").includedCount).toBe(0);
		expect(built.text.length).toBeLessThanOrEqual(120);
	});

	// Priority order must not depend on how long each section's heading is: a
	// cheap low-priority section slipping in past a cut high-priority one would
	// make the result unpredictable.
	it("starts no further section once one has been cut short", () => {
		const built = buildContext(
			{ memory: lines("memory", 50), tasks: lines("task", 50), activity: lines("activity", 50) },
			{ budget: { maxChars: 300 } },
		);
		const memory = built.sections.find((section) => section.id === "memory");
		expect(memory.truncated).toBe(true);
		expect(built.sections.find((section) => section.id === "tasks").includedCount).toBe(0);
		expect(built.sections.find((section) => section.id === "activity").includedCount).toBe(0);
	});

	it("fills sections in the documented order", () => {
		const built = buildContext({ tasks: ["t"], memory: ["m"] }, {});
		expect(built.sections.map((section) => section.id)).toEqual(SECTION_ORDER);
	});
});

describe("reporting what happened", () => {
	it("tells the MODEL when a list was cut, not just the inspector", () => {
		const built = buildContext({ tasks: lines("task", 10) }, { budget: { maxChars: 100_000, maxItems: { tasks: 2 } } });
		expect(built.text).toContain("(2 of 10 shown)");
	});

	it("reports an empty section without rendering anything for it", () => {
		const built = buildContext({ tasks: ["only task"] }, {});
		const notes = built.sections.find((section) => section.id === "notes");
		expect(notes).toMatchObject({ includedCount: 0, totalCount: 0, truncated: false });
		expect(built.text).not.toContain("Recent notes");
	});

	it("reports truncated:false when everything fit", () => {
		expect(buildContext({ tasks: ["a", "b"] }, {}).truncated).toBe(false);
	});

	it("ignores blank and non-string entries rather than rendering empty bullets", () => {
		const built = buildContext({ tasks: ["real", "", "   ", null, 42] }, {});
		expect(built.sections.find((section) => section.id === "tasks").totalCount).toBe(1);
	});
});

describe("normalizeBudget", () => {
	it("falls back to the documented defaults", () => {
		expect(normalizeBudget(undefined)).toEqual({
			maxChars: DEFAULT_BUDGET.maxChars,
			maxItems: { ...DEFAULT_BUDGET.maxItems },
			maxItemChars: DEFAULT_BUDGET.maxItemChars,
		});
	});

	it("rejects nonsense rather than producing an unusable budget", () => {
		const budget = normalizeBudget({ maxChars: -5, maxItemChars: 0, maxItems: { tasks: -1 } });
		expect(budget.maxChars).toBe(DEFAULT_BUDGET.maxChars);
		expect(budget.maxItemChars).toBe(DEFAULT_BUDGET.maxItemChars);
		expect(budget.maxItems.tasks).toBe(DEFAULT_BUDGET.maxItems.tasks);
	});

	it("allows a section cap of zero -- 'never include this section' is a real choice", () => {
		expect(normalizeBudget({ maxItems: { activity: 0 } }).maxItems.activity).toBe(0);
	});

	it("does not let a caller mutate the shared defaults", () => {
		normalizeBudget({}).maxItems.tasks = 999;
		expect(DEFAULT_BUDGET.maxItems.tasks).not.toBe(999);
	});
});
