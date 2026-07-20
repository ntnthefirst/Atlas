// ---------------------------------------------------------------------------
// Boot smoke test.
//
// Launches the real Electron main process, lets it run, and fails if it dies or
// logs a fatal error. This exists because neither lint nor unit tests can catch
// the characteristic failure of moving code between main-process modules: a
// symbol that is referenced but never required, which only explodes at runtime.
//
// Renderer load failures are expected and ignored — this runs without the vite
// dev server, so there is nothing for the window to load. Only the main process
// is under test.
//
// Usage: npm run smoke
// ---------------------------------------------------------------------------

const { spawn } = require("node:child_process");

// When required from node (rather than from inside Electron), the electron
// package exports the absolute path to its binary — which keeps this working on
// Windows, macOS and Linux without per-platform paths.
const electronBinary = require("electron");

const RUN_MS = Number.parseInt(process.env.SMOKE_MS || "12000", 10);

const FATAL = /ReferenceError|TypeError|is not defined|is not a function|Cannot find module|Uncaught Exception/i;

const child = spawn(electronBinary, ["."], {
	cwd: process.cwd(),
	stdio: ["ignore", "pipe", "pipe"],
	env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

let earlyExit = null;
child.on("exit", (code) => {
	earlyExit = code;
});

child.on("error", (error) => {
	console.error(`Failed to spawn Electron: ${error.message}`);
	process.exit(1);
});

setTimeout(() => {
	const survived = earlyExit === null;
	if (survived) {
		child.kill();
	}

	const fatalLines = output.split("\n").filter((line) => FATAL.test(line));

	console.log(`main process survived ${RUN_MS}ms: ${survived}${survived ? "" : ` (exit code ${earlyExit})`}`);
	console.log(`fatal-looking log lines: ${fatalLines.length}`);

	for (const line of fatalLines.slice(0, 20)) {
		console.log(`  ${line.trim()}`);
	}

	if (!survived && !fatalLines.length) {
		console.log("--- tail of output ---");
		console.log(output.split("\n").slice(-25).join("\n"));
	}

	process.exit(survived && fatalLines.length === 0 ? 0 : 1);
}, RUN_MS);
