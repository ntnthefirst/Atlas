export const ACCENT_KEY = "atlas.accent";
export const DEFAULT_ACCENT = "#7d53de";

export type AccentPreset = { id: string; name: string; value: string };

// Curated accent palette. Purple is the default and the historical Atlas accent.
export const ACCENT_PRESETS: AccentPreset[] = [
	{ id: "purple", name: "Purple", value: "#7d53de" },
	{ id: "indigo", name: "Indigo", value: "#5b6cf0" },
	{ id: "blue", name: "Blue", value: "#3b82f6" },
	{ id: "sky", name: "Sky", value: "#0ea5e9" },
	{ id: "teal", name: "Teal", value: "#14b8a6" },
	{ id: "emerald", name: "Emerald", value: "#10b981" },
	{ id: "lime", name: "Lime", value: "#65a30d" },
	{ id: "amber", name: "Amber", value: "#f59e0b" },
	{ id: "orange", name: "Orange", value: "#f97316" },
	{ id: "rose", name: "Rose", value: "#f43f5e" },
	{ id: "pink", name: "Pink", value: "#ec4899" },
	{ id: "slate", name: "Slate", value: "#64748b" },
];

// All accent shades are derived from a single base color via color-mix so that
// presets and custom colors behave identically. Chromium (Electron) supports color-mix.
export const accentVars = (value: string): Record<string, string> => ({
	"--primary": value,
	"--primary-hover": `color-mix(in srgb, ${value}, #000 14%)`,
	"--primary-active": `color-mix(in srgb, ${value}, #000 28%)`,
	"--primary-soft": `color-mix(in srgb, ${value}, #fff 22%)`,
	"--primary-subtle": `color-mix(in srgb, ${value}, #fff 88%)`,
});

export const applyAccent = (value: string, root: HTMLElement = document.documentElement) => {
	const vars = accentVars(value);
	for (const key in vars) {
		root.style.setProperty(key, vars[key]);
	}
};

export const isValidHexColor = (value: string) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());

export const readAccent = (): string => {
	try {
		const stored = localStorage.getItem(ACCENT_KEY);
		return stored && isValidHexColor(stored) ? stored : DEFAULT_ACCENT;
	} catch {
		return DEFAULT_ACCENT;
	}
};

export const writeAccent = (value: string) => {
	try {
		localStorage.setItem(ACCENT_KEY, value);
	} catch {
		// Non-blocking: accent stays applied in-memory even if persistence fails.
	}
};
