import { defineConfig } from "vitest/config";

// Test harness for Atlas (WP-0.1).
//
// Everything runs in a plain node environment: the seeded suites cover pure
// logic (capture parsing, scene config, formatters, session math) and the
// main-process database, none of which need a DOM. Renderer component tests
// will need jsdom — add it as a per-file `@vitest-environment jsdom` docblock
// rather than switching the default, so the fast path stays fast.
export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "electron/**/*.test.js"],
		testTimeout: 15_000,
		// The db suite writes real temp files; keep those serialized per file
		// while still running separate files in parallel.
		fileParallelism: true,
	},
});
