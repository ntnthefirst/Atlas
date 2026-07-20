import { describe, expect, it } from "vitest";
import { describeIpcError } from "./ipcError";

const FALLBACK = "Could not save.";

describe("describeIpcError", () => {
	it("unwraps a real Electron IPC error", () => {
		const error = new Error(
			"Error invoking remote method 'ai:setConfig': Error: This device cannot encrypt stored secrets, so Atlas will not save them.",
		);
		expect(describeIpcError(error, FALLBACK)).toBe(
			"This device cannot encrypt stored secrets, so Atlas will not save them.",
		);
	});

	it("handles a wrapper carrying a non-generic error type", () => {
		const error = new Error("Error invoking remote method 'x:y': TypeError: something was undefined");
		expect(describeIpcError(error, FALLBACK)).toBe("something was undefined");
	});

	it("passes through a plain error message unchanged", () => {
		expect(describeIpcError(new Error("Disk is full"), FALLBACK)).toBe("Disk is full");
	});

	it("accepts a bare string", () => {
		expect(describeIpcError("Network unreachable", FALLBACK)).toBe("Network unreachable");
	});

	it("falls back when there is no usable message", () => {
		expect(describeIpcError(new Error(""), FALLBACK)).toBe(FALLBACK);
		expect(describeIpcError(new Error("   "), FALLBACK)).toBe(FALLBACK);
		expect(describeIpcError(null, FALLBACK)).toBe(FALLBACK);
		expect(describeIpcError(undefined, FALLBACK)).toBe(FALLBACK);
		expect(describeIpcError({ nope: true }, FALLBACK)).toBe(FALLBACK);
	});

	it("falls back when unwrapping leaves nothing behind", () => {
		expect(describeIpcError(new Error("Error invoking remote method 'a:b': Error: "), FALLBACK)).toBe(FALLBACK);
	});

	it("preserves a multi-sentence message", () => {
		const error = new Error("Error invoking remote method 'a:b': Error: First part. Second part.");
		expect(describeIpcError(error, FALLBACK)).toBe("First part. Second part.");
	});
});
