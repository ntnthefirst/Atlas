import { describe, expect, it, afterEach } from "vitest";
import { setActiveEnvironmentProvider, getActiveEnvironmentProvider, resolveRequestedProvider } from "./ai.cjs";

// ai.cjs's other exports (loadAiPreferences, getPublicAiConfig, setAiConfig,
// aiComplete) all reach into Electron's safeStorage/app.getPath at call time
// and are only ever exercised by the real app (smoke tests) or from behind a
// running Electron process -- requiring ai.cjs itself is safe under plain
// vitest (nothing touches Electron at import time), but calling those would
// throw here. This suite covers only the WP-1.4 "which AI provider is
// active" precedence logic, which is deliberately pure so it can be tested
// in isolation.

describe("ai.cjs -- active-environment AI provider override (WP-1.4)", () => {
	afterEach(() => {
		setActiveEnvironmentProvider(null);
	});

	it("has no override by default", () => {
		expect(getActiveEnvironmentProvider()).toBeNull();
	});

	it("stores a valid provider", () => {
		expect(setActiveEnvironmentProvider("google")).toBe("google");
		expect(getActiveEnvironmentProvider()).toBe("google");
	});

	it("normalizes an unknown/invalid provider to null rather than a garbage override", () => {
		setActiveEnvironmentProvider("google");
		setActiveEnvironmentProvider("not-a-real-provider");
		expect(getActiveEnvironmentProvider()).toBeNull();
	});

	it("an explicit request always wins over the environment override", () => {
		setActiveEnvironmentProvider("google");
		expect(resolveRequestedProvider("openai")).toBe("openai");
	});

	it("falls back to the environment override with no explicit request", () => {
		setActiveEnvironmentProvider("google");
		expect(resolveRequestedProvider(undefined)).toBe("google");
	});

	it("falls back to the app-wide default with no override and no explicit request", () => {
		setActiveEnvironmentProvider(null);
		expect(resolveRequestedProvider(undefined)).toBe("anthropic");
	});

	// The atomicity guarantee for AI config specifically: switching to an
	// environment with no override of its own must never leave the PREVIOUS
	// environment's provider silently in effect.
	it("switching to an environment with no override never leaves the previous one active", () => {
		setActiveEnvironmentProvider("google");
		expect(resolveRequestedProvider(undefined)).toBe("google");

		setActiveEnvironmentProvider(null); // the next environment has no override of its own
		expect(resolveRequestedProvider(undefined)).toBe("anthropic");
	});
});
