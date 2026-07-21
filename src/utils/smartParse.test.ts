import { describe, expect, it } from "vitest";
import { parseCapture, type CaptureContext } from "./smartParse";
import type { Environment, TaskColumn } from "../types";

// A fixed "now" so every date assertion is deterministic: 15 June 2026, midday
// local time. Weekday-dependent assertions derive the expected day from the
// same Date API rather than hardcoding it, so the suite stays correct
// regardless of the machine's locale or timezone.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

const ENVIRONMENTS: Environment[] = [
	{ id: "env-work", name: "Work", isolation_mode: "connected", created_at: "2026-01-01T00:00:00.000Z" },
	{ id: "env-school", name: "School Project", isolation_mode: "connected", created_at: "2026-01-01T00:00:00.000Z" },
	{ id: "env-personal", name: "Personal", isolation_mode: "connected", created_at: "2026-01-01T00:00:00.000Z" },
];

const COLUMNS: TaskColumn[] = [
	{ status: "todo", label: "To do" },
	{ status: "in-progress", label: "In progress" },
	{ status: "done", label: "Done" },
];

const context = (overrides: Partial<CaptureContext> = {}): CaptureContext => ({
	now: NOW,
	environments: ENVIRONMENTS,
	currentEnvironmentId: "env-work",
	columnsFor: () => COLUMNS,
	...overrides,
});

const parse = (raw: string, overrides: Partial<CaptureContext> = {}) => parseCapture(raw, context(overrides));

describe("parseCapture — task vs note routing", () => {
	it("defaults to a task", () => {
		expect(parse("Fix the login bug").kind).toBe("task");
	});

	it("honours an explicit note prefix", () => {
		const result = parse("note: the API rate limits at 100/min");
		expect(result.kind).toBe("note");
		expect(result.title).toBe("the API rate limits at 100/min");
	});

	it("honours an explicit task prefix", () => {
		const result = parse("task: ship the release");
		expect(result.kind).toBe("task");
		expect(result.title).toBe("ship the release");
	});

	it("infers a note from a leading note word", () => {
		expect(parse("idea for the notch layout").kind).toBe("note");
		expect(parse("remember to check the certs").kind).toBe("note");
	});

	it("leaves column fields null on notes", () => {
		const result = parse("note: just a thought");
		expect(result.columnStatus).toBeNull();
		expect(result.columnLabel).toBeNull();
	});
});

describe("parseCapture — priority", () => {
	it("defaults to none", () => {
		expect(parse("Water the plants").priority).toBe("none");
	});

	it("reads explicit flags", () => {
		expect(parse("Patch the CVE !high").priority).toBe("high");
		expect(parse("Patch the CVE !low").priority).toBe("low");
		expect(parse("Patch the CVE !med").priority).toBe("medium");
	});

	it("reads single-letter shorthands", () => {
		expect(parse("Deploy !u").priority).toBe("urgent");
		expect(parse("Deploy !h").priority).toBe("high");
	});

	it("reads bang runs", () => {
		expect(parse("Call the client !").priority).toBe("medium");
		expect(parse("Call the client !!").priority).toBe("high");
		expect(parse("Call the client !!!").priority).toBe("urgent");
	});

	it("reads unambiguous urgency words and strips them from the title", () => {
		const result = parse("urgent: patch the CVE");
		expect(result.priority).toBe("urgent");
		expect(result.title).toBe("patch the CVE");
	});

	it("keeps the first priority signal when several are present", () => {
		expect(parse("Thing !high !low").priority).toBe("high");
	});
});

describe("parseCapture — tags", () => {
	it("collects tags and lowercases them", () => {
		const result = parse("Write the docs #Docs #release");
		expect(result.tags).toEqual(["docs", "release"]);
	});

	it("deduplicates repeated tags", () => {
		expect(parse("Thing #dup #dup").tags).toEqual(["dup"]);
	});

	it("removes tags from the title", () => {
		expect(parse("Write the docs #docs").title).toBe("Write the docs");
	});

	it("returns an empty array when there are none", () => {
		expect(parse("Plain task").tags).toEqual([]);
	});
});

describe("parseCapture — environment targeting", () => {
	it("resolves an exact @mention", () => {
		const result = parse("Standup notes @work");
		expect(result.environmentId).toBe("env-work");
		expect(result.environmentName).toBe("Work");
	});

	it("resolves a leading-substring @mention", () => {
		expect(parse("Essay draft @school").environmentId).toBe("env-school");
	});

	it("strips a resolved mention from the title", () => {
		expect(parse("Standup notes @work").title).toBe("Standup notes");
	});

	it("keeps an unresolvable mention in the title and falls back to the current environment", () => {
		const result = parse("Ping @nobody about it");
		expect(result.environmentId).toBe("env-work");
		expect(result.title).toContain("@nobody");
	});

	it("falls back to the current environment with no mention, and reports no name", () => {
		const result = parse("Plain task");
		expect(result.environmentId).toBe("env-work");
		expect(result.environmentName).toBeNull();
	});

	it("handles having no current environment at all", () => {
		const result = parse("Plain task", { currentEnvironmentId: null });
		expect(result.environmentId).toBeNull();
	});
});

