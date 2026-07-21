import { describe, expect, it } from "vitest";
import { register } from "./isolation.cjs";
import { CROSS_ENVIRONMENT_ALLOWLIST, describeAllowlist } from "../data/isolation.cjs";

// isolation:getAllowlist (WP-1.2) is a pure forward of isolation.cjs's own
// describeAllowlist() -- this suite exists to pin down that the IPC layer
// adds no re-description of its own, since that re-description is exactly
// the kind of second copy that could drift from CROSS_ENVIRONMENT_ALLOWLIST.

function createFakeIpcMain() {
	const handlers = new Map();
	return {
		handle(channel, fn) {
			handlers.set(channel, fn);
		},
		invoke(channel, ...args) {
			const fn = handlers.get(channel);
			if (!fn) {
				throw new Error(`no handler registered for ${channel}`);
			}
			return fn({}, ...args);
		},
	};
}

describe("isolation:getAllowlist", () => {
	it("returns exactly describeAllowlist()'s output -- no separate description", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain);

		expect(ipcMain.invoke("isolation:getAllowlist")).toEqual(describeAllowlist());
	});

	it("returns one entry per allowlisted signal, each with a non-empty label", () => {
		const ipcMain = createFakeIpcMain();
		register(ipcMain);

		const result = ipcMain.invoke("isolation:getAllowlist");
		expect(result).toHaveLength(CROSS_ENVIRONMENT_ALLOWLIST.length);
		for (const entry of result) {
			expect(CROSS_ENVIRONMENT_ALLOWLIST).toContain(entry.signal);
			expect(typeof entry.label).toBe("string");
			expect(entry.label.length).toBeGreaterThan(0);
		}
	});
});
