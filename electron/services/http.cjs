// ---------------------------------------------------------------------------
// Minimal JSON-over-HTTPS helper for the update engine.
//
// Extracted from main.cjs (WP-0.2) with no behaviour change. Depends only on
// node:https — no electron, no app state — so it can be required from anywhere
// in the main process.
// ---------------------------------------------------------------------------

const https = require("node:https");

function fetchJson(url) {
	return new Promise((resolve, reject) => {
		const request = https.get(
			url,
			{
				headers: {
					"User-Agent": "Atlas-Version-Check",
					Accept: "application/vnd.github+json",
				},
				timeout: 4000,
			},
			(response) => {
				if (!response || response.statusCode < 200 || response.statusCode >= 300) {
					reject(new Error(`HTTP ${response?.statusCode ?? "unknown"}`));
					return;
				}

				let payload = "";
				response.on("data", (chunk) => {
					payload += chunk;
				});
				response.on("end", () => {
					try {
						resolve(JSON.parse(payload));
					} catch {
						reject(new Error("Invalid JSON response."));
					}
				});
			},
		);

		request.on("timeout", () => {
			request.destroy(new Error("Version check timeout."));
		});
		request.on("error", reject);
	});
}

module.exports = {
	fetchJson,
};
