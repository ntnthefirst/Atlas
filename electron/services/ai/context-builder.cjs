"use strict";

// ---------------------------------------------------------------------------
// The AI context builder's PURE half (WP-4.2): given one environment's already
// gathered data, produce the exact text that will be sent, plus a structured
// account of what was included and what was dropped. No db, no clock, no
// Electron -- ./ai-context.cjs does the gathering, this does the deciding.
//
// -- "Bounded and deterministic" is the whole design constraint --------------
// WP-4.2's fourth criterion is that context size is bounded and truncation is
// deterministic. Both words matter, and the second is the harder one: the same
// inputs must always produce byte-identical output. That rules out several
// obvious-looking choices:
//
//   - No "most recent N" that depends on when the build runs. Every list is
//     sorted by an explicit key the caller supplies, and truncation always
//     drops from the END of that order.
//   - No proportional budgets ("give each section a third"), because adding a
//     section would then silently change every other section's contents.
//     Sections are filled in a FIXED priority order until the budget runs out.
//   - No mid-item truncation. An item is included whole or not at all, so the
//     model never sees half a task title and completes it into something the
//     user never wrote. The one exception is a single item longer than the
//     entire budget, which is clipped with an explicit marker rather than
//     silently dropping the section.
//
// -- Priority order is a product decision, written down once ------------------
// Memory first: it is what the user explicitly asked the assistant to know, so
// it should be the last thing to fall out. Then tasks (what they are doing),
// then findings (what Atlas noticed), then notes, then activity (the most
// reconstructible from elsewhere, and the least specific).
//
// -- Isolation is NOT enforced here ------------------------------------------
// This module never sees an environment id or a database, so it cannot enforce
// scoping and does not pretend to: it renders whatever it is handed. The
// guarantee that only one environment's data is ever handed to it lives in
// ./ai-context.cjs, which reads exclusively through electron/data/scoped.cjs.
// A test there proves it; a test here would only prove this file's own fixture.
// ---------------------------------------------------------------------------

/** Section ids, in the fixed order they are filled. See the header. */
const SECTION_ORDER = Object.freeze(["memory", "tasks", "findings", "notes", "activity"]);

const SECTION_TITLES = Object.freeze({
	memory: "Remembered about this environment",
	tasks: "Open tasks",
	findings: "Patterns Atlas has noticed",
	notes: "Recent notes",
	activity: "Recent activity",
});

const DEFAULT_BUDGET = Object.freeze({
	/** Total characters across every section. */
	maxChars: 6000,
	/** Per-section item caps, applied before the global budget. */
	maxItems: Object.freeze({ memory: 50, tasks: 30, findings: 15, notes: 15, activity: 40 }),
	/** A single item longer than this is clipped with a marker. */
	maxItemChars: 500,
});

function normalizeBudget(raw) {
	const base = { maxChars: DEFAULT_BUDGET.maxChars, maxItems: { ...DEFAULT_BUDGET.maxItems }, maxItemChars: DEFAULT_BUDGET.maxItemChars };
	if (!raw || typeof raw !== "object") {
		return base;
	}
	if (Number.isFinite(raw.maxChars) && raw.maxChars > 0) {
		base.maxChars = Math.floor(raw.maxChars);
	}
	if (Number.isFinite(raw.maxItemChars) && raw.maxItemChars > 0) {
		base.maxItemChars = Math.floor(raw.maxItemChars);
	}
	if (raw.maxItems && typeof raw.maxItems === "object") {
		for (const section of SECTION_ORDER) {
			if (Number.isFinite(raw.maxItems[section]) && raw.maxItems[section] >= 0) {
				base.maxItems[section] = Math.floor(raw.maxItems[section]);
			}
		}
	}
	return base;
}

function clipItem(line, maxItemChars) {
	if (line.length <= maxItemChars) {
		return { line, clipped: false };
	}
	// The marker matters: a clipped line that looked complete would be a line
	// the user never wrote, presented to the model as if they had.
	return { line: `${line.slice(0, maxItemChars)}… (truncated)`, clipped: true };
}

