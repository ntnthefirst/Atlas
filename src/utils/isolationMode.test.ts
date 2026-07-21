import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { Environment, IsolationAllowlistEntry } from "../types";
import {
	ENCLOSED_STAYS_ISOLATED_ITEMS,
	buildConnectedSharedItems,
	buildConnectedToEnclosedWarning,
	buildEnclosedToConnectedWarning,
	switchIsolationMode,
} from "./isolationMode";

// Requiring the actual backend policy module (not a hand-copied fixture) is
// the point: this suite must fail the moment WP-1.2's UI-side logic drifts
// from what electron/data/isolation.cjs actually enforces, exactly the
// failure mode the whole WP exists to make impossible.
const require = createRequire(import.meta.url);
const {
	CROSS_ENVIRONMENT_ALLOWLIST,
	describeAllowlist,
} = require("../../electron/data/isolation.cjs") as {
	CROSS_ENVIRONMENT_ALLOWLIST: string[];
	describeAllowlist: () => IsolationAllowlistEntry[];
};

describe("buildConnectedSharedItems -- derived from the allowlist, never hardcoded", () => {
	it("returns exactly one label per real allowlist entry, in order", () => {
		const allowlist = describeAllowlist();
		const items = buildConnectedSharedItems(allowlist);

		expect(allowlist).toHaveLength(CROSS_ENVIRONMENT_ALLOWLIST.length);
		expect(items).toHaveLength(CROSS_ENVIRONMENT_ALLOWLIST.length);
		items.forEach((label) => {
			expect(typeof label).toBe("string");
			expect(label.length).toBeGreaterThan(0);
		});
	});

	it("is a pure pass-through of whatever allowlist it's handed -- proves there is no second, hidden list", () => {
		expect(buildConnectedSharedItems([])).toEqual([]);

		const single: IsolationAllowlistEntry[] = [{ signal: "one_signal", label: "One label." }];
		expect(buildConnectedSharedItems(single)).toEqual(["One label."]);

		const pair: IsolationAllowlistEntry[] = [
			{ signal: "one_signal", label: "One label." },
			{ signal: "two_signal", label: "Two label." },
		];
		expect(buildConnectedSharedItems(pair)).toEqual(["One label.", "Two label."]);
	});

	it("would grow automatically if the real allowlist were ever widened -- no UI-side list to also update", () => {
		const widened = [...describeAllowlist(), { signal: "hypothetical_future_signal", label: "A hypothetical future signal." }];
		expect(buildConnectedSharedItems(widened)).toHaveLength(widened.length);
		expect(buildConnectedSharedItems(widened)).toContain("A hypothetical future signal.");
	});
});

describe("transition copy", () => {
	const allowlist = describeAllowlist();

	it("enclosed -> connected warning names the environment and every shared item", () => {
		const message = buildEnclosedToConnectedWarning("Client Project", allowlist);
		expect(message).toContain("Client Project");
		for (const item of buildConnectedSharedItems(allowlist)) {
			expect(message).toContain(item);
		}
	});

	it("connected -> enclosed warning names the environment and everything that stays isolated", () => {
		const message = buildConnectedToEnclosedWarning("Client Project");
		expect(message).toContain("Client Project");
		for (const item of ENCLOSED_STAYS_ISOLATED_ITEMS) {
			expect(message).toContain(item);
		}
	});
});

describe("switchIsolationMode -- the mode-switch call path", () => {
	const environmentId = "env-1";
	const environmentName = "Client Project";
	const allowlist = describeAllowlist();
	const fakeUpdatedEnvironment: Environment = {
		id: environmentId,
		name: environmentName,
		isolation_mode: "connected",
		created_at: "2026-01-01T00:00:00.000Z",
	};

	it("does nothing (no confirm, no IPC call) when the requested mode equals the current mode", async () => {
		const confirm = vi.fn(() => true);
		const setIsolationMode = vi.fn().mockResolvedValue(fakeUpdatedEnvironment);

		const result = await switchIsolationMode({
			environmentId,
			environmentName,
			currentMode: "connected",
			nextMode: "connected",
			allowlist,
			confirm,
			setIsolationMode,
		});

		expect(result).toBeNull();
		expect(confirm).not.toHaveBeenCalled();
		expect(setIsolationMode).not.toHaveBeenCalled();
	});

	it("asks for confirmation before calling the IPC bridge, and does not call it if the user declines", async () => {
		const confirm = vi.fn(() => false);
		const setIsolationMode = vi.fn().mockResolvedValue(fakeUpdatedEnvironment);

		const result = await switchIsolationMode({
			environmentId,
			environmentName,
			currentMode: "enclosed",
			nextMode: "connected",
			allowlist,
			confirm,
			setIsolationMode,
		});

		expect(result).toBeNull();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(setIsolationMode).not.toHaveBeenCalled();
	});

	it("calls setIsolationMode with the environment id and the new mode once confirmed, and returns its result", async () => {
		const confirm = vi.fn(() => true);
		const setIsolationMode = vi.fn().mockResolvedValue(fakeUpdatedEnvironment);

		const result = await switchIsolationMode({
			environmentId,
			environmentName,
			currentMode: "connected",
			nextMode: "enclosed",
			allowlist,
			confirm,
			setIsolationMode,
		});

		expect(setIsolationMode).toHaveBeenCalledTimes(1);
		expect(setIsolationMode).toHaveBeenCalledWith(environmentId, "enclosed");
		expect(result).toBe(fakeUpdatedEnvironment);
	});

	it("shows the enclosed->connected (widening) warning, not the connected->enclosed one, when widening", async () => {
		let seenMessage = "";
		const confirm = vi.fn((message: string) => {
			seenMessage = message;
			return false;
		});
		const setIsolationMode = vi.fn();

		await switchIsolationMode({
			environmentId,
			environmentName,
			currentMode: "enclosed",
			nextMode: "connected",
			allowlist,
			confirm,
			setIsolationMode,
		});

		expect(seenMessage).toBe(buildEnclosedToConnectedWarning(environmentName, allowlist));
	});

	it("shows the connected->enclosed (quieting) warning when narrowing", async () => {
		let seenMessage = "";
		const confirm = vi.fn((message: string) => {
			seenMessage = message;
			return false;
		});
		const setIsolationMode = vi.fn();

		await switchIsolationMode({
			environmentId,
			environmentName,
			currentMode: "connected",
			nextMode: "enclosed",
			allowlist,
			confirm,
			setIsolationMode,
		});

		expect(seenMessage).toBe(buildConnectedToEnclosedWarning(environmentName));
	});
});
