// ---------------------------------------------------------------------------
// Release version comparison and GitHub release normalization.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. Everything here is
// pure: given the same input it returns the same output, with no window, app or
// filesystem access — which is what makes the update engine's trickiest logic
// (prerelease ordering) testable at all.
//
// `pickInstallerAsset` and `normalizeReleaseList` take the platform as an
// argument, defaulted to the real one, so the asset-picking rules for all three
// platforms can be exercised from any machine.
// ---------------------------------------------------------------------------

// "v1.2.3" / "1.2.3-beta.1" -> { major, minor, patch, prerelease } | null
function parseVersion(rawVersion) {
	if (!rawVersion || typeof rawVersion !== "string") {
		return null;
	}

	const cleaned = rawVersion.trim().replace(/^v/i, "");
	const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
	if (!match) {
		return null;
	}

	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4] || null,
	};
}

// Semver prerelease ordering: absent beats present (1.0.0 > 1.0.0-beta.1),
// numeric identifiers compare numerically and rank below alphanumeric ones, and
// a shorter identifier list loses to a longer one when otherwise equal.
function comparePrerelease(left, right) {
	if (!left && !right) {
		return 0;
	}
	if (!left) {
		return 1;
	}
	if (!right) {
		return -1;
	}

	const leftParts = left.split(".");
	const rightParts = right.split(".");
	const limit = Math.max(leftParts.length, rightParts.length);

	for (let index = 0; index < limit; index += 1) {
		const leftPart = leftParts[index];
		const rightPart = rightParts[index];
		if (leftPart === undefined) {
			return -1;
		}
		if (rightPart === undefined) {
			return 1;
		}

		const leftNumber = /^\d+$/.test(leftPart) ? Number.parseInt(leftPart, 10) : null;
		const rightNumber = /^\d+$/.test(rightPart) ? Number.parseInt(rightPart, 10) : null;

		if (leftNumber !== null && rightNumber !== null) {
			if (leftNumber > rightNumber) {
				return 1;
			}
			if (leftNumber < rightNumber) {
				return -1;
			}
			continue;
		}

		if (leftNumber !== null && rightNumber === null) {
			return -1;
		}
		if (leftNumber === null && rightNumber !== null) {
			return 1;
		}

		if (leftPart > rightPart) {
			return 1;
		}
		if (leftPart < rightPart) {
			return -1;
		}
	}

	return 0;
}

// 1 when left is newer, -1 when right is newer, 0 when equal or unparseable.
function compareVersionStrings(leftVersion, rightVersion) {
	const left = parseVersion(leftVersion);
	const right = parseVersion(rightVersion);
	if (!left || !right) {
		return 0;
	}

	if (left.major !== right.major) {
		return left.major > right.major ? 1 : -1;
	}
	if (left.minor !== right.minor) {
		return left.minor > right.minor ? 1 : -1;
	}
	if (left.patch !== right.patch) {
		return left.patch > right.patch ? 1 : -1;
	}

	return comparePrerelease(left.prerelease, right.prerelease);
}

function normalizeReleaseEntry(entry) {
	const tag = typeof entry?.tag_name === "string" ? entry.tag_name.trim() : "";
	if (!tag) {
		return null;
	}

	return {
		tag,
		version: tag.replace(/^v/i, ""),
		name: typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : tag,
		publishedAt: typeof entry?.published_at === "string" ? entry.published_at : null,
		prerelease: Boolean(entry?.prerelease),
		draft: Boolean(entry?.draft),
		url: typeof entry?.html_url === "string" ? entry.html_url : "",
	};
}

// The installer asset this platform can actually run. macOS prefers the dmg and
// falls back to the zip; Linux prefers AppImage then deb.
function pickInstallerAsset(release, platform = process.platform) {
	const assets = Array.isArray(release?.assets) ? release.assets : [];
	const names = assets
		.map((asset) => ({
			name: typeof asset?.name === "string" ? asset.name : "",
			url: typeof asset?.browser_download_url === "string" ? asset.browser_download_url : "",
		}))
		.filter((asset) => asset.name && asset.url);

	if (!names.length) {
		return null;
	}

	if (platform === "win32") {
		return names.find((asset) => /\.exe$/i.test(asset.name))?.url ?? null;
	}
	if (platform === "darwin") {
		return (
			names.find((asset) => /\.dmg$/i.test(asset.name))?.url ??
			names.find((asset) => /\.zip$/i.test(asset.name))?.url ??
			null
		);
	}

	return (
		names.find((asset) => /\.AppImage$/i.test(asset.name))?.url ??
		names.find((asset) => /\.deb$/i.test(asset.name))?.url ??
		null
	);
}

// Drafts are never offered; prereleases only when the user opted in.
function normalizeReleaseList(releaseList, includePrerelease, platform = process.platform) {
	if (!Array.isArray(releaseList)) {
		return [];
	}

	return releaseList
		.filter((release) => !release?.draft)
		.filter((release) => includePrerelease || !release?.prerelease)
		.map((release) => ({
			...normalizeReleaseEntry(release),
			installerUrl: pickInstallerAsset(release, platform),
		}))
		.filter((release) => Boolean(release?.tag));
}

module.exports = {
	parseVersion,
	comparePrerelease,
	compareVersionStrings,
	normalizeReleaseEntry,
	pickInstallerAsset,
	normalizeReleaseList,
};
