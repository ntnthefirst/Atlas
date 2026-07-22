"use strict";

// ---------------------------------------------------------------------------
// The "actions" provider (WP-2.2) -- yesterday's fixed WP-2.1 stub list,
// reframed as the FIRST real implementer of the provider interface (see
// index.cjs's header for the exact shape). Nothing here newly *does*
// anything: `execute()` still only reports whether the id was known, exactly
// like the WP-2.1 stub did. What changed is that this is now one interchangeable
// provider among however many the registry holds, instead of the launcher's
// only possible source of results -- proof that the interface is real, not
// just documented.
//
// Kept deliberately provider-local ids ("new-task", not "stub-new-task") --
// the registry namespaces every result under this provider's own name
// (`actions::new-task`) before it ever reaches the caller, so a provider
// never has to worry about colliding with another provider's ids.
// ---------------------------------------------------------------------------

const ACTIONS = [
	{ id: "new-task", kind: "action", title: "Create a new task", subtitle: "Quick capture" },
	{ id: "new-note", kind: "action", title: "Create a new note", subtitle: "Quick capture" },
	{ id: "open-settings", kind: "action", title: "Open Settings", subtitle: "Atlas" },
	{ id: "open-dashboard", kind: "action", title: "Open Dashboard", subtitle: "Atlas" },
	{ id: "start-focus", kind: "action", title: "Start a focus session", subtitle: "Focus" },
	{ id: "switch-environment", kind: "action", title: "Switch environment", subtitle: "Atlas" },
	{ id: "toggle-notch", kind: "action", title: "Toggle Smart Notch", subtitle: "Notch" },
	{ id: "open-mini", kind: "action", title: "Open mini player", subtitle: "Atlas" },
];

function matchesText(result, needle) {
	return (
		result.title.toLowerCase().includes(needle) ||
		(result.subtitle ? result.subtitle.toLowerCase().includes(needle) : false)
	);
}

// Synchronous today (filtering a fixed in-memory array needs nothing to
// await); the registry treats every provider's return value as awaitable
// regardless, so a genuinely async provider (WP-2.3: a DB/file-system query)
// slots in without the registry caring which kind it got.
function search(query) {
	const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
	if (!needle) {
		return ACTIONS.slice();
	}
	return ACTIONS.filter((result) => matchesText(result, needle));
}

// `result` is whatever the registry cached for this id (see index.cjs) --
// ordinarily one of the plain objects in ACTIONS above, widened with the
// registry's own `id`/`providerName` stamps, which this provider does not
// need to look at: its own local ids never collide, so re-deriving the
// canonical ACTIONS entry from `result.id` (unprefixed, since the registry
// strips its own provider-name prefix before calling execute()) is enough.
function execute(result) {
	const match = ACTIONS.find((entry) => entry.id === result?.id);
	return {
		ok: Boolean(match),
		title: match?.title ?? null,
	};
}

module.exports = {
	name: "actions",
	search,
	execute,
	ACTIONS,
};
