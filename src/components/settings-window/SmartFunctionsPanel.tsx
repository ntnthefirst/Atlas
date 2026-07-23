import { useCallback, useEffect, useState } from "react";
import { TrashIcon } from "@heroicons/react/24/outline";
import { Toggle } from "../ui";
import { describeIpcError } from "../../utils/ipcError";
import {
	ACTION_CHOICES,
	CONDITION_CHOICES,
	TRIGGER_CHOICES,
	blankAction,
	blankCondition,
	blankTrigger,
	canSave,
	describeDryRunReason,
	describeGaps,
	draftFromRule,
	draftToInput,
	type SmartFunctionDraft,
} from "./smartFunctionForm";
import type {
	Environment,
	SmartFunction,
	SmartFunctionAction,
	SmartFunctionCondition,
	SmartFunctionDryRun,
} from "../../types";

// ---------------------------------------------------------------------------
// WP-3.2: the Smart Function editor -- create, edit, delete, enable/disable,
// duplicate, with the plain-language preview and the dry-run.
//
// The preview is NOT assembled here. It arrives on every rule as
// `description`, built in the main process by
// electron/services/smart-functions/describe.cjs from the same predicates the
// engine evaluates. That is the only way "the preview matches actual
// behaviour" can be more than a hope -- a copy of the phrasing in the renderer
// could drift from the engine with nothing failing. The cost is that the
// preview for an UNSAVED draft only updates once saved; the dry-run button is
// what answers "what does this actually do" before you commit to it.
//
// Which parts of a draft are incomplete is decided in the pure
// ./smartFunctionForm.ts -- see its header for why the editor names the gaps
// up front instead of letting the engine's normalizer silently drop them.
// ---------------------------------------------------------------------------

const inputClass =
	"w-full rounded-lg border border-neutral-200 bg-neutral-0 px-2.5 py-1.5 text-[11px] text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-50";

const selectClass = inputClass;

function EnvironmentSelect({
	value,
	environments,
	onChange,
	allowAny,
}: {
	value: string | null;
	environments: Environment[];
	onChange: (next: string | null) => void;
	allowAny?: boolean;
}) {
	return (
		<select
			className={selectClass}
			value={value ?? ""}
			onChange={(event) => onChange(event.target.value || null)}
		>
			<option value="">{allowAny ? "Any environment" : "Choose an environment…"}</option>
			{environments.map((environment) => (
				<option
					key={environment.id}
					value={environment.id}
				>
					{environment.name}
				</option>
			))}
		</select>
	);
}

function TriggerFields({
	draft,
	environments,
	onChange,
}: {
	draft: SmartFunctionDraft;
	environments: Environment[];
	onChange: (next: SmartFunctionDraft) => void;
}) {
	const trigger = draft.trigger;
	switch (trigger.type) {
		case "app.launched":
			return (
				<input
					className={inputClass}
					value={trigger.processName ?? ""}
					placeholder="App name, e.g. Figma (leave blank for any app)"
					onChange={(event) =>
						onChange({ ...draft, trigger: { ...trigger, processName: event.target.value || null } })
					}
				/>
			);
		case "environment.switched":
			return (
				<EnvironmentSelect
					allowAny
					value={trigger.environmentId}
					environments={environments}
					onChange={(next) => onChange({ ...draft, trigger: { ...trigger, environmentId: next } })}
				/>
			);
		case "time.of_day":
			return (
				<input
					className={inputClass}
					value={trigger.time}
					placeholder="09:00"
					onChange={(event) => onChange({ ...draft, trigger: { ...trigger, time: event.target.value } })}
				/>
			);
		case "file.changed":
			return (
				<div className="grid gap-1.5 sm:grid-cols-2">
					<input
						className={inputClass}
						value={trigger.pattern ?? ""}
						placeholder="Path contains… e.g. *.psd (blank for any)"
						onChange={(event) =>
							onChange({ ...draft, trigger: { ...trigger, pattern: event.target.value || null } })
						}
					/>
					<select
						className={selectClass}
						value={trigger.kind ?? ""}
						onChange={(event) =>
							onChange({
								...draft,
								trigger: {
									...trigger,
									kind: (event.target.value || null) as typeof trigger.kind,
								},
							})
						}
					>
						<option value="">Created, changed or deleted</option>
						<option value="created">Created</option>
						<option value="modified">Changed</option>
						<option value="removed">Deleted</option>
					</select>
				</div>
			);
		default:
			return null;
	}
}

