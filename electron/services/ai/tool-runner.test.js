import { describe, expect, it, vi } from "vitest";
import { MAX_CALLS_PER_RESPONSE, buildToolSpecs, countDroppedCalls, executeToolCalls } from "./tool-runner.cjs";

// ---------------------------------------------------------------------------
// WP-4.3's "tools discovered and invocable through the AI layer". The manager
// is injected, so nothing here connects to anything.
// ---------------------------------------------------------------------------

function fakeManager(behaviour = {}) {
	return {
		listTools: () => behaviour.tools ?? [],
		callTool: vi.fn(async (name, args) => {
			if (behaviour.callTool) {
				return behaviour.callTool(name, args);
			}
			return { ok: true, text: `${name} ran`, isError: false };
		}),
	};
}

describe("buildToolSpecs", () => {
	it("hands every connected tool to the provider in the canonical shape", () => {
		const manager = fakeManager({
			tools: [
				{
					name: "srv__search",
					description: "Finds",
					parameters: { type: "object" },
					serverId: "srv",
					rawName: "search",
				},
			],
		});

		expect(buildToolSpecs(manager)).toEqual([
			{ name: "srv__search", description: "Finds", parameters: { type: "object" } },
		]);
	});

	it("is empty with no manager, rather than throwing", () => {
		expect(buildToolSpecs(null)).toEqual([]);
	});
});

describe("executeToolCalls", () => {
	it("runs each call and returns one result per call", async () => {
		const manager = fakeManager();

		const results = await executeToolCalls(manager, [
			{ id: "1", name: "srv__a", arguments: { x: 1 }, malformedArguments: false },
			{ id: "2", name: "srv__b", arguments: {}, malformedArguments: false },
		]);

		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ id: "1", name: "srv__a", ok: true });
		expect(manager.callTool).toHaveBeenCalledWith("srv__a", { x: 1 });
	});

	// Tools have side effects; a model that creates something and then reads it
	// back expects that order.
	it("runs calls sequentially, in order", async () => {
		const order = [];
		const manager = fakeManager({
			callTool: async (name) => {
				order.push(`start ${name}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
				order.push(`end ${name}`);
				return { ok: true, text: "" };
			},
		});

		await executeToolCalls(manager, [
			{ id: "1", name: "first", arguments: {} },
			{ id: "2", name: "second", arguments: {} },
		]);

		expect(order).toEqual(["start first", "end first", "start second", "end second"]);
	});

	// Calling a tool with arguments the model did not actually mean is worse
	// than not calling it.
	it("refuses a call whose arguments could not be parsed", async () => {
		const manager = fakeManager();

		const results = await executeToolCalls(manager, [
			{ id: "1", name: "srv__a", arguments: {}, malformedArguments: true },
		]);

		expect(manager.callTool).not.toHaveBeenCalled();
		expect(results[0]).toMatchObject({ ok: false, isError: true });
	});

	it("keeps the results of good calls when one fails", async () => {
		const manager = fakeManager({
			callTool: async (name) => (name === "bad" ? { ok: false, error: "no such tool" } : { ok: true, text: "fine" }),
		});

		const results = await executeToolCalls(manager, [
			{ id: "1", name: "good", arguments: {} },
			{ id: "2", name: "bad", arguments: {} },
			{ id: "3", name: "good", arguments: {} },
		]);

		expect(results.map((result) => result.ok)).toEqual([true, false, true]);
		expect(results[1].error).toBe("no such tool");
	});

	// A tool that ran and reported failure is a normal outcome; a call that
	// could not be made at all is not. Both are surfaced, and kept apart.
	it("distinguishes a tool that failed from a call that could not be made", async () => {
		const manager = fakeManager({
			callTool: async () => ({ ok: true, text: "file not found", isError: true }),
		});

		const results = await executeToolCalls(manager, [{ id: "1", name: "srv__read", arguments: {} }]);

		expect(results[0]).toMatchObject({ ok: true, isError: true, text: "file not found", error: null });
	});

	it("bounds how many calls one response can trigger", async () => {
		const manager = fakeManager();
		const many = Array.from({ length: MAX_CALLS_PER_RESPONSE + 10 }, (_, i) => ({
			id: String(i),
			name: "srv__a",
			arguments: {},
		}));

		const results = await executeToolCalls(manager, many);

		expect(results).toHaveLength(MAX_CALLS_PER_RESPONSE);
		expect(countDroppedCalls(many)).toBe(10);
	});

	it("reports rather than throws when there is no manager at all", async () => {
		const results = await executeToolCalls(null, [{ id: "1", name: "srv__a", arguments: {} }]);
		expect(results[0]).toMatchObject({ ok: false, isError: true });
	});

	it("never throws on garbage", async () => {
		const manager = fakeManager();
		expect(await executeToolCalls(manager, null)).toEqual([]);
		expect(await executeToolCalls(manager, [null, 42, { id: "x" }])).toEqual([]);
	});
});
