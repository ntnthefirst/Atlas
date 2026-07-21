// ---------------------------------------------------------------------------
// The shared delete confirmation dialog (WP-1.5, step 2 -- "THIS IS THE PART
// THAT MATTERS MOST"). A bare `window.confirm("Are you sure?")` cannot say
// what is actually about to be destroyed, so this fetches the real,
// per-category counts (electron/db.cjs#getEnvironmentContentCounts) and
// shows them instead of generic wording.
//
// One component, two call sites: the header's quick environment switcher
// (AtlasEnvironmentMenu, via App.tsx's onRequestDeleteEnvironment) and the
// full lifecycle surface in Settings (EnvironmentManagementCard). Both just
// hand this component an `Environment` row and three callbacks -- neither
// duplicates the counts-fetching or confirmation logic itself.
//
// Confirmation is proportional to the loss: an environment holding any
// tasks or sessions at all requires typing its name before the destructive
// button enables, exactly as the WP asks for. An environment with neither
// (freshly created, never used) can be deleted with a single click -- typing
// a name to confirm deleting nothing would be theatre, not safety.
//
// "Archive instead" sits in the same dialog, not a separate flow, because
// archiving is almost always what someone actually wants: same "get this out
// of my way" outcome, none of the loss.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Environment, EnvironmentContentCounts } from "../types";

type EnvironmentDeleteDialogProps = {
	environment: Environment | null;
	onCancel: () => void;
	onConfirmDelete: (environmentId: string) => Promise<void>;
	onArchiveInstead: (environmentId: string) => Promise<void>;
};

const COUNT_CATEGORIES: Array<{
	key: "tasks" | "sessions" | "notes" | "activityBlocks" | "events";
	singular: string;
	plural: string;
}> = [
	{ key: "tasks", singular: "task", plural: "tasks" },
	{ key: "sessions", singular: "session", plural: "sessions" },
	{ key: "notes", singular: "note", plural: "notes" },
	{ key: "activityBlocks", singular: "activity block", plural: "activity blocks" },
	{ key: "events", singular: "logged event", plural: "logged events" },
];

function describeCounts(counts: EnvironmentContentCounts): string[] {
	return COUNT_CATEGORIES.filter((category) => counts[category.key] > 0).map((category) => {
		const value = counts[category.key];
		return `${value} ${value === 1 ? category.singular : category.plural}`;
	});
}

