import { describe, expect, it } from "vitest";
import { ACCENT_PRESETS, accentVars, DEFAULT_ACCENT, isValidHexColor } from "./accent";

describe("accentVars", () => {
	it("environments the input value straight through to --primary", () => {
		expect(accentVars("#7d53de")["--primary"]).toBe("#7d53de");
	});

	it("derives hover and active shades by mixing toward black", () => {
		const vars = accentVars("#7d53de");
		expect(vars["--primary-hover"]).toBe("color-mix(in srgb, #7d53de, #000 14%)");
		expect(vars["--primary-active"]).toBe("color-mix(in srgb, #7d53de, #000 28%)");
	});

	it("derives soft and subtle shades by mixing toward white", () => {
		const vars = accentVars("#7d53de");
		expect(vars["--primary-soft"]).toBe("color-mix(in srgb, #7d53de, #fff 22%)");
		expect(vars["--primary-subtle"]).toBe("color-mix(in srgb, #7d53de, #fff 88%)");
	});

	it("returns exactly the five expected custom properties", () => {
		expect(Object.keys(accentVars("#000000")).sort()).toEqual(
			["--primary", "--primary-active", "--primary-hover", "--primary-soft", "--primary-subtle"].sort(),
		);
	});

	it("does not validate its input, it just interpolates whatever string it's given", () => {
		// accentVars has no guard: garbage in, garbage embedded in the CSS value out.
		expect(accentVars("not-a-color")["--primary"]).toBe("not-a-color");
	});
});

describe("isValidHexColor", () => {
	it("accepts 6-digit hex colors", () => {
		expect(isValidHexColor("#7d53de")).toBe(true);
	});

	it("accepts 3-digit hex colors", () => {
		expect(isValidHexColor("#abc")).toBe(true);
	});

	it("accepts uppercase and mixed-case hex digits", () => {
		expect(isValidHexColor("#ABCDEF")).toBe(true);
		expect(isValidHexColor("#AbC")).toBe(true);
	});

	it("trims surrounding whitespace before validating", () => {
		expect(isValidHexColor("  #7d53de  ")).toBe(true);
	});

	it("rejects a value with no leading #", () => {
		expect(isValidHexColor("7d53de")).toBe(false);
		expect(isValidHexColor("abc")).toBe(false);
	});

	it("rejects the wrong number of digits", () => {
		expect(isValidHexColor("#12345")).toBe(false);
		expect(isValidHexColor("#1234567")).toBe(false);
		expect(isValidHexColor("#12")).toBe(false);
	});

	it("rejects non-hex characters", () => {
		expect(isValidHexColor("#gggggg")).toBe(false);
	});

	it("rejects non-color strings and empty input", () => {
		expect(isValidHexColor("red")).toBe(false);
		expect(isValidHexColor("")).toBe(false);
	});

	it("rejects whitespace embedded inside the value, not just around it", () => {
		expect(isValidHexColor("#7d 53de")).toBe(false);
	});
});

describe("ACCENT_PRESETS", () => {
	it("contains twelve presets", () => {
		expect(ACCENT_PRESETS.length).toBe(12);
	});

	it("gives every preset a unique id", () => {
		const ids = ACCENT_PRESETS.map((preset) => preset.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("gives every preset a value that is a valid hex color", () => {
		for (const preset of ACCENT_PRESETS) {
			expect(isValidHexColor(preset.value)).toBe(true);
		}
	});

	it("lists purple first, matching the documented default accent", () => {
		expect(ACCENT_PRESETS[0]).toEqual({ id: "purple", name: "Purple", value: DEFAULT_ACCENT });
	});
});
