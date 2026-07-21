import { describe, expect, it } from "vitest";
import { acceleratorFromKeyboardEvent, formatAccelerator } from "./hotkey";

function keyEvent(overrides: Partial<{ key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }>) {
	return {
		key: "",
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		metaKey: false,
		...overrides,
	};
}

describe("acceleratorFromKeyboardEvent (WP-1.4)", () => {
	it("builds Control+Alt+E from ctrl+alt+E", () => {
		expect(acceleratorFromKeyboardEvent(keyEvent({ key: "e", ctrlKey: true, altKey: true }))).toBe("Control+Alt+E");
	});

	it("uppercases a plain letter key", () => {
		expect(acceleratorFromKeyboardEvent(keyEvent({ key: "m", ctrlKey: true }))).toBe("Control+M");
	});

	it("keeps digit keys as-is", () => {
		expect(acceleratorFromKeyboardEvent(keyEvent({ key: "5", ctrlKey: true, shiftKey: true }))).toBe(
			"Control+Shift+5",
		);
	});

	it("supports function keys", () => {
		expect(acceleratorFromKeyboardEvent(keyEvent({ key: "F6", altKey: true }))).toBe("Alt+F6");
	});

	it("maps Space to a named key", () => {
		expect(acceleratorFromKeyboardEvent(keyEvent({ key: " ", ctrlKey: true, altKey: true }))).toBe(
			"Control+Alt+Space",
		);
	});

	it("maps arrow keys to named keys", () => {
		expect(acceleratorFromKeyboardEvent(keyEvent({ key: "ArrowUp", ctrlKey: true }))).toBe("Control+Up");
	});

	it("returns null for a bare modifier press (still waiting for the real key)", () => {
		expect(acceleratorFromKeyboardEvent(keyEvent({ key: "Control", ctrlKey: true }))).toBeNull();
		expect(acceleratorFromKeyboardEvent(keyEvent({ key: "Shift", shiftKey: true }))).toBeNull();
	});

	it("returns null with no modifier held at all, even for a normal letter", () => {
		expect(acceleratorFromKeyboardEvent(keyEvent({ key: "e" }))).toBeNull();
	});

	it("returns null for an unsupported key", () => {
		expect(acceleratorFromKeyboardEvent(keyEvent({ key: "Dead", ctrlKey: true }))).toBeNull();
	});

	it("combines multiple modifiers in a stable order", () => {
		expect(
			acceleratorFromKeyboardEvent(keyEvent({ key: "k", ctrlKey: true, altKey: true, shiftKey: true })),
		).toBe("Control+Alt+Shift+K");
	});
});

describe("formatAccelerator", () => {
	it("renders + as spaced-out plus signs", () => {
		expect(formatAccelerator("Control+Alt+E")).toBe("Control + Alt + E");
	});
});
