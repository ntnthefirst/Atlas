import { describe, expect, it } from "vitest";
import { normalizeColumns, reorderTaskIds, sortTasksByOrder } from "./taskHelpers";
import type { TaskColumn, TaskItem } from "../types";

const task = (overrides: Partial<TaskItem> = {}): TaskItem => ({
	id: "t-1",
	map_id: "map-1",
	title: "Untitled",
	description: "",
	status: "todo",
	priority: "none",
	tags: [],
	due_date: null,
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
	...overrides,
});

describe("reorderTaskIds", () => {
	it("moves an item forward, before its target by default", () => {
		expect(reorderTaskIds(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "a", "c", "d"]);
	});

	it("moves an item forward, after its target when asked", () => {
		expect(reorderTaskIds(["a", "b", "c", "d"], "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
	});

	it("moves an item backward, before its target", () => {
		expect(reorderTaskIds(["a", "b", "c", "d"], "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
	});

	it("moves an item backward, after its target", () => {
		expect(reorderTaskIds(["a", "b", "c", "d"], "d", "b", "after")).toEqual(["a", "b", "d", "c"]);
	});

	it("appends the dragged id to the end when the target does not exist in the list", () => {
		expect(reorderTaskIds(["a", "b", "c"], "a", "zzz")).toEqual(["b", "c", "a"]);
	});

	it("sends the item to the end when dragged onto itself", () => {
		// The dragged id is filtered out of the list before the target is looked
		// up, so a target equal to the dragged id is never found — this falls
		// into the "target missing" branch and the item lands at the end.
		expect(reorderTaskIds(["a", "b", "c"], "b", "b")).toEqual(["a", "c", "b"]);
	});

	it("defaults to 'before' positioning when no position is given", () => {
		expect(reorderTaskIds(["a", "b", "c"], "a", "c")).toEqual(reorderTaskIds(["a", "b", "c"], "a", "c", "before"));
	});
});

describe("sortTasksByOrder", () => {
	it("returns the list untouched when there is no order to apply", () => {
		const tasks = [task({ id: "a" }), task({ id: "b" })];
		expect(sortTasksByOrder(tasks, [])).toBe(tasks);
	});

	it("sorts tasks that appear in the order array by their rank", () => {
		const tasks = [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })];
		expect(sortTasksByOrder(tasks, ["c", "a", "b"]).map((t) => t.id)).toEqual(["c", "a", "b"]);
	});

	it("places tasks absent from the order array after the ranked ones", () => {
		const ranked = task({ id: "ranked", created_at: "2020-01-01T00:00:00.000Z" });
		const unranked = task({ id: "unranked", created_at: "2030-01-01T00:00:00.000Z" });
		const result = sortTasksByOrder([unranked, ranked], ["ranked"]);
		expect(result.map((t) => t.id)).toEqual(["ranked", "unranked"]);
	});

	it("sorts unranked tasks newest-first by created_at", () => {
		const older = task({ id: "older", created_at: "2026-01-01T00:00:00.000Z" });
		const newer = task({ id: "newer", created_at: "2026-06-01T00:00:00.000Z" });
		const result = sortTasksByOrder([older, newer], ["some-other-id"]);
		expect(result.map((t) => t.id)).toEqual(["newer", "older"]);
	});

	it("does not mutate the input array", () => {
		const tasks = [task({ id: "a" }), task({ id: "b" })];
		sortTasksByOrder(tasks, ["b", "a"]);
		expect(tasks.map((t) => t.id)).toEqual(["a", "b"]);
	});
});

describe("normalizeColumns", () => {
	const defaults: TaskColumn[] = [{ status: "todo", label: "To do" }];

	it("dedupes columns by status, keeping the first occurrence", () => {
		const result = normalizeColumns(
			[
				{ status: "todo", label: "To do" },
				{ status: "todo", label: "Duplicate" },
			],
			defaults,
		);
		expect(result).toEqual([{ status: "todo", label: "To do" }]);
	});

	it("trims whitespace from status and label", () => {
		const result = normalizeColumns([{ status: "  in-progress  ", label: "  In Progress  " }], defaults);
		expect(result).toEqual([{ status: "in-progress", label: "In Progress" }]);
	});

	it("drops entries with an empty or blank status", () => {
		const result = normalizeColumns(
			[
				{ status: "", label: "No status" },
				{ status: "   ", label: "Blank status" },
				{ status: "done", label: "Done" },
			],
			defaults,
		);
		expect(result).toEqual([{ status: "done", label: "Done" }]);
	});

	it("falls back to the provided defaults when nothing valid remains", () => {
		expect(normalizeColumns([], defaults)).toEqual(defaults);
		expect(normalizeColumns([{ status: "", label: "Nope" }], defaults)).toEqual(defaults);
	});

	it("returns a copy of the defaults, not the same reference", () => {
		expect(normalizeColumns([], defaults)).not.toBe(defaults);
	});

	it("defaults a blank label to the status value", () => {
		const result = normalizeColumns([{ status: "todo", label: "" }], defaults);
		expect(result).toEqual([{ status: "todo", label: "todo" }]);
	});

	it("defaults a whitespace-only label to the status value", () => {
		const result = normalizeColumns([{ status: "todo", label: "   " }], defaults);
		expect(result).toEqual([{ status: "todo", label: "todo" }]);
	});
});
