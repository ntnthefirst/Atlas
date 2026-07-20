// Validates the version a pull request wants to release.
//
// Every PR into main must land a new, higher version in package.json — that
// version is what the release workflow tags and publishes, so this is the gate
// that keeps "merged" and "released" in sync.
//
// Usage: node check-version.mjs <headVersion> <baseVersion> <tagExists>
//   headVersion — package.json version on the PR branch
//   baseVersion — package.json version on main
//   tagExists   — "true" when v<headVersion> is already tagged

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(value) {
	const match = SEMVER.exec(String(value ?? "").trim());
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] || null,
	};
}

// Standard semver precedence: numeric fields first, then prerelease, where a
// release outranks a prerelease and dot-separated identifiers compare
// numerically when both are numeric, otherwise as strings.
export function compareVersions(left, right) {
	for (const field of ["major", "minor", "patch"]) {
		if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
	}
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;

	const leftParts = left.prerelease.split(".");
	const rightParts = right.prerelease.split(".");
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const a = leftParts[index];
		const b = rightParts[index];
		if (a === undefined) return -1;
		if (b === undefined) return 1;
		const numericA = /^\d+$/.test(a) ? Number(a) : null;
		const numericB = /^\d+$/.test(b) ? Number(b) : null;
		if (numericA !== null && numericB !== null) {
			if (numericA !== numericB) return numericA < numericB ? -1 : 1;
			continue;
		}
		if (numericA !== null) return -1;
		if (numericB !== null) return 1;
		if (a !== b) return a < b ? -1 : 1;
	}
	return 0;
}

// Returns { ok, message } so the same logic can be unit-tested without a process exit.
export function checkVersion(headRaw, baseRaw, tagExists) {
	const head = parseVersion(headRaw);
	if (!head) {
		return {
			ok: false,
			message: `"${headRaw}" is not a valid version. Use MAJOR.MINOR.PATCH (optionally -beta.N), e.g. 1.2.0 or 1.2.0-beta.0.`,
		};
	}

	if (tagExists === true || tagExists === "true") {
		return {
			ok: false,
			message: `Version ${headRaw} is already released (tag v${headRaw} exists). Bump the version in package.json.`,
		};
	}

	const base = parseVersion(baseRaw);
	if (!base) {
		// main carrying an unparseable version shouldn't block a PR that is itself valid.
		return { ok: true, message: `Version ${headRaw} is valid. (Could not parse the base version "${baseRaw}".)` };
	}

	if (compareVersions(head, base) <= 0) {
		return {
			ok: false,
			message: `Version ${headRaw} must be higher than ${baseRaw} on main. Bump it, e.g. \`npm version minor --no-git-tag-version\`.`,
		};
	}

	const kind = head.prerelease ? "pre-release" : "release";
	return { ok: true, message: `Version ${baseRaw} -> ${headRaw} (${kind}). Merging will publish v${headRaw}.` };
}

// Only run as a CLI when executed directly, so tests can import the functions.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const [head, base, tagExists] = process.argv.slice(2);
	const result = checkVersion(head, base, tagExists);
	console.log(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
	process.exit(result.ok ? 0 : 1);
}