function ConditionFields({
	condition,
	environments,
	onChange,
}: {
	condition: SmartFunctionCondition;
	environments: Environment[];
	onChange: (next: SmartFunctionCondition) => void;
}) {
	switch (condition.type) {
		case "environment":
			return (
				<EnvironmentSelect
					value={condition.environmentId || null}
					environments={environments}
					onChange={(next) => onChange({ ...condition, environmentId: next ?? "" })}
				/>
			);
		case "time_window":
			return (
				<div className="grid grid-cols-2 gap-1.5">
					<input
						className={inputClass}
						value={condition.start}
						placeholder="09:00"
						onChange={(event) => onChange({ ...condition, start: event.target.value })}
					/>
					<input
						className={inputClass}
						value={condition.end}
						placeholder="17:00"
						onChange={(event) => onChange({ ...condition, end: event.target.value })}
					/>
				</div>
			);
		default:
			return (
				<input
					className={inputClass}
					value={condition.processName}
					placeholder="App name, e.g. Figma"
					onChange={(event) => onChange({ ...condition, processName: event.target.value })}
				/>
			);
	}
}

function ActionFields({
	action,
	environments,
	onChange,
}: {
	action: SmartFunctionAction;
	environments: Environment[];
	onChange: (next: SmartFunctionAction) => void;
}) {
	switch (action.type) {
		case "launchApp":
			return (
				<input
					className={inputClass}
					value={action.command}
					placeholder="App or command to run"
					onChange={(event) => onChange({ ...action, command: event.target.value })}
				/>
			);
		case "openUrl":
			return (
				<input
					className={inputClass}
					value={action.url}
					placeholder="https://…"
					onChange={(event) => onChange({ ...action, url: event.target.value })}
				/>
			);
		case "timer":
			return (
				<select
					className={selectClass}
					value={action.mode}
					onChange={(event) => onChange({ ...action, mode: event.target.value as "start" | "stop" })}
				>
					<option value="start">Start the timer</option>
					<option value="stop">Stop the timer</option>
				</select>
			);
		case "switchEnvironment":
			return (
				<EnvironmentSelect
					value={action.environmentId || null}
					environments={environments}
					onChange={(next) => onChange({ ...action, environmentId: next ?? "" })}
				/>
			);
		default:
			return (
				<div className="grid gap-1.5 sm:grid-cols-2">
					<input
						className={inputClass}
						value={action.title}
						placeholder="Task title"
						onChange={(event) => onChange({ ...action, title: event.target.value })}
					/>
					<input
						className={inputClass}
						value={action.column ?? ""}
						placeholder="Column (optional)"
						onChange={(event) => onChange({ ...action, column: event.target.value || null })}
					/>
				</div>
			);
	}
}

