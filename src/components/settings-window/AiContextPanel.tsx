import { useCallback, useEffect, useState } from "react";
import { TrashIcon } from "@heroicons/react/24/outline";
import { Select } from "../ui";
import { describeIpcError } from "../../utils/ipcError";
import type { AiContext, AiMemory, Environment } from "../../types";

// ---------------------------------------------------------------------------
// WP-4.2's inspection surface: exactly what Atlas would send the AI about one
// environment, and the per-environment memory that feeds it.
//
// The context shown here is built by the SAME main-process function that
// ai:complete and ai:stream use (electron/services/ai/ai-context.cjs), not a
// preview re-implementation. That is the only way "the user can inspect the
// exact context sent" can be true rather than approximately true -- a separate
// preview path would be free to drift from what is really sent, and the whole
// point of this panel is that it cannot.
//
// Everything is environment-scoped, and the environment picker is deliberately
// explicit: there is no "all environments" option anywhere in this panel,
// because there is no such thing as an all-environments context.
// ---------------------------------------------------------------------------

const inputClass =
	"w-full rounded-lg border border-neutral-200 bg-neutral-0 px-2.5 py-1.5 text-[11px] text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-50";

export function AiContextPanel({ environments }: { environments: Environment[] }) {
	const [pickedId, setPickedId] = useState<string>("");
	const [context, setContext] = useState<AiContext | null>(null);
	const [memories, setMemories] = useState<AiMemory[]>([]);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [showRaw, setShowRaw] = useState(false);

	// Derived rather than stored-in-an-effect: the selected environment is
	// whatever the user picked, falling back to the first one. Setting state
	// from an effect to achieve the same thing is what the react-hooks lint
	// rule (rightly) objects to.
	const selectedId = pickedId || (environments[0]?.id ?? "");

	const reload = useCallback(async () => {
		if (!selectedId) {
			return;
		}
		try {
			const [nextContext, nextMemories] = await Promise.all([
				window.atlas.getAiContext(selectedId),
				window.atlas.listAiMemories(selectedId),
			]);
			setContext(nextContext);
			setMemories(nextMemories);
			setError(null);
		} catch (cause) {
			setError(describeIpcError(cause, "Couldn't read the AI context."));
		}
	}, [selectedId]);

	// Resolved through `.then`, matching the shape the rest of this window uses
	// for its boot reads. `reload` itself is for the handlers below, which run
	// outside an effect.
	useEffect(() => {
		if (!selectedId) {
			return;
		}
		Promise.all([window.atlas.getAiContext(selectedId), window.atlas.listAiMemories(selectedId)])
			.then(([nextContext, nextMemories]) => {
				setContext(nextContext);
				setMemories(nextMemories);
			})
			.catch((cause: unknown) => setError(describeIpcError(cause, "Couldn't read the AI context.")));
	}, [selectedId]);

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

	if (environments.length === 0) {
		return (
			<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
				Create an environment first — the AI is only ever given one environment&apos;s information.
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
				When you ask Atlas something, it sends the AI a summary of the environment you&apos;re in — and only that
				environment. This is exactly what would be sent right now, built by the same code that sends it. Nothing
				from any other environment can appear here.
			</p>

			<Select
				label="Environment"
				value={selectedId}
				onChange={setPickedId}
				options={environments.map((environment) => ({
					value: environment.id,
					label: environment.name,
					description: environment.isolation_mode === "enclosed" ? "Enclosed" : undefined,
				}))}
			/>

			{error ? (
				<p className="m-0 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">{error}</p>
			) : null}

			<div className="atlas-settings-card-stack grid gap-2">
				<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
					Things to remember
				</span>
				<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
					Facts you want the assistant to know in this environment. They stay here — no other environment ever sees
					them.
				</p>
				{memories.map((memory) => (
					<div
						key={memory.id}
						className="flex items-center gap-1.5"
					>
						<input
							className={inputClass}
							defaultValue={memory.content}
							onBlur={(event) => {
								if (event.target.value.trim() !== memory.content) {
									void run(() => window.atlas.updateAiMemory(selectedId, memory.id, event.target.value));
								}
							}}
						/>
						<button
							type="button"
							className="action-btn"
							aria-label="Forget this"
							onClick={() => void run(() => window.atlas.deleteAiMemory(selectedId, memory.id))}
						>
							<TrashIcon className="h-3.5 w-3.5" />
						</button>
					</div>
				))}
				<div className="flex items-center gap-1.5">
					<input
						className={inputClass}
						value={draft}
						placeholder="e.g. I use British spelling in this project"
						onChange={(event) => setDraft(event.target.value)}
					/>
					<button
						type="button"
						className="action-btn"
						disabled={!draft.trim()}
						onClick={() => {
							const content = draft;
							setDraft("");
							void run(() => window.atlas.addAiMemory(selectedId, content));
						}}
					>
						Add
					</button>
				</div>
			</div>

			<div className="atlas-settings-card-stack grid gap-2">
				<div className="flex items-center justify-between gap-3">
					<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
						What gets sent
					</span>
					<button
						type="button"
						className="action-btn"
						onClick={() => setShowRaw((current) => !current)}
					>
						{showRaw ? "Show summary" : "Show exact text"}
					</button>
				</div>

				<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
					{context ? `${context.chars} characters` : "…"}
					{context?.truncated ? " · some items were left out to stay within the size limit" : ""}
				</p>

				{showRaw ? (
					<pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-100 p-2.5 text-[11px] text-neutral-700 dark:bg-neutral-700 dark:text-neutral-100">
						{context?.text || "Nothing would be sent for this environment yet."}
					</pre>
				) : (
					<ul className="m-0 grid list-none gap-1 p-0">
						{(context?.sections ?? []).map((section) => (
							<li
								key={section.id}
								className="flex items-center justify-between gap-2 rounded-lg bg-neutral-100 px-2.5 py-1.5 text-[11px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-200"
							>
								<span>{section.title}</span>
								<span className="shrink-0 text-neutral-500 dark:text-neutral-300">
									{section.totalCount === 0
										? "nothing"
										: section.truncated
											? `${section.includedCount} of ${section.totalCount}`
											: `${section.totalCount}`}
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
