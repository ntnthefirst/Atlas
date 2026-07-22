// ---------------------------------------------------------------------------
// Launcher open-latency measurement (WP-2.1).
//
// Boots the real Electron main process -- WITH the Vite dev server running
// alongside it, unlike smoke-boot.cjs/smoke-windows.cjs -- with
// ATLAS_LAUNCHER_SELFCHECK=1, which makes main.cjs simulate the launcher's
// global-hotkey trigger once boot settles (see main.cjs's
// runLauncherSelfCheck()) instead of waiting for a real key press, and wait
// for the renderer's own hotkey -> first-paint measurement to come back over
// launcher:reportOpenLatency (ipc/launcher.cjs).
//
// This needs the dev server, unlike the other two smoke scripts: the
// measurement is only meaningful once a real page actually loads and paints,
// and neither smoke-boot.cjs nor smoke-windows.cjs bother booting one because
// their assertions don't depend on the renderer succeeding.
//
// The number this prints is a DEV-MODE measurement (unminified React, a
// dev-server-served bundle, source maps) -- useful as a regression signal
// for "did the open path get slower / did it stop reporting at all", not as
// a stand-in for a packaged build's real-world latency.
//
// Usage: npm run measure:launcher
// ---------------------------------------------------------------------------

const { spawn } = require("node:child_process");
const path = require("node:path");
const waitOn = require("wait-on");

const electronBinary = require("electron");

const TIMEOUT_MS = Number.parseInt(process.env.MEASURE_LAUNCHER_TIMEOUT_MS || "60000", 10);
const viteBin = path.join(__dirname, "..", "node_modules", "vite", "bin", "vite.js");

async function main() {
	const vite = spawn(process.execPath, [viteBin], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});

	let viteOutput = "";
	vite.stdout.on("data", (chunk) => (viteOutput += chunk.toString()));
	vite.stderr.on("data", (chunk) => (viteOutput += chunk.toString()));

	try {
		await waitOn({ resources: ["tcp:5173"], timeout: TIMEOUT_MS });
	} catch (error) {
		console.error("Vite dev server never came up:", error.message);
		console.log(viteOutput);
		vite.kill();
		process.exit(1);
	}

	const electronProcess = spawn(electronBinary, ["."], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ATLAS_LAUNCHER_SELFCHECK: "1", ELECTRON_ENABLE_LOGGING: "1" },
	});

	let output = "";
	electronProcess.stdout.on("data", (chunk) => (output += chunk.toString()));
	electronProcess.stderr.on("data", (chunk) => (output += chunk.toString()));

	const exitCode = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			console.error(`Launcher self-check did not finish within ${TIMEOUT_MS}ms.`);
			electronProcess.kill();
			resolve(1);
		}, TIMEOUT_MS);

		electronProcess.on("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});

	vite.kill();

	const latencyLine = output.split("\n").find((line) => line.includes("Launcher opened in"));
	if (latencyLine) {
		console.log(latencyLine.trim());
	} else {
		console.log("--- tail of output (no latency line found) ---");
		console.log(output.split("\n").slice(-60).join("\n"));
	}

	process.exit(exitCode === 0 && latencyLine ? 0 : 1);
}

main();
