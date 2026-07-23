import type { Environment, Finding, FindingStatus } from "../../types";

// ---------------------------------------------------------------------------
// The findings management surface's PURE half (WP-3.6) -- which of the seven
// operations are offered for a given finding, and how its state reads in
// words. No React, no `window.atlas`, no clock of its own (`nowMs` is passed
// in), following the same split src/components/launcher/launcherResults.ts
// already established for the launcher: the component renders, this decides.
//
// -- This file is NOT the enforcement, and must never be mistaken for it -----
// Every rule below is duplicated authoritatively in the main process
// (electron/services/pattern-miner/finding-lifecycle.cjs's TRANSITIONS and
// MOVABLE_STATUSES, and electron/data/isolation.cjs#isFindingMoveAllowed).
// This copy exists so the UI can disable a button instead of offering one that
// is certain to fail -- it is a courtesy, and a renderer that got it wrong (or
// was tampered with) would still be refused by the service. In particular
// `moveTargetsFor` filters enclosed environments out of the destination list
// for readability; the actual isolation decision is made in the main process
// from the database's own `isolation_mode` columns, never from the copies the
// renderer happens to be holding.
// ---------------------------------------------------------------------------

export const FINDING_STATUS_LABELS: Record<FindingStatus, string> = {
	new: "New",
	suggested: "Suggested",
	accepted: "Accepted",
	ignored: "Dismissed",
	expired: "Expired",
	paused: "Paused",
};

export type FindingActionAvailability = {
	accept: boolean;
	convert: boolean;
	ignore: boolean;
	pause: boolean;
	unpause: boolean;
	move: boolean;
	edit: boolean;
	remove: boolean;
};

/** Terminal states, mirroring the two rows of TRANSITIONS with no outgoing edge. */
const TERMINAL: FindingStatus[] = ["accepted", "expired"];

/**
 * Mirrors finding-lifecycle-service.cjs#ensureSuggested: a decision (accept /
 * convert / reject) can only be made from a state that can legally reach
 * "suggested" right now. "ignored" is the one that depends on the clock -- it
 * only comes back once its own back-off window has elapsed, which is the whole
 * point of the back-off.
 */
function canDecideNow(finding: Finding, nowMs: number): boolean {
	if (finding.status === "new" || finding.status === "suggested" || finding.status === "paused") {
		return true;
	}
	if (finding.status !== "ignored") {
		return false;
	}
	if (!finding.suppressedUntil) {
		return true;
	}
	const until = Date.parse(finding.suppressedUntil);
	return !Number.isFinite(until) || until <= nowMs;
}

export function availableFindingActions(finding: Finding, nowMs: number): FindingActionAvailability {
	const terminal = TERMINAL.includes(finding.status);
	const decidable = canDecideNow(finding, nowMs);
	return {
		// Both routes to a smart function need the same two things: a legal
		// decision point, and a pattern the engine can actually express as a
		// trigger/action pair (`convertible`, computed in the main process).
		accept: decidable && finding.convertible,
		convert: decidable && finding.convertible,
		ignore: decidable,
		pause: !terminal && finding.status !== "paused",
		unpause: finding.status === "paused",
		move: !terminal,
		// Renaming and discarding a finding say nothing about what it claims
		// happened, so neither is gated on the lifecycle at all.
		edit: true,
		remove: true,
	};
}

/**
 * Destinations the move control offers: every other environment that isn't
 * enclosed, and only when the finding's own environment isn't enclosed either
 * -- the same both-directions rule isFindingMoveAllowed enforces for real.
 */
export function moveTargetsFor(finding: Finding, environments: Environment[]): Environment[] {
	const source = environments.find((environment) => environment.id === finding.environmentId) ?? null;
	if (!source || source.isolation_mode === "enclosed") {
		return [];
	}
	return environments.filter(
		(environment) => environment.id !== finding.environmentId && environment.isolation_mode !== "enclosed",
	);
}

/**
 * A one-line explanation of why a finding is where it is -- the part a bare
 * status badge can't say. Returns null when the badge already tells the whole
 * story.
 */
export function describeFindingState(finding: Finding, nowMs: number): string | null {
	if (finding.status === "paused") {
		return "Held indefinitely. It won't be suggested, and it won't expire, until you resume it.";
	}
	if (finding.status === "accepted") {
		return "Turned into a smart function. Its evidence was cleared as part of accepting it.";
	}
	if (finding.status === "expired") {
		return "Went stale before it was acted on.";
	}
	if (finding.status === "ignored") {
		if (!finding.suppressedUntil) {
			return "Dismissed.";
		}
		const until = Date.parse(finding.suppressedUntil);
		if (Number.isFinite(until) && until > nowMs) {
			return `Dismissed ${finding.ignoreCount} time(s). It won't come back before ${new Date(until).toLocaleDateString()}.`;
		}
		return `Dismissed ${finding.ignoreCount} time(s). Due to be offered again.`;
	}
	return null;
}

/** e.g. 0.8421 -> "84%". */
export function formatConfidence(confidence: number): string {
	if (!Number.isFinite(confidence)) {
		return "—";
	}
	return `${Math.round(confidence * 100)}%`;
}

/** e.g. 7.3241 -> "7.3x more often than chance". */
export function formatLift(lift: number): string {
	if (!Number.isFinite(lift)) {
		return "—";
	}
	return `${lift.toFixed(1)}×`;
}
