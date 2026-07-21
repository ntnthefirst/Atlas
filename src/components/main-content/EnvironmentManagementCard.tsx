// ---------------------------------------------------------------------------
// The full environment lifecycle surface (WP-1.5): create, edit, duplicate,
// archive, delete -- everything the header's quick environment switcher
// (AtlasEnvironmentMenu) doesn't cover, since that popover only ever rebuilds
// the CURRENTLY selected environment (no cross-environment editing, no
// archive at all, no duplicate).
//
// Lives in Settings, alongside the WP-1.2 EnvironmentAccessCard, because
// this is the same kind of screen: read carefully once in a while, not
// glanced at inside a popover that closes the moment you click elsewhere.
// "Environment access" (isolation) and "Environment management" (lifecycle)
// are two different concerns about the same object, so they sit as two
// separate cards rather than one overloaded one.
//
// Deletion is deliberately NOT handled here directly -- it hands the target
// row to `onRequestDeleteEnvironmentRow`, which opens the single shared
// EnvironmentDeleteDialog (src/components/EnvironmentDeleteDialog.tsx) that
// also backs the header menu's quick delete. One confirmation flow, with
// real counts and proportional confirmation, everywhere an environment can
// be deleted from.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import {
	ArchiveBoxIcon,
	ArchiveBoxXMarkIcon,
	DocumentDuplicateIcon,
	PencilIcon,
	PlusIcon,
	TrashIcon,
} from "@heroicons/react/24/outline";
import type { Environment } from "../../types";
import { AccentPicker } from "../ui";
import { ENVIRONMENT_ICON_KEYS, ENVIRONMENT_PRESETS, getEnvironmentIcon, type EnvironmentPresetTemplate } from "../../environments";
import { DEFAULT_ACCENT } from "../../utils/accent";

type EnvironmentManagementCardProps = {
	environments: Environment[];
	selectedEnvironmentId: string;
	newEnvironmentName: string;
	onNewEnvironmentNameChange: (value: string) => void;
	onCreateEnvironment: () => Promise<void>;
	onCreatePresetEnvironment: (preset: EnvironmentPresetTemplate) => Promise<void>;
	onUpdateEnvironmentById: (
		environmentId: string,
		fields: Partial<Pick<Environment, "name" | "icon" | "accent" | "preset">>,
	) => Promise<void>;
	onDuplicateEnvironmentById: (environmentId: string) => Promise<void>;
	onArchiveEnvironmentById: (environmentId: string) => Promise<void>;
	onUnarchiveEnvironmentById: (environmentId: string) => Promise<void>;
	onRequestDeleteEnvironmentRow: (environment: Environment) => void;
};

