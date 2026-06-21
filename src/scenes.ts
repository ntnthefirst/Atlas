import type { NotchTabIcon } from "./types";

// A "scene" is a one-click preset: pressing its notch button fires off a saved
// batch of actions at once (open my work apps + sites, start the timer, drop a
// checklist of tasks into the board, switch environment). It's stored inside a
// placement's single `config` string as JSON so it rides along with the rest
// of the notch preferences without needing its own persistence channel.

export type NotchSceneTask = {
	title: string;
	// Task column status to file the task under; empty means the board's first
	// (default) column.
	column?: string;
};

export type NotchSceneConfig = {
	label: string;
	icon: NotchTabIcon;
	// Launch commands, exactly as `window.atlas.launchApp` expects them (already
	// quoted when the path contains spaces), same format as launchAppButton.
	apps: string[];
	urls: string[];
	// Whether running the scene also starts or stops the time tracker.
	timer: "none" | "start" | "stop";
	// Environment/map id to switch to first; empty means "leave it as is".
	environmentId: string;
	tasks: NotchSceneTask[];
};

export const DEFAULT_SCENE_ICON: NotchTabIcon = "RocketLaunchIcon";

export const createDefaultScene = (): NotchSceneConfig => ({
	label: "New scene",
	icon: DEFAULT_SCENE_ICON,
	apps: [],
	urls: [],
	timer: "none",
	environmentId: "",
	tasks: [],
});

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const asStringList = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

// Parses a placement's config string into a usable scene, falling back to sane
// defaults for anything missing or malformed so a hand-edited or partially
// saved config can never crash the notch.
export function parseSceneConfig(config: string | undefined): NotchSceneConfig {
	const base = createDefaultScene();
	if (!config) return base;
	let raw: unknown;
	try {
		raw = JSON.parse(config);
	} catch {
		return base;
	}
	if (!raw || typeof raw !== "object") return base;
	const value = raw as Record<string, unknown>;
	const timer = value.timer === "start" || value.timer === "stop" ? value.timer : "none";
	const tasks = Array.isArray(value.tasks)
		? value.tasks
				.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
				.map((entry) => ({
					title: asString(entry.title),
					column: asString(entry.column) || undefined,
				}))
				.filter((task) => task.title.trim().length > 0)
		: [];
	return {
		label: asString(value.label) || base.label,
		icon: (asString(value.icon) || base.icon) as NotchTabIcon,
		apps: asStringList(value.apps),
		urls: asStringList(value.urls),
		timer,
		environmentId: asString(value.environmentId),
		tasks,
	};
}

export const serializeSceneConfig = (scene: NotchSceneConfig): string => JSON.stringify(scene);

// True when the scene has at least one action wired up — used to warn in the
// editor and to avoid rendering an inert button.
export const sceneHasActions = (scene: NotchSceneConfig): boolean =>
	scene.apps.some((app) => app.trim()) ||
	scene.urls.some((url) => url.trim()) ||
	scene.tasks.some((task) => task.title.trim()) ||
	scene.timer !== "none" ||
	Boolean(scene.environmentId);
