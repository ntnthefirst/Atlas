import { describe, expect, it } from "vitest";
import { DEFAULT_ACCELERATOR, defaultHotkeyPreferences, normalizeHotkeyPreferences } from "./hotkey-prefs.cjs";

describe("hotkey-prefs.cjs (WP-1.4)", () => {
	it("defaults to Control+Alt+E", () => {
		expect(defaultHotkeyPreferences()).toEqual({ accelerator: DEFAULT_ACCELERATOR });
	});

	it("normalizes a valid stored accelerator through unchanged", () => {
		expect(normalizeHotkeyPreferences({ accelerator: "Control+Shift+Space" })).toEqual({
			accelerator: "Control+Shift+Space",
		});
	});

	it("trims whitespace around a stored accelerator", () => {
		expect(normalizeHotkeyPreferences({ accelerator: "  Control+Alt+M  " })).toEqual({
			accelerator: "Control+Alt+M",
		});
	});

	for (const bad of [null, undefined, {}, { accelerator: "" }, { accelerator: "   " }, { accelerator: 42 }, "garbage", []]) {
		it(`falls back to the default for ${JSON.stringify(bad)}`, () => {
			expect(normalizeHotkeyPreferences(bad)).toEqual({ accelerator: DEFAULT_ACCELERATOR });
		});
	}
});
