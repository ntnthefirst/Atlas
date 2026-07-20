// ---------------------------------------------------------------------------
// Window layer smoke test.
//
// Boots Atlas with ATLAS_WINDOW_SELFCHECK=1, which makes the main process open
// every window type once, report each one, and exit. See runWindowSelfCheck in
// electron/main.cjs.
//
// This covers what neither the unit suite nor `npm run smoke` can: vitest
// cannot construct a BrowserWindow, and a plain boot only proves the first
// window opened. Windows created on demand — settings, mini, action editor,
// notch input — would otherwise stay unverified until a user clicked them.
//
// The env var is set here rather than inline in the npm script because
// `VAR=x cmd` is not portable to Windows, and this keeps it dependency-free.
//
// Usage: npm run smoke:windows
// ---------------------------------------------------------------------------

const { spawn } = require("node:child_process");

const electronBinary = require("electron");

const TIMEOUT_MS = Number.parseInt(process.env.SMOKE_WINDOWS_TIMEOUT_MS || "45000", 10);

const child = spawn(electronBinary, ["."], {
	cwd: process.cwd(),
	stdio: ["ignore", "pipe", "pipe"],
	env: { ...process.env, ATLAS_WINDOW_SELFCHECK: "1", ELECTRON_ENABLE_LOGGING: "1" },
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

child.on("error", (error) => {
	console.error(`Failed to spawn Electron: ${error.message}`);
	process.exit(1);
});

// If the self-check never reports, the app hung before finishing startup —
// itself a failure worth surfacing rather than waiting forever.
const timer = setTimeout(() => {
	console.error(`Window self-check did not finish within ${TIMEOUT_MS}ms.`);
	child.kill();
	printRelevant();
	process.exit(1);
}, TIMEOUT_MS);

function printRelevant() {
	for (const line of output.split("\n")) {
		if (/PASS|FAIL|ALL WINDOWS OPENED|WINDOW\(S\) FAILED|Error|error/.test(line)) {
			console.log(line.trimEnd());
		}
	}
}

child.on("exit", (code) => {
	clearTimeout(timer);
	printRelevant();

	if (code === 0 && output.includes("ALL WINDOWS OPENED")) {
		process.exit(0);
	}

	console.error(`\nWindow self-check failed (exit code ${code}).`);
	process.exit(1);
});