export function SmartFunctionsPanel({ environments }: { environments: Environment[] }) {
	const [rules, setRules] = useState<SmartFunction[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState<SmartFunctionDraft | null>(null);
	const [dryRun, setDryRun] = useState<{ id: string; result: SmartFunctionDryRun } | null>(null);

	const reload = useCallback(async () => {
		try {
			setRules(await window.atlas.listSmartFunctions(null));
			setError(null);
		} catch (cause) {
			setError(describeIpcError(cause, "Couldn't load smart functions."));
		}
	}, []);

	// The initial load resolves state through `.then`, matching the shape the
	// rest of this window uses for its own boot reads -- `reload` itself is for
	// the event handlers below, which run outside an effect.
	useEffect(() => {
		window.atlas
			.listSmartFunctions(null)
			.then(setRules)
			.catch((cause: unknown) => setError(describeIpcError(cause, "Couldn't load smart functions.")));
	}, []);

	const run = useCallback(
		async (action: () => Promise<unknown>) => {
			try {
				await action();
				setError(null);
			} catch (cause) {
				setError(describeIpcError(cause, "That didn't work."));
			}
			await reload();
		},
		[reload],
	);

	const startNew = () => {
		setEditingId("new");
		setDraft(draftFromRule(null));
		setDryRun(null);
	};

	const startEdit = (rule: SmartFunction) => {
		setEditingId(rule.id);
		setDraft(draftFromRule(rule));
		setDryRun(null);
	};

	const closeEditor = () => {
		setEditingId(null);
		setDraft(null);
	};

	const save = async () => {
		if (!draft) {
			return;
		}
		const input = draftToInput(draft);
		await run(async () =>
			editingId === "new"
				? window.atlas.createSmartFunction(input)
				: window.atlas.updateSmartFunction(editingId as string, input),
		);
		closeEditor();
	};

	const gaps = draft ? describeGaps(draft) : [];

	return (
		<div className="flex flex-col gap-4">
			<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
				Smart functions are the rules Atlas runs for you: when something happens, do these things. Each one reads
				back as a sentence — if the sentence is wrong, the rule is wrong. Nothing you build here runs until you turn
				it on.
			</p>

			{error ? (
				<p className="m-0 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">{error}</p>
			) : null}

			{editingId === null ? (
				<button
					type="button"
					className="action-btn self-start"
					onClick={startNew}
				>
					New smart function
				</button>
			) : null}

			{draft ? (
				<div className="atlas-settings-card-stack grid gap-3">
					<input
						className={inputClass}
						value={draft.label}
						placeholder="Name this rule"
						onChange={(event) => setDraft({ ...draft, label: event.target.value })}
					/>

					<div className="grid gap-1.5">
						<span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
							When
						</span>
						<select
							className={selectClass}
							value={draft.trigger.type}
							onChange={(event) =>
								setDraft({
									...draft,
									trigger: blankTrigger(event.target.value as SmartFunctionDraft["trigger"]["type"]),
								})
							}
						>
							{TRIGGER_CHOICES.map((choice) => (
								<option
									key={choice.value}
									value={choice.value}
								>
									{choice.label}
								</option>
							))}
						</select>
						<TriggerFields
							draft={draft}
							environments={environments}
							onChange={setDraft}
						/>
					</div>

					<div className="grid gap-1.5">
						<span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
							Only when
						</span>
						{draft.conditions.map((condition, index) => (
							<div
								key={index}
								className="grid gap-1.5 rounded-lg bg-neutral-100 p-2 dark:bg-neutral-700"
							>
								<div className="flex items-center gap-1.5">
									<select
										className={selectClass}
										value={condition.type}
										onChange={(event) => {
											const next = [...draft.conditions];
											next[index] = blankCondition(event.target.value as SmartFunctionCondition["type"]);
											setDraft({ ...draft, conditions: next });
										}}
									>
										{CONDITION_CHOICES.map((choice) => (
											<option
												key={choice.value}
												value={choice.value}
											>
												{choice.label}
											</option>
										))}
									</select>
									<button
										type="button"
										className="action-btn"
										aria-label="Remove condition"
										onClick={() =>
											setDraft({
												...draft,
												conditions: draft.conditions.filter((_, i) => i !== index),
											})
										}
									>
										<TrashIcon className="h-3.5 w-3.5" />
									</button>
								</div>
								<ConditionFields
									condition={condition}
									environments={environments}
									onChange={(next) => {
										const updated = [...draft.conditions];
										updated[index] = next;
										setDraft({ ...draft, conditions: updated });
									}}
								/>
							</div>
						))}
						<button
							type="button"
							className="action-btn self-start"
							onClick={() =>
								setDraft({ ...draft, conditions: [...draft.conditions, blankCondition("environment")] })
							}
						>
							Add a condition
						</button>
					</div>

					<div className="grid gap-1.5">
						<span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
							Then
						</span>
						{draft.actions.map((action, index) => (
							<div
								key={index}
								className="grid gap-1.5 rounded-lg bg-neutral-100 p-2 dark:bg-neutral-700"
							>
								<div className="flex items-center gap-1.5">
									<select
										className={selectClass}
										value={action.type}
										onChange={(event) => {
											const next = [...draft.actions];
											next[index] = blankAction(event.target.value as SmartFunctionAction["type"]);
											setDraft({ ...draft, actions: next });
										}}
									>
										{ACTION_CHOICES.map((choice) => (
											<option
												key={choice.value}
												value={choice.value}
											>
												{choice.label}
											</option>
										))}
									</select>
									<button
										type="button"
										className="action-btn"
										aria-label="Remove step"
										onClick={() =>
											setDraft({ ...draft, actions: draft.actions.filter((_, i) => i !== index) })
										}
									>
										<TrashIcon className="h-3.5 w-3.5" />
									</button>
								</div>
								<ActionFields
									action={action}
									environments={environments}
									onChange={(next) => {
										const updated = [...draft.actions];
										updated[index] = next;
										setDraft({ ...draft, actions: updated });
									}}
								/>
							</div>
						))}
						<button
							type="button"
							className="action-btn self-start"
							onClick={() => setDraft({ ...draft, actions: [...draft.actions, blankAction("launchApp")] })}
						>
							Add a step
						</button>
					</div>

					<EnvironmentSelect
						allowAny
						value={draft.environmentId}
						environments={environments}
						onChange={(next) => setDraft({ ...draft, environmentId: next })}
					/>

					<Toggle
						label="Turned on"
						description="A rule that's off never fires, and never runs on its own"
						checked={draft.enabled}
						onChange={(value) => setDraft({ ...draft, enabled: value })}
					/>

					{gaps.length > 0 ? (
						<ul className="m-0 grid list-none gap-0.5 p-0 text-[11px] text-amber-600 dark:text-amber-300">
							{gaps.map((gap) => (
								<li key={gap}>{gap}</li>
							))}
						</ul>
					) : null}

					<div className="flex flex-wrap items-center gap-1.5">
						<button
							type="button"
							className="action-btn"
							disabled={!canSave(draft)}
							onClick={() => void save()}
						>
							Save
						</button>
						<button
							type="button"
							className="action-btn"
							onClick={closeEditor}
						>
							Cancel
						</button>
					</div>
				</div>
			) : null}

			<div className="grid gap-2">
				{rules.length === 0 ? (
					<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
						No smart functions yet. Any scenes you already had were brought across automatically.
					</p>
				) : null}

				{rules.map((rule) => (
					<div
						key={rule.id}
						className="atlas-settings-card-stack grid gap-2"
					>
						<div className="flex items-start justify-between gap-3">
							<div className="grid gap-0.5">
								<span className="text-body-small font-medium text-neutral-700 dark:text-neutral-50">
									{rule.label}
								</span>
								{/* The preview, straight from the main process. */}
								<span className="text-[11px] text-neutral-500 dark:text-neutral-300">{rule.description}</span>
							</div>
							<span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-200">
								{rule.enabled ? "On" : "Off"}
							</span>
						</div>

						<div className="flex flex-wrap items-center gap-1.5">
							<button
								type="button"
								className="action-btn"
								onClick={() => startEdit(rule)}
							>
								Edit
							</button>
							<button
								type="button"
								className="action-btn"
								onClick={() => void run(() => window.atlas.setSmartFunctionEnabled(rule.id, !rule.enabled))}
							>
								{rule.enabled ? "Turn off" : "Turn on"}
							</button>
							<button
								type="button"
								className="action-btn"
								title="Make a copy to change, turned off so it can't fire alongside this one"
								onClick={() => void run(() => window.atlas.duplicateSmartFunction(rule.id))}
							>
								Duplicate
							</button>
							<button
								type="button"
								className="action-btn"
								title="Check what this would do right now, without doing any of it"
								onClick={async () => {
									try {
										setDryRun({ id: rule.id, result: await window.atlas.dryRunSmartFunction(rule.id) });
									} catch (cause) {
										setError(describeIpcError(cause, "Couldn't check this rule."));
									}
								}}
							>
								Dry run
							</button>
							<button
								type="button"
								className="action-btn"
								onClick={() => void run(() => window.atlas.deleteSmartFunction(rule.id))}
							>
								<TrashIcon className="h-3.5 w-3.5" />
								<span>Delete</span>
							</button>
						</div>

						{dryRun?.id === rule.id ? (
							<div className="grid gap-1 border-t border-neutral-200 pt-2 dark:border-neutral-600">
								<span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-50">
									{dryRun.result.ok
										? describeDryRunReason(dryRun.result.reason)
										: (dryRun.result.error ?? "Couldn't check this rule.")}
								</span>
								{dryRun.result.ok ? (
									<>
										<span className="text-[11px] text-neutral-500 dark:text-neutral-300">
											Nothing was run — this is only a check.
										</span>
										{dryRun.result.actions && dryRun.result.actions.length > 0 ? (
											<ul className="m-0 grid list-none gap-0.5 p-0 text-[11px] text-neutral-500 dark:text-neutral-300">
												{dryRun.result.actions.map((step, index) => (
													<li key={index}>· would {step}</li>
												))}
											</ul>
										) : (
											<span className="text-[11px] text-neutral-500 dark:text-neutral-300">
												It has no steps, so it would do nothing.
											</span>
										)}
									</>
								) : null}
							</div>
						) : null}
					</div>
				))}
			</div>
		</div>
	);
}