/**
 * `sources` is `{ [section]: string[] }` -- each already in the caller's chosen
 * deterministic order. Returns the rendered context plus a full account of what
 * happened to each section.
 */
function buildContext(sources = {}, options = {}) {
	const budget = normalizeBudget(options.budget);
	const header = typeof options.header === "string" ? options.header : "";

	const sections = [];
	// EVERY character that will be rendered is charged here, including the ones
	// that are easy to forget: the section heading, the blank line after each
	// section, and the "(N of M shown)" note. An earlier version charged only
	// the items and overran its own budget by up to a third on small budgets.
	let used = header.length;
	let anyTruncated = false;
	// Once a section has been cut short by the budget, no later section is
	// started. Sections are filled in strict priority order, so a lower-priority
	// one squeezing in past a higher-priority one that was cut would make the
	// result depend on how long each heading happens to be.
	let budgetExhausted = false;

	for (const id of SECTION_ORDER) {
		const all = Array.isArray(sources[id]) ? sources[id].filter((line) => typeof line === "string" && line.trim()) : [];
		const totalCount = all.length;

		if (totalCount === 0) {
			// An empty section is reported (so the inspector can say "nothing
			// here" rather than leaving the user wondering) but contributes no
			// text and costs nothing.
			sections.push({ id, title: SECTION_TITLES[id], lines: [], includedCount: 0, totalCount: 0, truncated: false });
			continue;
		}

		if (budgetExhausted) {
			sections.push({ id, title: SECTION_TITLES[id], lines: [], includedCount: 0, totalCount, truncated: true });
			anyTruncated = true;
			continue;
		}

		const capped = all.slice(0, budget.maxItems[id] ?? 0);
		const cappedByCount = capped.length < totalCount;

		// Reserved up front for every non-empty section, whether or not it ends
		// up truncated. The note's exact length depends on how many items fit,
		// which is not known until after they are added -- reserving the
		// worst case keeps the bound honest at the cost of a few unused
		// characters, which is the right way round.
		const noteAllowance = `  (${totalCount} of ${totalCount} shown)\n`.length;
		const headingCost = `${SECTION_TITLES[id]}:\n`.length;
		const separatorCost = 1; // the blank line after the section

		if (used + headingCost + separatorCost + noteAllowance > budget.maxChars) {
			sections.push({ id, title: SECTION_TITLES[id], lines: [], includedCount: 0, totalCount, truncated: true });
			anyTruncated = true;
			budgetExhausted = true;
			continue;
		}
		used += headingCost + separatorCost + noteAllowance;

		const lines = [];
		let cappedByBudget = false;
		for (const rawLine of capped) {
			const { line, clipped } = clipItem(rawLine.trim(), budget.maxItemChars);
			const cost = `- ${line}\n`.length;
			if (used + cost > budget.maxChars) {
				cappedByBudget = true;
				budgetExhausted = true;
				break;
			}
			used += cost;
			lines.push(line);
			if (clipped) {
				anyTruncated = true;
			}
		}

		const truncated = cappedByCount || cappedByBudget;
		if (truncated) {
			anyTruncated = true;
		}
		sections.push({ id, title: SECTION_TITLES[id], lines, includedCount: lines.length, totalCount, truncated });
	}

	const rendered = [];
	if (header) {
		rendered.push(header);
	}
	for (const section of sections) {
		if (section.lines.length === 0) {
			continue;
		}
		rendered.push(`${section.title}:`);
		for (const line of section.lines) {
			rendered.push(`- ${line}`);
		}
		if (section.truncated) {
			// Told to the MODEL, not just the inspector: a model that knows a
			// list was cut is less likely to reason as though it saw all of it.
			rendered.push(`  (${section.includedCount} of ${section.totalCount} shown)`);
		}
		rendered.push("");
	}

	const text = rendered.join("\n").trimEnd();
	return { text, sections, truncated: anyTruncated, chars: text.length, budget };
}

module.exports = {
	SECTION_ORDER,
	SECTION_TITLES,
	DEFAULT_BUDGET,
	normalizeBudget,
	buildContext,
};
