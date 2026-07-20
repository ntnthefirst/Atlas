// ---------------------------------------------------------------------------
// Secret vault verification (WP-0.4).
//
// Runs INSIDE Electron, because safeStorage does not exist in plain node and so
// the vault cannot be covered by the normal vitest suite. This proves the three
// things the vault actually promises:
//
//   1. values round-trip through the OS keystore,
//   2. plaintext never reaches disk,
//   3. a legacy plaintext ai-preferences.json migrates and is then stripped.
//
// Everything runs against a throwaway userData directory, so the real profile
// is never read or modified.
//
// Usage: npm run verify:secrets
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const repoRoot = path.resolve(__dirname, "..");
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-vault-verify-"));
app.setPath("userData", tempUserData);

let failures = 0;

function check(label, condition, detail = "") {
	if (condition) {
		console.log(`  PASS  ${label}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
}

app.whenReady().then(() => {
	const secrets = require(path.join(repoRoot, "electron/services/secrets.cjs"));

	console.log("\n--- vault basics ---");
	check("encryption is available on this device", secrets.isAvailable());

	const SECRET = "sk-ant-super-secret-value-12345";
	secrets.set("test.key", SECRET);

	check("has() reports the stored key", secrets.has("test.key"));
	check("get() round-trips the exact value", secrets.get("test.key") === SECRET);

	const onDisk = fs.readFileSync(path.join(tempUserData, "secrets.json"), "utf8");
	check("plaintext is ABSENT from secrets.json", !onDisk.includes(SECRET), "secret leaked to disk");
	check("file contains ciphertext", onDisk.includes("test.key") && onDisk.length > 40);

	secrets.remove("test.key");
	check("remove() clears the entry", !secrets.has("test.key"));

	secrets.set("test.empty", "");
	check("setting an empty value stores nothing", !secrets.has("test.empty"));
	check("get() on a missing key returns empty string", secrets.get("nope") === "");

	console.log("\n--- legacy plaintext migration ---");
	const legacyKey = "sk-legacy-plaintext-key-98765";
	const prefsPath = path.join(tempUserData, "ai-preferences.json");
	fs.writeFileSync(
		prefsPath,
		JSON.stringify({
			defaultProvider: "openai",
			providers: {
				anthropic: { apiKey: legacyKey, model: "claude-sonnet-5" },
				google: { apiKey: "", model: "gemini-1.5-flash" },
				openai: { apiKey: "", model: "gpt-4o-mini" },
			},
		}),
		"utf8",
	);

	secrets.resetCache();
	const ai = require(path.join(repoRoot, "electron/ai.cjs"));
	ai.loadAiPreferences();

	const config = ai.getPublicAiConfig();
	check("migrated provider reports hasKey", config.providers.anthropic.hasKey === true);
	check("provider without a key reports hasKey false", config.providers.google.hasKey === false);
	check("model choice survived migration", config.providers.anthropic.model === "claude-sonnet-5");
	check("defaultProvider survived migration", config.defaultProvider === "openai");

	const rewritten = fs.readFileSync(prefsPath, "utf8");
	check("plaintext key REMOVED from ai-preferences.json", !rewritten.includes(legacyKey), "key still on disk");
	check("apiKey field gone from the file entirely", !rewritten.includes("apiKey"));

	const vaultOnDisk = fs.readFileSync(path.join(tempUserData, "secrets.json"), "utf8");
	check("migrated key is NOT plaintext in the vault", !vaultOnDisk.includes(legacyKey));
	check("migrated key is retrievable", secrets.get("ai.anthropic.apiKey") === legacyKey);

	ai.loadAiPreferences();
	check("a second load keeps the key", ai.getPublicAiConfig().providers.anthropic.hasKey === true);

	console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);

	fs.rmSync(tempUserData, { recursive: true, force: true });
	app.exit(failures === 0 ? 0 : 1);
});
