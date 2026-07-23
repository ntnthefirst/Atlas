"use strict";

// ---------------------------------------------------------------------------
// The AI context gatherer (WP-4.2) -- reads ONE environment's data and hands it
// to ./context-builder.cjs to render. This is the module the isolation
// criterion rests on, so the reading discipline is the point of the file.
//
// -- Every read goes through scoped.cjs, or is scoped in its own query --------
// `scoped(db, environmentId)` refuses to exist without an environment id and
// answers every question about that environment only (see electron/data/
// scoped.cjs's own header). Tasks, notes and events come from it. The two
// sources it does not cover -- findings and AI memory -- are read through their
// own stores, both of which take an environment id and scope it in SQL rather
// than filtering afterwards.
//
// There is deliberately no path in this module that reads a table without an
// environment id in the WHERE clause. That is what makes "an enclosed
// environment's data never enters another's context" a structural property
// rather than a review checklist: to leak, someone would have to add a new
// unscoped query, not merely forget a filter.
//
// -- Why enclosure needs no special case here --------------------------------
// isolation.cjs governs CROSS-environment reads. This module never performs
// one: it is handed an environment id and reads exactly that environment. An
// enclosed environment's context is built the same way a connected one's is,
// and neither can contain the other's rows, because neither query can see
// them. Adding an enclosure branch here would imply the connected path was
// allowed to reach wider, which it is not.
//
// Global (environment_id IS NULL) rows are deliberately excluded too --
// smart_functions and files both allow them, and both are left out of context
// entirely. A global row is not another environment's data, but including it
// would make an enclosed environment's prompt depend on something outside
// itself, which is the same shape of surprise the isolation model exists to
// remove.
// ---------------------------------------------------------------------------

const { scoped } = require("../../data/scoped.cjs");
const patternMinerStore = require("../pattern-miner/store.cjs");
const memoryStore = require("./memory-store.cjs");
const { buildFindingRuleLabel } = require("../pattern-miner/finding-translator.cjs");
const { buildContext } = require("./context-builder.cjs");

// Task statuses are free-form column names (`TaskStatus = string`), so "open"
// cannot be an allowlist -- a user's own "review" column would silently vanish
// from context. `done` is the one status this codebase already treats as
// closed (see db.cjs's own `status != 'done'` content count), so it is the one
// thing excluded here.
const CLOSED_TASK_STATUS = "done";

function describeTask(task) {
	const status = task.status ? ` [${task.status}]` : "";
	return `${task.title}${status}`;
}

// A note's `content` is not prose: it is a serialized notebook canvas
// (`NotebookDocument` -- version, viewport, and positioned nodes). Feeding that
// JSON to a model would spend the budget on coordinates and colours and teach
// it nothing, and every environment starts with one empty notebook, so the
// naive version put `{"version":1,"viewport":...}` into every single prompt.
//
// So: parse it, take the text out of the text-bearing nodes in their stored
// order, and ignore the geometry entirely. Anything that does not parse is
// treated as plain text, which covers both a legacy plain-text note and a
// corrupted document without either one throwing.
function describeNote(note) {
	const raw = String(note?.content ?? "");
	if (!raw.trim()) {
		return "";
	}

	let document = null;
	try {
		document = JSON.parse(raw);
	} catch {
		return raw.replace(/\s+/g, " ").trim();
	}
	if (!document || typeof document !== "object" || !Array.isArray(document.nodes)) {
		return raw.replace(/\s+/g, " ").trim();
	}

	const text = document.nodes
		.filter((node) => node && typeof node.text === "string" && node.text.trim())
		.map((node) => node.text.trim())
		.join(" · ");
	// An empty canvas yields "" and is filtered out by the caller, so a brand
	// new environment contributes no notes section at all.
	return text.replace(/\s+/g, " ").trim();
}

function describeFinding(finding) {
	const label = finding.label || buildFindingRuleLabel(finding);
	return `${label} (seen ${finding.occurrences} times)`;
}

function describeEvent(event) {
	const subject = event.subject ? ` ${event.subject}` : "";
	return `${event.ts} ${event.type}${subject}`;
}

/**
 * Gathers one environment's context sources, already in the deterministic order
 * the builder will truncate from. Returns raw string lists, so the rendering
 * decision stays in the pure module.
 */
function gatherSources(db, environmentId, options = {}) {
	const data = scoped(db, environmentId, { eventLog: options.eventLog ?? null });

	// Memory: oldest first (memory-store.cjs's own ordering), so the earliest
	// facts a user set up are the last to be squeezed out.
	const memory = memoryStore.listMemories(db, environmentId).map((entry) => entry.content);

	// Tasks: open ones only, in the order the board returns them. A closed task
	// is rarely what the user is asking about, and including them would spend
	// the budget on history.
	const tasks = data.tasks
		.list()
		.filter((task) => task.status !== CLOSED_TASK_STATUS)
		.map(describeTask);

	// Findings: highest lift first -- the strongest signal is the most worth
	// spending budget on, and lift is a stable stored number, so the order does
	// not change between builds of the same data.
	const findings = patternMinerStore
		.listFindingsForEnvironment(db, environmentId)
		.filter((finding) => finding.status !== "expired")
		.slice()
		.sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0) || String(a.id).localeCompare(String(b.id)))
		.map(describeFinding);

	const notes = data.notes.list().map(describeNote).filter(Boolean);

	// Activity: the event log is already ascending by time; reversed here so the
	// most recent is first and the OLDEST falls out when truncated, which is the
	// opposite of every other section and deliberately so -- old activity is the
	// least useful thing in the whole context.
	const activity = data.events
		.query({ limit: 200 })
		.slice()
		.reverse()
		.map(describeEvent);

	return { memory, tasks, findings, notes, activity };
}

/**
 * The whole thing: gather, render, and report. `environmentName` is used only
 * for the header line, so the model knows which environment it is answering
 * inside.
 */
function buildEnvironmentContext(db, environmentId, options = {}) {
	if (!db || !environmentId) {
		// No environment means no context -- never "all environments".
		return { text: "", sections: [], truncated: false, chars: 0, environmentId: environmentId ?? null };
	}
	const sources = gatherSources(db, environmentId, options);
	const header = options.environmentName
		? `You are helping inside the Atlas environment "${options.environmentName}". Everything below belongs to that environment only.`
		: "";
	const built = buildContext(sources, { budget: options.budget, header });
	return { ...built, environmentId };
}

module.exports = {
	CLOSED_TASK_STATUS,
	describeTask,
	describeNote,
	describeFinding,
	describeEvent,
	gatherSources,
	buildEnvironmentContext,
};