describe("parseCapture — due dates", () => {
	it("reads today", () => {
		expect(parse("Send the invoice today").dueDate).toBe("2026-06-15");
		expect(parse("Send the invoice today").dueLabel).toBe("Today");
	});

	it("reads tomorrow and its shorthands", () => {
		expect(parse("Call back tomorrow").dueDate).toBe("2026-06-16");
		expect(parse("Call back tmrw").dueDate).toBe("2026-06-16");
		expect(parse("Call back tomorrow").dueLabel).toBe("Tomorrow");
	});

	it("reads relative day and week offsets", () => {
		expect(parse("Review in 3 days").dueDate).toBe("2026-06-18");
		expect(parse("Review in 2 weeks").dueDate).toBe("2026-06-29");
		expect(parse("Review next week").dueDate).toBe("2026-06-22");
	});

	it("reads an explicit ISO date", () => {
		expect(parse("Renew the domain 2026-09-01").dueDate).toBe("2026-09-01");
	});

	it("reads day-month text in both orders", () => {
		expect(parse("Conference 5 jul").dueDate).toBe("2026-07-05");
		expect(parse("Conference jul 5").dueDate).toBe("2026-07-05");
	});

	it("rolls a bare past date forward to next year", () => {
		// 5 January is behind the fixed NOW of 15 June 2026.
		expect(parse("Kickoff 5 jan").dueDate).toBe("2027-01-05");
	});

	it("resolves a weekday to a strictly future date", () => {
		const result = parse("Retro on friday");
		expect(result.dueDate).not.toBeNull();
		const resolved = new Date(`${result.dueDate}T00:00:00`);
		expect(resolved.getDay()).toBe(5);
		expect(resolved.getTime()).toBeGreaterThan(NOW - 86_400_000);
	});

	it("returns null when there is no date", () => {
		const result = parse("Plain task");
		expect(result.dueDate).toBeNull();
		expect(result.dueLabel).toBeNull();
	});

	it("removes the date text from the title", () => {
		expect(parse("Call back tomorrow").title).toBe("Call back");
	});
});

describe("parseCapture — column routing", () => {
	it("routes to the first column by default", () => {
		const result = parse("Fix the bug");
		expect(result.columnStatus).toBe("todo");
		expect(result.columnLabel).toBe("To do");
	});

	it("detects work in progress", () => {
		expect(parse("working on the parser").columnStatus).toBe("in-progress");
	});

	it("detects completion", () => {
		expect(parse("shipped the release").columnStatus).toBe("done");
	});

	it("honours an explicit > column hint", () => {
		expect(parse("Fix the bug >Done").columnStatus).toBe("done");
	});

	it("falls back gracefully when the environment has no columns", () => {
		const result = parse("Fix the bug", { columnsFor: () => [] });
		expect(result.columnStatus).toBeNull();
		expect(result.columnLabel).toBeNull();
	});
});

describe("parseCapture — title cleanup", () => {
	it("strips list bullets", () => {
		expect(parse("- Buy milk").title).toBe("Buy milk");
		expect(parse("* Buy milk").title).toBe("Buy milk");
	});

	it("strips checkbox markers", () => {
		expect(parse("[ ] Buy milk").title).toBe("Buy milk");
		expect(parse("[x] Buy milk").title).toBe("Buy milk");
	});

	it("collapses whitespace left behind by extracted tokens", () => {
		expect(parse("Ship  the   release").title).toBe("Ship the release");
	});

	it("never returns an empty title", () => {
		// Input made entirely of tokens that get lifted out.
		const result = parse("#tag");
		expect(result.title.length).toBeGreaterThan(0);
	});

	it("preserves the raw input verbatim", () => {
		const raw = "Ship it tomorrow #release !high @work";
		expect(parse(raw).raw).toBe(raw);
	});
});

describe("parseCapture — combined input", () => {
	it("extracts every signal from one line", () => {
		const result = parse("task: Ship the release tomorrow #release #ops !high @work");

		expect(result.kind).toBe("task");
		expect(result.title).toBe("Ship the release");
		expect(result.priority).toBe("high");
		expect(result.dueDate).toBe("2026-06-16");
		expect(result.tags).toEqual(["release", "ops"]);
		expect(result.environmentId).toBe("env-work");
		expect(result.environmentName).toBe("Work");
		expect(result.columnStatus).toBe("todo");
	});

	it("explains its decisions", () => {
		const result = parse("Ship it tomorrow #release !high @work");
		expect(result.reasons.length).toBeGreaterThan(0);
		// The first reason is always the headline routing decision.
		expect(result.reasons[0]).toContain("Task");
		expect(result.reasons.join(" ")).toContain("Work");
	});
});
