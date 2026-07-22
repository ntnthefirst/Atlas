import { describe, expect, it } from "vitest";
import platformAdapter, { selectImplementation } from "./index.cjs";

// This suite is ESM (the package is `type: module`) even though the modules
// under test are CommonJS -- same reasoning as the other electron/**/*.test.js
// suites (importing a .cjs works across the boundary; the reverse doesn't).
//
// `selectImplementation` is tested directly with arbitrary platform strings
// rather than by stubbing `process.platform` and reloading the module --
// index.cjs picks its implementation once at require time, so mutating the
// real global wouldn't retroactively change what's already been selected, and
// it would leak into every other test file that happens to run afterwards. A
// pure function sidesteps all of that.
//
// Implementations are told apart by behaviour/shape (`PLATFORM`,
// `isIgnoredProcessName`) rather than by reference-equality against a
// separately-imported module namespace: CJS/ESM interop can hand back a
// synthetic namespace object for `import * as m from "./x.cjs"` that is a
// different object from the one `index.cjs`'s own `require()` sees, even
// though it wraps the same underlying module -- asserting on behaviour avoids
// depending on that plumbing at all.

describe("platform/index.cjs -- selectImplementation() (WP-0.6)", () => {
	it("selects the win32 implementation for 'win32'", () => {
		const impl = selectImplementation("win32");
		expect(impl.PLATFORM).toBe("win32");
	});

	it("selects the unsupported implementation for 'darwin' (D10: no macOS implementation exists)", () => {
		const impl = selectImplementation("darwin");
		expect(impl.PLATFORM).toBe("unsupported");
	});

	it("selects the unsupported implementation for 'linux'", () => {
		const impl = selectImplementation("linux");
		expect(impl.PLATFORM).toBe("unsupported");
	});

	it("selects the unsupported implementation for an unrecognized platform string", () => {
		const impl = selectImplementation("freebsd");
		expect(impl.PLATFORM).toBe("unsupported");
	});

	it("selects the unsupported implementation for undefined/empty input", () => {
		expect(selectImplementation(undefined).PLATFORM).toBe("unsupported");
		expect(selectImplementation("").PLATFORM).toBe("unsupported");
	});

	it("every implementation exposes the same six-method interface plus isIgnoredProcessName", () => {
		for (const platform of ["win32", "darwin"]) {
			const impl = selectImplementation(platform);
			expect(typeof impl.getForegroundWindow).toBe("function");
			expect(typeof impl.listRunningApps).toBe("function");
			expect(typeof impl.listInstalledApps).toBe("function");
			expect(typeof impl.getSystemStats).toBe("function");
			expect(typeof impl.launch).toBe("function");
			// WP-2.4: launchInstalledApp() joins the interface alongside launch().
			expect(typeof impl.launchInstalledApp).toBe("function");
			expect(typeof impl.isIgnoredProcessName).toBe("function");
		}
	});

	it("the win32 and unsupported implementations disagree on a known shell process name (proves they're actually different)", () => {
		expect(selectImplementation("win32").isIgnoredProcessName("powershell")).toBe(true);
		expect(selectImplementation("darwin").isIgnoredProcessName("powershell")).toBe(false);
	});
});

describe("platform/index.cjs -- the live, selected module", () => {
	it("exposes all six interface methods plus the isIgnoredProcessName helper", () => {
		expect(typeof platformAdapter.getForegroundWindow).toBe("function");
		expect(typeof platformAdapter.listRunningApps).toBe("function");
		expect(typeof platformAdapter.listInstalledApps).toBe("function");
		expect(typeof platformAdapter.getSystemStats).toBe("function");
		expect(typeof platformAdapter.launch).toBe("function");
		expect(typeof platformAdapter.launchInstalledApp).toBe("function");
		expect(typeof platformAdapter.isIgnoredProcessName).toBe("function");
	});

	it("reports PLATFORM matching whatever this process actually is", () => {
		// This test suite runs on the dev/CI machine's real process.platform --
		// on Windows that means the real win32 implementation is selected, not
		// a mock, which is the whole point of testing selectImplementation()
		// separately above rather than only ever exercising the live module.
		expect(platformAdapter.PLATFORM).toBe(process.platform === "win32" ? "win32" : "unsupported");
	});
});
