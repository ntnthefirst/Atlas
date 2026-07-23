import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, TrashIcon } from "@heroicons/react/24/outline";
import { Select } from "../ui";
import { describeIpcError } from "../../utils/ipcError";
import {
	FINDING_STATUS_LABELS,
	availableFindingActions,
	describeFindingState,
	formatConfidence,
	formatLift,
	moveTargetsFor,
} from "./findingActions";
import type { Environment, Finding, FindingEvidence } from "../../types";

// ---------------------------------------------------------------------------
// WP-3.6: the findings management surface -- the vision's full control panel
// for the patterns Atlas has mined (accept, reject, delete, pause, convert,
// move between environments, edit), plus the drill-down into the events that
// produced each one.
//
// Kept out of SettingsWindowApp.tsx (already 1500 lines) and given its own
// file, the same way NotchTabsEditor is; the parent only decides which tab is
// showing. Every decision about WHICH controls to offer lives in the pure
// ./findingActions.ts -- see that file's header for why the rules are
// duplicated there and enforced in the main process, never only here.
//
// -- No polling ---------------------------------------------------------------
// Findings change when the miner runs (hourly at most) or when the user acts
// on one right here. This surface therefore loads on mount, on environment
// change, and after each action -- never on an interval. The mistake worth not
// repeating is the one WP-3.5 shipped and had to fix: putting a database-
// backed read that changes a few times a day onto a 1.5-second loop.
// ---------------------------------------------------------------------------

type EvidenceState = { loading: boolean; data: FindingEvidence | null };

function formatEventSide(side: FindingEvidence["pairs"][number]["triggerEvent"]): string {
	if (!side) {
		// The event row is genuinely gone -- pruned by the event log's own
		// retention, or its environment was deleted. Saying so is more honest
		// than rendering a blank cell.
		return "No longer recorded";
	}
	const when = new Date(side.ts).toLocaleString();
	return side.subject ? `${side.type} — ${side.subject} (${when})` : `${side.type} (${when})`;
}

function EvidenceList({ state }: { state: EvidenceState }) {
	if (state.loading) {
		return <p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">Looking up the events…</p>;
	}
	const data = state.data;
	if (!data) {
		return null;
	}
	if (data.pairs.length === 0) {
		return (
			<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
				{data.reason === "purged_on_accept"
					? "The supporting events were cleared when this finding was accepted — that clean-up is deliberate, not a gap."
					: data.reason === "not_found"
						? "This finding no longer exists."
						: "No supporting events are stored for this finding. Moving a finding between environments clears them too."}
			</p>
		);
	}
	return (
		<ul className="m-0 grid list-none gap-1 p-0">
			{data.pairs.map((pair, index) => (
				<li
					key={index}
					className="grid gap-0.5 rounded-lg bg-neutral-100 px-2.5 py-1.5 text-[11px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-200"
				>
					<span>{formatEventSide(pair.triggerEvent)}</span>
					<span className="text-neutral-500 dark:text-neutral-300">↳ {formatEventSide(pair.followEvent)}</span>
				</li>
			))}
		</ul>
	);
}