export function EnvironmentManagementCard({
	environments,
	selectedEnvironmentId,
	newEnvironmentName,
	onNewEnvironmentNameChange,
	onCreateEnvironment,
	onCreatePresetEnvironment,
	onUpdateEnvironmentById,
	onDuplicateEnvironmentById,
	onArchiveEnvironmentById,
	onUnarchiveEnvironmentById,
	onRequestDeleteEnvironmentRow,
}: EnvironmentManagementCardProps) {
	const [archivedEnvironments, setArchivedEnvironments] = useState<Environment[]>([]);
	const [showArchived, setShowArchived] = useState(false);
	const [showCreate, setShowCreate] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [actionError, setActionError] = useState("");

	// Reloaded whenever the visible list changes -- every mutation this card
	// (or the delete dialog) triggers flows back through App.tsx's own
	// `environments` state, which is what this prop reflects, so this is the
	// one signal needed to keep the "Archived" section in sync too.
	useEffect(() => {
		let cancelled = false;
		void window.atlas
			.listArchivedEnvironments()
			.then((result) => {
				if (!cancelled) setArchivedEnvironments(result);
			})
			.catch(() => {
				if (!cancelled) setActionError("Couldn't load archived environments.");
			});
		return () => {
			cancelled = true;
		};
	}, [environments]);

	const runAction = async (environmentId: string, action: () => Promise<void>) => {
		setBusyId(environmentId);
		setActionError("");
		try {
			await action();
		} catch (error) {
			setActionError(error instanceof Error ? error.message : "That action didn't go through.");
		} finally {
			setBusyId(null);
		}
	};

	return (
		<section className="atlas-card grid gap-4">
			<header className="card-head">
				<h3 className="text-subtitle-small">Environments</h3>
				<button
					type="button"
					className="action-btn"
					onClick={() => {
						setShowCreate((current) => !current);
						setEditingId(null);
					}}
				>
					<PlusIcon className="h-3.5 w-3.5" />
					New environment
				</button>
			</header>

			{actionError && (
				<p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-600 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
					{actionError}
				</p>
			)}

			{showCreate && (
				<div className="grid gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-600 dark:bg-neutral-700">
					<input
						value={newEnvironmentName}
						onChange={(event) => onNewEnvironmentNameChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void onCreateEnvironment().then(() => setShowCreate(false));
							}
						}}
						placeholder="New environment name"
						autoFocus
						className="h-9 rounded-md border border-neutral-300 bg-neutral-0 px-2.5 text-[13px] text-neutral-800 outline-none transition focus:border-neutral-500 dark:border-neutral-500 dark:bg-neutral-800 dark:text-neutral-50"
					/>
					<div className="flex flex-wrap gap-1.5">
						<button
							type="button"
							className="action-btn"
							disabled={!newEnvironmentName.trim()}
							onClick={() => void onCreateEnvironment().then(() => setShowCreate(false))}
						>
							Create blank
						</button>
					</div>
					<p className="pt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
						Or start from a preset
					</p>
					<div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
						{ENVIRONMENT_PRESETS.map((preset) => {
							const Icon = getEnvironmentIcon(preset.icon);
							return (
								<button
									key={preset.id}
									type="button"
									title={preset.description}
									onClick={() => void onCreatePresetEnvironment(preset).then(() => setShowCreate(false))}
									className="group flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-neutral-700 transition hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-600"
								>
									<span
										className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
										style={{ backgroundColor: `${preset.accent}1f`, color: preset.accent }}
									>
										<Icon className="h-3.5 w-3.5" />
									</span>
									<span className="truncate text-[13px]">{preset.name}</span>
								</button>
							);
						})}
					</div>
				</div>
			)}

			<ul className="grid gap-1.5">
				{environments.map((environment) => {
					const Icon = getEnvironmentIcon(environment.icon);
					const isEditing = editingId === environment.id;
					const isBusy = busyId === environment.id;
					return (
						<li
							key={environment.id}
							className="grid gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-600 dark:bg-neutral-700"
						>
							<div className="flex items-center gap-2.5">
								<span
									className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
									style={{ backgroundColor: `${environment.accent ?? DEFAULT_ACCENT}1f`, color: environment.accent ?? DEFAULT_ACCENT }}
								>
									<Icon className="h-4 w-4" />
								</span>
								<div className="min-w-0 flex-1">
									<p className="truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
										{environment.name}
									</p>
									{environment.id === selectedEnvironmentId && (
										<span className="text-[10px] uppercase tracking-[0.12em] text-primary">Currently active</span>
									)}
								</div>
								<div className="flex shrink-0 items-center gap-1">
									<button
										type="button"
										title="Edit"
										aria-label={`Edit ${environment.name}`}
										disabled={isBusy}
										onClick={() => setEditingId(isEditing ? null : environment.id)}
										className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-600"
									>
										<PencilIcon className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										title="Duplicate"
										aria-label={`Duplicate ${environment.name}`}
										disabled={isBusy}
										onClick={() => void runAction(environment.id, () => onDuplicateEnvironmentById(environment.id))}
										className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-600"
									>
										<DocumentDuplicateIcon className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										title="Archive"
										aria-label={`Archive ${environment.name}`}
										disabled={isBusy}
										onClick={() => void runAction(environment.id, () => onArchiveEnvironmentById(environment.id))}
										className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-600"
									>
										<ArchiveBoxIcon className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										title="Delete"
										aria-label={`Delete ${environment.name}`}
										disabled={isBusy}
										onClick={() => onRequestDeleteEnvironmentRow(environment)}
										className="inline-flex h-7 w-7 items-center justify-center rounded-md text-red-500 transition hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
									>
										<TrashIcon className="h-3.5 w-3.5" />
									</button>
								</div>
							</div>

							{isEditing && (
								<div className="grid gap-2.5 border-t border-neutral-200 pt-2.5 dark:border-neutral-600">
									<input
										defaultValue={environment.name}
										onBlur={(event) => {
											const nextName = event.target.value.trim();
											if (nextName && nextName !== environment.name) {
												void runAction(environment.id, () => onUpdateEnvironmentById(environment.id, { name: nextName }));
											}
										}}
										className="h-8 rounded-md border border-neutral-300 bg-neutral-0 px-2.5 text-[13px] text-neutral-800 outline-none transition focus:border-neutral-500 dark:border-neutral-500 dark:bg-neutral-800 dark:text-neutral-50"
									/>
									<div className="grid grid-cols-9 gap-1">
										{ENVIRONMENT_ICON_KEYS.map((key) => {
											const KeyIcon = getEnvironmentIcon(key);
											const active = (environment.icon ?? "") === key;
											return (
												<button
													key={key}
													type="button"
													aria-pressed={active}
													onClick={() => void runAction(environment.id, () => onUpdateEnvironmentById(environment.id, { icon: key }))}
													className={`inline-flex h-7 w-full items-center justify-center rounded-md border transition ${
														active
															? "border-primary bg-primary/10 text-primary"
															: "border-transparent text-neutral-500 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-600"
													}`}
												>
													<KeyIcon className="h-3.5 w-3.5" />
												</button>
											);
										})}
									</div>
									<AccentPicker
										value={environment.accent || DEFAULT_ACCENT}
										onChange={(value) => void runAction(environment.id, () => onUpdateEnvironmentById(environment.id, { accent: value }))}
									/>
									<button type="button" className="action-btn justify-self-start" onClick={() => setEditingId(null)}>
										Done
									</button>
								</div>
							)}
						</li>
					);
				})}
				{environments.length === 0 && (
					<li className="rounded-lg border border-dashed border-neutral-300 p-3 text-center text-[13px] text-neutral-500 dark:border-neutral-500 dark:text-neutral-300">
						No environments yet. Create one above to get started.
					</li>
				)}
			</ul>

			<div className="border-t border-neutral-200 pt-3 dark:border-neutral-600">
				<button
					type="button"
					className="flex w-full items-center justify-between text-[12px] font-medium uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300"
					onClick={() => setShowArchived((current) => !current)}
				>
					<span>Archived ({archivedEnvironments.length})</span>
					<span>{showArchived ? "Hide" : "Show"}</span>
				</button>

				{showArchived && (
					<ul className="mt-2 grid gap-1.5">
						{archivedEnvironments.length === 0 && (
							<li className="text-[13px] text-neutral-500 dark:text-neutral-300">Nothing archived.</li>
						)}
						{archivedEnvironments.map((environment) => {
							const Icon = getEnvironmentIcon(environment.icon);
							const isBusy = busyId === environment.id;
							return (
								<li
									key={environment.id}
									className="flex items-center gap-2.5 rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 opacity-80 dark:border-neutral-600 dark:bg-neutral-700"
								>
									<span
										className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
										style={{ backgroundColor: `${environment.accent ?? DEFAULT_ACCENT}1f`, color: environment.accent ?? DEFAULT_ACCENT }}
									>
										<Icon className="h-4 w-4" />
									</span>
									<p className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
										{environment.name}
									</p>
									<button
										type="button"
										title="Unarchive"
										aria-label={`Unarchive ${environment.name}`}
										disabled={isBusy}
										onClick={() => void runAction(environment.id, () => onUnarchiveEnvironmentById(environment.id))}
										className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-600"
									>
										<ArchiveBoxXMarkIcon className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										title="Delete permanently"
										aria-label={`Delete ${environment.name} permanently`}
										disabled={isBusy}
										onClick={() => onRequestDeleteEnvironmentRow(environment)}
										className="inline-flex h-7 w-7 items-center justify-center rounded-md text-red-500 transition hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
									>
										<TrashIcon className="h-3.5 w-3.5" />
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</section>
	);
}
