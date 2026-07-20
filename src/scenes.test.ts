import { describe, expect, it } from "vitest";
import { createDefaultScene, parseSceneConfig, sceneHasActions, serializeSceneConfig } from "./scenes";
import type { NotchSceneConfig } from "./scenes";

describe("createDefaultScene", () => {
	it("returns an inert scene with no actions wired up", () => {
		const scene = createDefaultScene();
		expect(scene.label).toBe("New scene");
		expect(scene.icon).toBe("RocketLaunchIcon");
		expect(scene.apps).toEqual([]);
		expect(scene.urls).toEqual([]);
		expect(scene.timer).toBe("none");
		expect(scene.environmentId).toBe("");
		expect(scene.tasks).toEqual([]);
	});
});

describe("parseSceneConfig — defensive fallbacks", () => {
	it("returns the default scene for undefined input", () => {
		expect(parseSceneConfig(undefined)).toEqual(createDefaultScene());
	});

	it("returns the default scene for an empty string", () => {
		expect(parseSceneConfig("")).toEqual(createDefaultScene());
	});

	it("returns the default scene for malformed JSON", () => {
		expect(parseSceneConfig("{not valid json")).toEqual(createDefaultScene());
	});

	it("returns the default scene when the JSON is the literal null", () => {
		expect(parseSceneConfig("null")).toEqual(createDefaultScene());
	});

	it("returns the default scene when the JSON is a bare number", () => {
		expect(parseSceneConfig("42")).toEqual(createDefaultScene());
	});

	it("falls through to defaults when the JSON is an array, since arrays are typeof object", () => {
		// `typeof [] === "object"` so an array slips past the object guard, but
		// none of the expected keys exist on it, so every field falls back.
		expect(parseSceneConfig("[]")).toEqual(createDefaultScene());
	});

	it("returns the default scene for an object missing every field", () => {
		expect(parseSceneConfig("{}")).toEqual(createDefaultScene());
	});

	it("falls back field-by-field when values have the wrong type", () => {
		const raw = JSON.stringify({
			label: 123,
			icon: 456,
			apps: "not-an-array",
			urls: 789,
			timer: "bogus",
			environmentId: 42,
			tasks: "nope",
		});
		expect(parseSceneConfig(raw)).toEqual(createDefaultScene());
	});

	it("falls back to timer 'none' for an invalid timer value", () => {
		const raw = JSON.stringify({ ...createDefaultScene(), timer: "pause" });
		expect(parseSceneConfig(raw).timer).toBe("none");
	});

	it("accepts the valid timer values", () => {
		expect(parseSceneConfig(JSON.stringify({ timer: "start" })).timer).toBe("start");
		expect(parseSceneConfig(JSON.stringify({ timer: "stop" })).timer).toBe("stop");
	});
});

describe("parseSceneConfig — task filtering", () => {
	it("drops tasks that are missing a title or are blank, keeping valid ones", () => {
		const raw = JSON.stringify({
			tasks: [
				{ title: "Valid task" },
				{ title: "" },
				{ title: "   " },
				{},
				{ title: 123 },
				null,
				"just a string",
				{ column: "in-progress" },
				{ title: "Another valid task", column: "in-progress" },
			],
		});
		expect(parseSceneConfig(raw).tasks).toEqual([
			{ title: "Valid task", column: undefined },
			{ title: "Another valid task", column: "in-progress" },
		]);
	});

	it("omits the column when it is missing or blank", () => {
		const raw = JSON.stringify({ tasks: [{ title: "No column here", column: "" }] });
		expect(parseSceneConfig(raw).tasks).toEqual([{ title: "No column here", column: undefined }]);
	});
});

describe("parseSceneConfig — round trip", () => {
	it("preserves every field through serialize then parse", () => {
		const scene: NotchSceneConfig = {
			label: "Deep work",
			icon: "BoltIcon",
			apps: ["\"C:/Program Files/App/app.exe\""],
			urls: ["https://example.com"],
			timer: "start",
			environmentId: "env-work",
			tasks: [
				{ title: "Draft the report", column: "todo" },
				{ title: "Review PRs" },
			],
		};
		const roundTripped = parseSceneConfig(serializeSceneConfig(scene));
		expect(roundTripped).toEqual(scene);
	});
});

describe("sceneHasActions", () => {
	it("is false for a freshly created default scene", () => {
		expect(sceneHasActions(createDefaultScene())).toBe(false);
	});

	it("is true when an app launch command is set", () => {
		expect(sceneHasActions({ ...createDefaultScene(), apps: ["notepad.exe"] })).toBe(true);
	});

	it("is true when a URL is set", () => {
		expect(sceneHasActions({ ...createDefaultScene(), urls: ["https://example.com"] })).toBe(true);
	});

	it("is true when a task with a non-blank title is queued", () => {
		expect(sceneHasActions({ ...createDefaultScene(), tasks: [{ title: "Do the thing" }] })).toBe(true);
	});

	it("is true when the timer is set to start or stop", () => {
		expect(sceneHasActions({ ...createDefaultScene(), timer: "start" })).toBe(true);
		expect(sceneHasActions({ ...createDefaultScene(), timer: "stop" })).toBe(true);
	});

	it("is true when an environment switch is set", () => {
		expect(sceneHasActions({ ...createDefaultScene(), environmentId: "env-work" })).toBe(true);
	});

	it("stays false when apps/urls/tasks only contain blank entries", () => {
		expect(
			sceneHasActions({
				...createDefaultScene(),
				apps: ["  "],
				urls: [""],
				tasks: [{ title: "   " }],
			}),
		).toBe(false);
	});
});
