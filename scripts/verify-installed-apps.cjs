// ---------------------------------------------------------------------------
// Installed-app enumeration verification (WP-2.4).
//
// Runs INSIDE Electron (app.getFileIcon, used for the icon-extraction check
// below, doesn't exist outside it) against the REAL platform adapter
// (electron/platform/index.cjs -> win32.cjs) on whatever machine this runs
// on -- proof the Get-StartApps + registry-uninstall-keys enumeration
// actually finds real, launchable apps, and that at least a few of them
// resolve to a real icon, beyond what the unit suite's fixture-driven tests
// (electron/platform/win32.test.js, electron/services/launcher-providers/
// apps-provider.test.js) can prove on their own.
//
// Usage: npm run verify:installed-apps
// ---------------------------------------------------------------------------

const { app } = require("electron");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

app.whenReady().then(async () => {
	const platform = require(path.join(repoRoot, "electron/platform/index.cjs"));

	console.log(`Platform adapter reports: ${platform.PLATFORM}`);

	const start = Date.now();
	const result = await platform.listInstalledApps();
	const elapsedMs = Date.now() - start;

	console.log(`listInstalledApps() supported=${result.supported}, took ${elapsedMs}ms`);
	console.log(`Total apps found: ${result.apps.length}`);

	const classicCount = result.apps.filter((a) => a.kind === "classic").length;
	const uwpCount = result.apps.filter((a) => a.kind === "uwp").length;
	console.log(`  classic: ${classicCount}, uwp: ${uwpCount}`);

	const samples = result.apps.slice(0, 3);
	console.log(`\nFirst ${samples.length} sample(s) (alphabetical):`);
	for (const sampleApp of samples) {
		let iconInfo = "n/a (no filesystem path -- uwp app)";
		if (sampleApp.path) {
			try {
				const icon = await app.getFileIcon(sampleApp.path, { size: "normal" });
				iconInfo = icon.isEmpty() ? "empty icon" : `icon extracted (${icon.toDataURL().length} char data URL)`;
			} catch (error) {
				iconInfo = `icon extraction failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		console.log(`  - "${sampleApp.name}" [${sampleApp.kind}] appId=${sampleApp.appId}`);
		console.log(`      icon: ${iconInfo}`);
	}

	// A few well-known, near-universally-present Windows apps/features --
	// finding at least some of these is a cheap sanity signal that the
	// "large majority" acceptance criterion is plausible, not proof on its
	// own (a fresh VM may lack some of these too).
	const expectedNames = ["calculator", "notepad", "file explorer", "settings", "paint", "photos"];
	const foundExpected = expectedNames.filter((expected) =>
		result.apps.some((a) => a.name.toLowerCase().includes(expected)),
	);
	console.log(`\nWell-known Windows apps found (${foundExpected.length}/${expectedNames.length}): ${foundExpected.join(", ") || "none"}`);

	app.exit(result.apps.length > 0 ? 0 : 1);
});
