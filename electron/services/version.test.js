import { describe, expect, it } from "vitest";
import {
	parseVersion,
	comparePrerelease,
	compareVersionStrings,
	normalizeReleaseEntry,
	pickInstallerAsset,
	normalizeReleaseList,
} from "./version.cjs";

// This suite is ESM (the package is `type: module`) even though the module
// under test is CommonJS — importing version.cjs across that boundary works,
// while the reverse does not: vitest's CJS entrypoint deliberately throws.

describe("parseVersion", () => {
	it("parses a plain major.minor.patch string", () => {
		expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
	});

	it("strips a leading lowercase v", () => {
		expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
	});

	it("strips a leading uppercase V", () => {
		expect(parseVersion("V1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
	});

	it("trims surrounding whitespace", () => {
		expect(parseVersion("  1.2.3  ")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
	});

	it("captures a prerelease suffix", () => {
		expect(parseVersion("1.2.3-beta.1")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "beta.1" });
	});

	it("returns null for an empty string", () => {
		expect(parseVersion("")).toBeNull();
	});

	it("returns null for null", () => {
		expect(parseVersion(null)).toBeNull();
	});

	it("returns null for undefined", () => {
		expect(parseVersion(undefined)).toBeNull();
	});

	it("returns null for non-string input", () => {
		expect(parseVersion(123)).toBeNull();
	});

	it("returns null when the patch segment is missing", () => {
		expect(parseVersion("1.2")).toBeNull();
	});

	it("returns null when there is a fourth numeric segment", () => {
		expect(parseVersion("1.2.3.4")).toBeNull();
	});

	it("returns null for a string with no version shape", () => {
		expect(parseVersion("not-a-version")).toBeNull();
	});

	it("returns null when the prerelease has invalid characters", () => {
		expect(parseVersion("1.2.3-beta_1")).toBeNull();
	});
});

describe("comparePrerelease", () => {
	it("treats two absent prereleases as equal", () => {
		expect(comparePrerelease(null, null)).toBe(0);
	});

	it("ranks an absent prerelease above a present one (the stable release outranks its own prerelease)", () => {
		expect(comparePrerelease(null, "beta.1")).toBe(1);
	});

	it("ranks a present prerelease below an absent one", () => {
		expect(comparePrerelease("beta.1", null)).toBe(-1);
	});

	it("compares numeric identifiers numerically, not lexically", () => {
		// Lexical comparison would say "9" > "10"; numeric comparison must not.
		expect(comparePrerelease("beta.9", "beta.10")).toBe(-1);
		expect(comparePrerelease("beta.10", "beta.9")).toBe(1);
	});

	it("ranks numeric identifiers below alphanumeric ones", () => {
		expect(comparePrerelease("1.1", "1.alpha")).toBe(-1);
		expect(comparePrerelease("1.alpha", "1.1")).toBe(1);
	});

	it("makes a shorter identifier list lose when all shared parts are equal", () => {
		expect(comparePrerelease("beta", "beta.1")).toBe(-1);
		expect(comparePrerelease("beta.1", "beta")).toBe(1);
	});

	it("treats identical prerelease strings as equal", () => {
		expect(comparePrerelease("beta.1", "beta.1")).toBe(0);
	});
});

describe("compareVersionStrings", () => {
	it("orders by major version first", () => {
		expect(compareVersionStrings("2.0.0", "1.9.9")).toBe(1);
		expect(compareVersionStrings("1.9.9", "2.0.0")).toBe(-1);
	});

	it("orders by minor version when major is tied", () => {
		expect(compareVersionStrings("1.2.0", "1.1.9")).toBe(1);
		expect(compareVersionStrings("1.1.9", "1.2.0")).toBe(-1);
	});

	it("orders by patch version when major and minor are tied", () => {
		expect(compareVersionStrings("1.2.3", "1.2.2")).toBe(1);
		expect(compareVersionStrings("1.2.2", "1.2.3")).toBe(-1);
	});

	it("ranks a stable release above its own prerelease", () => {
		expect(compareVersionStrings("1.2.3", "1.2.3-beta.1")).toBe(1);
		expect(compareVersionStrings("1.2.3-beta.1", "1.2.3")).toBe(-1);
	});

	it("returns 0 for two identical versions", () => {
		expect(compareVersionStrings("1.2.3", "1.2.3")).toBe(0);
	});

	// This means garbage input silently compares as "equal" to anything,
	// including other garbage — worth flagging as a footgun for callers that
	// sort or pick a "latest" release without checking parseVersion first.
	it("returns 0 when either side is unparseable, rather than throwing or signalling an error", () => {
		expect(compareVersionStrings("not-a-version", "1.2.3")).toBe(0);
		expect(compareVersionStrings("1.2.3", "not-a-version")).toBe(0);
		expect(compareVersionStrings("garbage", "also-garbage")).toBe(0);
	});
});

describe("normalizeReleaseEntry", () => {
	it("returns null when tag_name is missing", () => {
		expect(normalizeReleaseEntry({})).toBeNull();
	});

	it("returns null when tag_name is blank", () => {
		expect(normalizeReleaseEntry({ tag_name: "   " })).toBeNull();
	});

	it("returns null when tag_name is not a string", () => {
		expect(normalizeReleaseEntry({ tag_name: 123 })).toBeNull();
	});

	it("trims the tag", () => {
		expect(normalizeReleaseEntry({ tag_name: "  v1.2.3  " }).tag).toBe("v1.2.3");
	});

	it("strips the leading v from version but keeps it on tag", () => {
		const entry = normalizeReleaseEntry({ tag_name: "v1.2.3" });
		expect(entry.tag).toBe("v1.2.3");
		expect(entry.version).toBe("1.2.3");
	});

	it("falls back to the tag for name when name is missing", () => {
		expect(normalizeReleaseEntry({ tag_name: "v1.2.3" }).name).toBe("v1.2.3");
	});

	it("falls back to the tag for name when name is blank", () => {
		expect(normalizeReleaseEntry({ tag_name: "v1.2.3", name: "   " }).name).toBe("v1.2.3");
	});

	it("uses the provided name when present", () => {
		expect(normalizeReleaseEntry({ tag_name: "v1.2.3", name: "Release 1.2.3" }).name).toBe("Release 1.2.3");
	});

	it("coerces draft and prerelease to real booleans", () => {
		const entry = normalizeReleaseEntry({ tag_name: "v1.0.0", draft: 1, prerelease: 0 });
		expect(entry.draft).toBe(true);
		expect(entry.prerelease).toBe(false);
	});

	it("defaults missing publishedAt to null", () => {
		expect(normalizeReleaseEntry({ tag_name: "v1.0.0" }).publishedAt).toBeNull();
	});

	it("carries published_at through as publishedAt when present", () => {
		const entry = normalizeReleaseEntry({ tag_name: "v1.0.0", published_at: "2026-01-01T00:00:00Z" });
		expect(entry.publishedAt).toBe("2026-01-01T00:00:00Z");
	});

	it("defaults missing html_url to an empty string", () => {
		expect(normalizeReleaseEntry({ tag_name: "v1.0.0" }).url).toBe("");
	});
});

describe("pickInstallerAsset", () => {
	it("returns null for a null or undefined release", () => {
		expect(pickInstallerAsset(null, "win32")).toBeNull();
		expect(pickInstallerAsset(undefined, "win32")).toBeNull();
	});

	it("returns null when there are no assets at all", () => {
		expect(pickInstallerAsset({}, "win32")).toBeNull();
		expect(pickInstallerAsset({ assets: [] }, "win32")).toBeNull();
	});

	it("filters out assets missing a name or a url", () => {
		const release = {
			assets: [
				{ name: "App.exe" },
				{ browser_download_url: "https://example.com/App.exe" },
			],
		};
		expect(pickInstallerAsset(release, "win32")).toBeNull();
	});

	describe("win32", () => {
		it("picks the .exe asset", () => {
			const release = {
				assets: [
					{ name: "App.dmg", browser_download_url: "https://example.com/App.dmg" },
					{ name: "App.exe", browser_download_url: "https://example.com/App.exe" },
				],
			};
			expect(pickInstallerAsset(release, "win32")).toBe("https://example.com/App.exe");
		});

		it("returns null when there is no .exe", () => {
			const release = { assets: [{ name: "App.dmg", browser_download_url: "https://example.com/App.dmg" }] };
			expect(pickInstallerAsset(release, "win32")).toBeNull();
		});
	});

	describe("darwin", () => {
		it("prefers the .dmg over the .zip", () => {
			const release = {
				assets: [
					{ name: "App.zip", browser_download_url: "https://example.com/App.zip" },
					{ name: "App.dmg", browser_download_url: "https://example.com/App.dmg" },
				],
			};
			expect(pickInstallerAsset(release, "darwin")).toBe("https://example.com/App.dmg");
		});

		it("falls back to the .zip when there is no .dmg", () => {
			const release = { assets: [{ name: "App.zip", browser_download_url: "https://example.com/App.zip" }] };
			expect(pickInstallerAsset(release, "darwin")).toBe("https://example.com/App.zip");
		});

		it("returns null when neither .dmg nor .zip is present", () => {
			const release = { assets: [{ name: "App.deb", browser_download_url: "https://example.com/App.deb" }] };
			expect(pickInstallerAsset(release, "darwin")).toBeNull();
		});
	});

	describe("linux (and any other platform)", () => {
		it("prefers .AppImage over .deb", () => {
			const release = {
				assets: [
					{ name: "App.deb", browser_download_url: "https://example.com/App.deb" },
					{ name: "App.AppImage", browser_download_url: "https://example.com/App.AppImage" },
				],
			};
			expect(pickInstallerAsset(release, "linux")).toBe("https://example.com/App.AppImage");
		});

		it("falls back to .deb when there is no .AppImage", () => {
			const release = { assets: [{ name: "App.deb", browser_download_url: "https://example.com/App.deb" }] };
			expect(pickInstallerAsset(release, "linux")).toBe("https://example.com/App.deb");
		});
	});
});

describe("normalizeReleaseList", () => {
	it("returns an empty array for non-array input", () => {
		expect(normalizeReleaseList(null, false, "win32")).toEqual([]);
		expect(normalizeReleaseList(undefined, false, "win32")).toEqual([]);
		expect(normalizeReleaseList("v1.0.0", false, "win32")).toEqual([]);
	});

	it("always excludes drafts, even with includePrerelease true", () => {
		const releases = [{ tag_name: "v1.0.0", draft: true }];
		expect(normalizeReleaseList(releases, true, "win32")).toEqual([]);
	});

	it("excludes prereleases when includePrerelease is false", () => {
		const releases = [{ tag_name: "v1.0.0-beta.1", prerelease: true }];
		expect(normalizeReleaseList(releases, false, "win32")).toEqual([]);
	});

	it("includes prereleases when includePrerelease is true", () => {
		const releases = [{ tag_name: "v1.0.0-beta.1", prerelease: true }];
		expect(normalizeReleaseList(releases, true, "win32")).toHaveLength(1);
	});

	it("drops entries without a usable tag", () => {
		const releases = [{ tag_name: "" }, { tag_name: null }, {}];
		expect(normalizeReleaseList(releases, true, "win32")).toEqual([]);
	});

	it("attaches an installerUrl to each surviving entry", () => {
		const releases = [
			{
				tag_name: "v1.0.0",
				assets: [{ name: "App.exe", browser_download_url: "https://example.com/App.exe" }],
			},
		];
		const [entry] = normalizeReleaseList(releases, false, "win32");
		expect(entry.tag).toBe("v1.0.0");
		expect(entry.installerUrl).toBe("https://example.com/App.exe");
	});

	it("sets installerUrl to null when no matching asset exists for the platform", () => {
		const releases = [
			{
				tag_name: "v1.0.0",
				assets: [{ name: "App.dmg", browser_download_url: "https://example.com/App.dmg" }],
			},
		];
		const [entry] = normalizeReleaseList(releases, false, "win32");
		expect(entry.installerUrl).toBeNull();
	});

	it("keeps only the non-draft, non-prerelease entries out of a mixed list", () => {
		const releases = [
			{ tag_name: "v1.0.0" },
			{ tag_name: "v1.1.0-beta.1", prerelease: true },
			{ tag_name: "v0.9.0", draft: true },
		];
		expect(normalizeReleaseList(releases, false, "win32").map((r) => r.tag)).toEqual(["v1.0.0"]);
	});
});
