import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// The IPC contract between the preload bridge and the main process.
//
// This is the gate for WP-0.2's riskiest remaining step: moving ~75 IPC
// handlers out of main.cjs into per-domain modules. Neither smoke test covers
// it — booting the app proves nothing about a handler that is only reached when
// the user clicks something, and a handler lost in the move would surface as a
// silently broken feature much later.
//
// Rather than snapshot a hardcoded channel list (which rots, and which someone
// would eventually "fix" by pasting in the new list), this asserts an invariant
// that maintains itself: every channel the renderer can invoke must be handled
// exactly once. Add a channel and the test keeps passing; lose one in a
// refactor and it fails immediately.
// ---------------------------------------------------------------------------

const electronDir = path.dirname(fileURLToPath(import.meta.url));

function collectSourceFiles(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			found.push(...collectSourceFiles(full));
		} else if (entry.name.endsWith(".cjs")) {
			found.push(full);
		}
	}
	return found;
}

function matchChannels(source, pattern) {
	const names = [];
	for (const match of source.matchAll(pattern)) {
		names.push(match[1]);
	}
	return names;
}

// Every ipcMain.handle / ipcMain.on registration anywhere under electron/.
function registeredChannels() {
	const pattern = /ipcMain\.(?:handle|on)\(\s*"([^"]+)"/g;
	const all = [];
	for (const file of collectSourceFiles(electronDir)) {
		all.push(...matchChannels(fs.readFileSync(file, "utf8"), pattern));
	}
	return all;
}

// Every channel the preload bridge exposes to the renderer.
function bridgedChannels() {
	const source = fs.readFileSync(path.join(electronDir, "preload.cjs"), "utf8");
	return [...new Set(matchChannels(source, /ipcRenderer\.(?:invoke|send)\(\s*"([^"]+)"/g))].sort();
}

describe("IPC contract", () => {
	it("registers a handler for every channel the preload bridge exposes", () => {
		const registered = new Set(registeredChannels());
		const missing = bridgedChannels().filter((channel) => !registered.has(channel));

		// Naming the offenders matters: the failure message is the whole value
		// of this test when it fires during a refactor months from now.
		expect(missing, `preload invokes channels with no main-process handler: ${missing.join(", ")}`).toEqual([]);
	});

	it("never registers the same channel twice", () => {
		const seen = new Map();
		for (const channel of registeredChannels()) {
			seen.set(channel, (seen.get(channel) ?? 0) + 1);
		}

		const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([channel]) => channel);

		// A duplicate means two modules both claim a channel — the second
		// registration wins silently, which is the classic copy-paste outcome
		// when splitting a large handler block.
		expect(duplicates, `channels registered more than once: ${duplicates.join(", ")}`).toEqual([]);
	});

	it("still exposes a substantial bridge, so a gutted preload cannot pass silently", () => {
		// Guards against the degenerate case where preload.cjs is emptied or its
		// call shape changes, which would make the checks above vacuously true.
		expect(bridgedChannels().length).toBeGreaterThan(60);
	});
});