export function EnvironmentDeleteDialog({
	environment,
	onCancel,
	onConfirmDelete,
	onArchiveInstead,
}: EnvironmentDeleteDialogProps) {
	const [counts, setCounts] = useState<EnvironmentContentCounts | null>(null);
	const [isLoadingCounts, setIsLoadingCounts] = useState(false);
	const [typedName, setTypedName] = useState("");
	const [busyAction, setBusyAction] = useState<"delete" | "archive" | null>(null);
	const [error, setError] = useState("");

	const environmentId = environment?.id ?? null;

	// Resets every per-open field the moment a NEW environment id comes in --
	// done here, during render (the React-docs "adjusting state when a prop
	// changes" pattern: https://react.dev/learn/you-might-not-need-an-effect),
	// rather than as synchronous setState calls at the top of an effect. The
	// effect below is left to do only the one thing an effect is actually for:
	// talking to an external system (the IPC round trip), with every setState
	// it makes happening inside that async chain's own callbacks.
	const [lastSeenEnvironmentId, setLastSeenEnvironmentId] = useState<string | null>(null);
	if (environmentId !== lastSeenEnvironmentId) {
		setLastSeenEnvironmentId(environmentId);
		setCounts(null);
		setTypedName("");
		setError("");
		setIsLoadingCounts(Boolean(environmentId));
	}

	useEffect(() => {
		if (!environmentId) {
			return;
		}
		let cancelled = false;
		void window.atlas
			.getEnvironmentContentCounts(environmentId)
			.then((result) => {
				if (!cancelled) setCounts(result);
			})
			.catch(() => {
				if (!cancelled) setError("Couldn't check what's inside this environment.");
			})
			.finally(() => {
				if (!cancelled) setIsLoadingCounts(false);
			});
		return () => {
			cancelled = true;
		};
	}, [environmentId]);

	if (!environment) {
		return null;
	}

	const isMeaningful = Boolean(counts && (counts.tasks > 0 || counts.sessions > 0));
	const nameMatches = typedName.trim().length > 0 && typedName.trim() === environment.name.trim();
	const canDelete = !isLoadingCounts && (!isMeaningful || nameMatches);
	const summaryParts = counts ? describeCounts(counts) : [];

	const handleArchive = async () => {
		setBusyAction("archive");
		setError("");
		try {
			await onArchiveInstead(environment.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unable to archive this environment.");
			setBusyAction(null);
		}
	};

	const handleDelete = async () => {
		if (!canDelete) return;
		setBusyAction("delete");
		setError("");
		try {
			await onConfirmDelete(environment.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unable to delete this environment.");
			setBusyAction(null);
		}
	};

	return (
		<AnimatePresence>
			<motion.div
				className="first-launch-overlay"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				onMouseDown={(event) => {
					if (event.target === event.currentTarget && busyAction === null) onCancel();
				}}
			>
				<motion.div
					className="first-launch-modal grid gap-3.5 text-left"
					initial={{ opacity: 0, y: 16, scale: 0.98 }}
					animate={{ opacity: 1, y: 0, scale: 1 }}
					exit={{ opacity: 0, y: 16, scale: 0.98 }}
				>
					<div>
						<h2 className="text-lg font-semibold">Delete "{environment.name}"?</h2>
						<p className="mt-1 text-[13px] text-neutral-500 dark:text-neutral-300">
							This permanently destroys everything inside it. It cannot be undone.
						</p>
					</div>

					{isLoadingCounts ? (
						<p className="text-[13px] text-neutral-500 dark:text-neutral-300">Checking what's inside...</p>
					) : counts && summaryParts.length > 0 ? (
						<div className="rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
							<p className="font-medium">This will permanently delete:</p>
							<ul className="mt-1.5 list-disc pl-4">
								{summaryParts.map((part) => (
									<li key={part}>{part}</li>
								))}
								{counts.hasCustomNotchLayout && <li>its custom Notch layout</li>}
								<li>its saved settings</li>
							</ul>
						</div>
					) : counts ? (
						<p className="text-[13px] text-neutral-500 dark:text-neutral-300">
							This environment has no tracked activity yet -- deleting it only removes its saved settings.
						</p>
					) : null}

					<div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-600 dark:bg-neutral-700">
						<p className="text-[13px] font-medium text-neutral-800 dark:text-neutral-100">Archive instead?</p>
						<p className="mt-1 text-[12px] text-neutral-500 dark:text-neutral-300">
							Hides it from switching without deleting anything -- bring it back anytime from Settings.
						</p>
						<button
							type="button"
							className="action-btn mt-2"
							disabled={busyAction !== null}
							onClick={() => void handleArchive()}
						>
							{busyAction === "archive" ? "Archiving..." : "Archive instead"}
						</button>
					</div>

					{isMeaningful && (
						<div className="grid gap-1.5">
							<label className="text-[12px] font-medium text-neutral-700 dark:text-neutral-100">
								Type <span className="font-semibold">{environment.name}</span> to confirm deletion
							</label>
							<input
								autoFocus
								value={typedName}
								onChange={(event) => setTypedName(event.target.value)}
								className="h-9 rounded-md border border-neutral-300 bg-neutral-0 px-2.5 text-[13px] text-neutral-800 outline-none transition focus:border-neutral-500 dark:border-neutral-500 dark:bg-neutral-800 dark:text-neutral-50"
								placeholder={environment.name}
							/>
						</div>
					)}

					{error && <p className="text-[12px] text-red-500 dark:text-red-300">{error}</p>}

					<div className="flex justify-end gap-2 pt-1">
						<button type="button" className="action-btn" disabled={busyAction !== null} onClick={onCancel}>
							Cancel
						</button>
						<button
							type="button"
							className="action-btn border-red-600 bg-red-600 text-white hover:bg-red-700 dark:hover:bg-red-500"
							disabled={busyAction !== null || !canDelete}
							onClick={() => void handleDelete()}
						>
							{busyAction === "delete" ? "Deleting..." : "Delete permanently"}
						</button>
					</div>
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}
