import type { ContextStatus, WorkContext } from "../../types";

// ---------------------------------------------------------------------------
// WP-2.8's status wording, kept pure and out of WorkContextCard.tsx so it can
// be tested -- same split as ./findingActions.ts and ./smartFunctionForm.ts.
//
// The order of the branches below is the whole substance of this file, and it
// mirrors context-service.cjs's own precedence exactly: a pin wins over
// detection (`getEffectiveContext()` returns `pinnedContext ?? state.context`,
// and `observe()` won't emit a change while pinned), so saying "currently
// Coding" while something else is pinned would be wrong in the one place a
// user goes to find out what is actually in force.
// ---------------------------------------------------------------------------

export const CONTEXT_LABELS: Record<WorkContext, string> = {
	coding: "Coding",
	communication: "Communication",
	browsing: "Browsing",
};

export const EMPTY_CONTEXT_STATUS: ContextStatus = {
	context: null,
	effectiveContext: null,
	pinnedContext: null,
	isPinned: false,
	candidate: null,
	changedAt: 0,
	polling: false,
};

export function describeContextStatus(status: ContextStatus): string {
	// A pin is absolute -- it overrides detection whether or not detection is
	// even running, so this branch comes before the polling check.
	if (status.isPinned && status.pinnedContext) {
		return `Pinned to ${CONTEXT_LABELS[status.pinnedContext]}. Detection won't change it.`;
	}
	if (!status.polling) {
		return "Detection is off, so no context is being applied.";
	}
	if (status.effectiveContext) {
		const settling = status.candidate ? ` Currently leaning towards ${CONTEXT_LABELS[status.candidate]}.` : "";
		return `Currently ${CONTEXT_LABELS[status.effectiveContext]}.${settling}`;
	}
	// A context only commits once it has held the foreground long enough, so
	// "nothing yet" is a normal state for the first minute rather than a
	// failure, and is worth saying rather than leaving blank.
	return "Watching. A context is only applied once it has held for a while.";
}