export function FindingsPanel({ environments }: { environments: Environment[] }) {
	const [environmentId, setEnvironmentId] = useState<string>("");
	const [findings, setFindings] = useState<Finding[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [evidence, setEvidence] = useState<Record<string, EvidenceState>>({});
	const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});

	useEffect(() => {
		if (!environmentId && environments.length > 0) {
			setEnvironmentId(environments[0].id);
		}
	}, [environmentId, environments]);

	const reload = useCallback(async () => {
		if (!environmentId) {
			setFindings([]);
			return;
		}
		setLoading(true);
		try {
			const rows = await window.atlas.listFindings(environmentId);
			setFindings(rows);
			setError(null);
		} catch (cause) {
			setError(describeIpcError(cause, "Couldn't load findings."));
		} finally {
			setLoading(false);
		}
	}, [environmentId]);

	useEffect(() => {
		void reload();
	}, [reload]);

	// Every mutating control funnels through here so the "run it, surface the
	// refusal, reload" sequence exists once. A refused action is shown, never
	// swallowed: `ok: false` carries the main process's own explanation (an
	// isolation block, an illegal transition), and that explanation is the
	// point -- silently doing nothing would leave the user guessing.
	const runAction = useCallback(
		async (action: () => Promise<{ ok: boolean; error?: string }>) => {
			try {
				const result = await action();
				setError(result.ok ? null : (result.error ?? "That didn't work."));
			} catch (cause) {
				setError(describeIpcError(cause, "That didn't work."));
			}
			await reload();
		},
		[reload],
	);

	const toggleEvidence = useCallback(async (findingId: string) => {
		let shouldLoad = false;
		setExpandedId((current) => {
			shouldLoad = current !== findingId;
			return current === findingId ? null : findingId;
		});
		if (!shouldLoad) {
			return;
		}
		setEvidence((current) => ({ ...current, [findingId]: { loading: true, data: null } }));
		try {
			const data = await window.atlas.getFindingEvidence(findingId);
			setEvidence((current) => ({ ...current, [findingId]: { loading: false, data } }));
		} catch {
			setEvidence((current) => ({
				...current,
				[findingId]: { loading: false, data: { ok: false, reason: "not_found", pairs: [] } },
			}));
		}
	}, []);

	const nowMs = Date.now();

	const environmentOptions = useMemo(
		() =>
			environments.map((environment) => ({
				value: environment.id,
				label: environment.name,
				description: environment.isolation_mode === "enclosed" ? "Enclosed — findings stay here" : undefined,
			})),
		[environments],
	);

	if (environments.length === 0) {
		return (
			<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
				Create an environment first — findings are always mined from one environment's own activity.
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
				Patterns Atlas has noticed in this environment&apos;s own activity. Nothing here acts on its own — a
				finding only does something once you turn it into a smart function. The numbers are measured, not
				estimated, and can&apos;t be edited; the name can.
			</p>

			<Select
				label="Environment"
				value={environmentId}
				onChange={setEnvironmentId}
				options={environmentOptions}
			/>

			{error ? (
				<p className="m-0 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">{error}</p>
			) : null}

			{loading ? <p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">Loading…</p> : null}

			{!loading && findings.length === 0 ? (
				<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
					Nothing found yet. Atlas needs a while of ordinary use before a pattern is repeated often enough to be
					worth mentioning.
				</p>
			) : null}

			<div className="grid gap-3">
				{findings.map((finding) => {
					const actions = availableFindingActions(finding, nowMs);
					const targets = moveTargetsFor(finding, environments);
					const note = describeFindingState(finding, nowMs);
					const isExpanded = expandedId === finding.id;
					const draft = labelDrafts[finding.id];

					return (
						<div
							key={finding.id}
							className="atlas-settings-card-stack grid gap-2"
						>
							<div className="flex items-start justify-between gap-3">
								<div className="grid gap-1">
									<span className="text-body-small font-medium text-neutral-700 dark:text-neutral-50">
										{finding.description}
									</span>
									<span className="text-[11px] text-neutral-500 dark:text-neutral-300">
										Seen {finding.occurrences} of {finding.trials} times ·{" "}
										{formatConfidence(finding.confidence)} of the time · {formatLift(finding.lift)} more
										often than chance
									</span>
									{note ? (
										<span className="text-[11px] text-neutral-500 dark:text-neutral-300">{note}</span>
									) : null}
									{!finding.convertible ? (
										<span className="text-[11px] text-neutral-500 dark:text-neutral-300">
											Atlas can&apos;t express this pattern as a smart function yet, so it can only be
											dismissed, renamed, moved or deleted.
										</span>
									) : null}
								</div>
								<span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-200">
									{FINDING_STATUS_LABELS[finding.status]}
								</span>
							</div>

							<div className="flex flex-wrap items-center gap-1.5">
								{actions.accept ? (
									<button
										type="button"
										className="action-btn"
										onClick={() => void runAction(() => window.atlas.acceptFinding(finding.id))}
									>
										Accept
									</button>
								) : null}
								{actions.convert ? (
									<button
										type="button"
										className="action-btn"
										title="Create the smart function turned off, so you can check it first"
										onClick={() => void runAction(() => window.atlas.convertFinding(finding.id))}
									>
										Convert (off)
									</button>
								) : null}
								{actions.ignore ? (
									<button
										type="button"
										className="action-btn"
										onClick={() => void runAction(() => window.atlas.dismissFinding(finding.id))}
									>
										Dismiss
									</button>
								) : null}
								{actions.pause ? (
									<button
										type="button"
										className="action-btn"
										title="Stop offering this, without dismissing it — it won't expire while paused"
										onClick={() => void runAction(() => window.atlas.pauseFinding(finding.id))}
									>
										Pause
									</button>
								) : null}
								{actions.unpause ? (
									<button
										type="button"
										className="action-btn"
										onClick={() => void runAction(() => window.atlas.unpauseFinding(finding.id))}
									>
										Resume
									</button>
								) : null}
								<button
									type="button"
									className="action-btn"
									onClick={() => void toggleEvidence(finding.id)}
								>
									{isExpanded ? (
										<ChevronDownIcon className="h-3.5 w-3.5" />
									) : (
										<ChevronRightIcon className="h-3.5 w-3.5" />
									)}
									<span>Evidence</span>
								</button>
								<button
									type="button"
									className="action-btn"
									title="Delete this finding and its evidence. Any smart function it already created is left alone."
									onClick={() => void runAction(() => window.atlas.deleteFinding(finding.id))}
								>
									<TrashIcon className="h-3.5 w-3.5" />
									<span>Delete</span>
								</button>
							</div>

							<div className="flex flex-wrap items-center gap-2">
								<input
									className="min-w-[220px] flex-1 rounded-lg border border-neutral-200 bg-neutral-0 px-2.5 py-1.5 text-[11px] text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-50"
									value={draft ?? finding.label ?? ""}
									placeholder="Rename this finding (optional)"
									onChange={(event) =>
										setLabelDrafts((current) => ({ ...current, [finding.id]: event.target.value }))
									}
									onBlur={() => {
										if (draft === undefined || draft === (finding.label ?? "")) {
											return;
										}
										void runAction(() => window.atlas.setFindingLabel(finding.id, draft));
										setLabelDrafts((current) => {
											const next = { ...current };
											delete next[finding.id];
											return next;
										});
									}}
								/>
								{actions.move && targets.length > 0 ? (
									<select
										className="rounded-lg border border-neutral-200 bg-neutral-0 px-2.5 py-1.5 text-[11px] text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-50"
										value=""
										aria-label="Move to environment"
										onChange={(event) => {
											const target = event.target.value;
											if (target) {
												void runAction(() => window.atlas.moveFinding(finding.id, target));
											}
										}}
									>
										<option value="">Move to…</option>
										{targets.map((environment) => (
											<option
												key={environment.id}
												value={environment.id}
											>
												{environment.name}
											</option>
										))}
									</select>
								) : null}
							</div>

							{isExpanded ? (
								<div className="grid gap-1.5 border-t border-neutral-200 pt-2 dark:border-neutral-600">
									<span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
										What Atlas saw
									</span>
									<EvidenceList state={evidence[finding.id] ?? { loading: true, data: null }} />
								</div>
							) : null}
						</div>
					);
				})}
			</div>
		</div>
	);
}
