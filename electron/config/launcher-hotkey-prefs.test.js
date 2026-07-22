import { describe, expect, it } from "vitest";
import {
	DEFAULT_ACCELERATOR,
	defaultLauncherHotkeyPreferences,
	normalizeLauncherHotkeyPreferences,
} from "./launcher-hotkey-prefs.cjs";

describe("launcher-hotkey-prefs.cjs (WP-2.1)", () => {
	it("defaults to Control+Alt+Space", () => {
		expect(defaultLauncherHotkeyPreferences()).toEqual({ accelerator: DEFAULT_ACCELERATOR });
	});

	it("normalizes a valid stored accelerator through unchanged", () => {
		expect(normalizeLauncherHotkeyPreferences({ accelerator: "Control+Shift+K" })).toEqual({
			accelerator: "Control+Shift+K",
		});
	});

	it("trims whitespace around a stored accelerator", () => {
		expect(normalizeLauncherHotkeyPreferences({ accelerator: "  Control+Alt+L  " })).toEqual({
			accelerator: "Control+Alt+L",
		});
	});

	for (const bad of [null, undefined, {}, { accelerator: "" }, { accelerator: "   " }, { accelerator: 42 }, "garbage", []]) {
		it(`falls back to the default for ${JSON.stringify(bad)}`, () => {
			expect(normalizeLauncherHotkeyPreferences(bad)).toEqual({ accelerator: DEFAULT_ACCELERATOR });
		});
	}
});
