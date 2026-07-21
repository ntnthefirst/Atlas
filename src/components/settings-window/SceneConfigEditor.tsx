import { useState } from "react";
import { FolderOpenIcon, PlusIcon, Squares2X2Icon, TrashIcon } from "@heroicons/react/24/outline";
import { TAB_ICON_MAP } from "./tabIconMap";
import { defaultTaskColumns } from "../../constants";
import { getActiveEnvironmentTaskColumns } from "../../utils";
import { NOTCH_TAB_ICONS } from "../../types";
import type { NotchTabIcon } from "../../types";
import { parseSceneConfig, serializeSceneConfig, type NotchSceneConfig } from "../../scenes";

const lastEnvironmentId = () => {
	try {
		return localStorage.getItem("atlas.lastEnvironmentId");
	} catch {
		return null;
	}
};

const fieldClasses =
	"min-w-0 flex-1 rounded-md border border-neutral-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-primary dark:border-neutral-600";

const ghostButtonClasses =
	"flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700/60";

// Edits the JSON-encoded scene stored in a placement's `config` string. Kept
// fully controlled — every change re-serializes and bubbles up through
// onChange so it persists the same way every other widget's config does.
export function SceneConfigEditor({
	config,
	onChange,
}: {
	config: string | undefined;
	onChange: (next: string) => void;
}) {
	const scene = parseSceneConfig(config);
	const [iconPickerOpen, setIconPickerOpen] = useState(false);
	const [environments, setEnvironments] = useState<Array<{ id: string; name: string }>>([]);

	const update = (patch: Partial<NotchSceneConfig>) => onChange(serializeSceneConfig({ ...scene, ...patch }));

	const taskColumns = getActiveEnvironmentTaskColumns(lastEnvironmentId(), defaultTaskColumns);
	const SelectedIcon = TAB_ICON_MAP[scene.icon] ?? Squares2X2Icon;

	const loadEnvironments = () => {
		if (environments.length > 0) return;
		window.atlas
			.listEnvironments()
			.then((environments) => setEnvironments(environments.map((map) => ({ id: map.id, name: map.name }))))
			.catch(() => setEnvironments([]));
	};

	return (
		<div className="grid gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-600 dark:bg-neutral-800/40">
			<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
				Scene
			</span>

			{/* Icon + label */}
			<div className="flex items-center gap-2">
				<div className="relative">
					<button
						type="button"
						onClick={() => setIconPickerOpen((open) => !open)}
						title="Change icon"
						aria-label="Change scene icon"
						className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
					>
						<SelectedIcon className="h-5 w-5" />
					</button>
					{iconPickerOpen && (
						<>
							<div className="fixed inset-0 z-40" onClick={() => setIconPickerOpen(false)} />
							<div
								className="absolute left-0 top-full z-50 mt-1 grid max-h-60 gap-2 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-0 p-3 shadow-lg dark:border-neutral-600 dark:bg-neutral-800"
								style={{ gridTemplateColumns: "repeat(7, 2.25rem)" }}
							>
								{NOTCH_TAB_ICONS.map((iconKey: NotchTabIcon) => {
									const OptionIcon = TAB_ICON_MAP[iconKey];
									const isSelected = scene.icon === iconKey;
									return (
										<button
											key={iconKey}
											type="button"
											onClick={() => {
												update({ icon: iconKey });
												setIconPickerOpen(false);
											}}
											title={iconKey}
											className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors ${
												isSelected
													? "border-primary bg-primary/10 text-primary"
													: "border-transparent text-neutral-500 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
											}`}
										>
											<OptionIcon className="h-5 w-5" />
										</button>
									);
								})}
							</div>
						</>
					)}
				</div>
				<input
					type="text"
					value={scene.label}
					onChange={(event) => update({ label: event.target.value })}
					placeholder="Scene name"
					className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-transparent px-3 py-2 text-sm text-neutral-800 outline-none focus:border-primary dark:border-neutral-600 dark:text-neutral-100"
				/>
			</div>

			{/* Apps */}
			<StringListEditor
				label="Launch apps"
				items={scene.apps}
				placeholder="Pick a program, or type a command"
				onChange={(apps) => update({ apps })}
				renderExtra={(setValue) => (
					<button
						type="button"
						className={ghostButtonClasses}
						onClick={async () => {
							const filePath = await window.atlas.pickAppFile();
							if (!filePath) return;
							setValue(filePath.includes(" ") ? `"${filePath}"` : filePath);
						}}
					>
						<FolderOpenIcon className="h-3.5 w-3.5" />
						Browse
					</button>
				)}
			/>

			{/* URLs */}
			<StringListEditor
				label="Open URLs"
				items={scene.urls}
				placeholder="https://example.com"
				onChange={(urls) => update({ urls })}
			/>

			{/* Timer */}
			<label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-300">
				<span className="w-24 shrink-0">Timer</span>
				<select
					value={scene.timer}
					onChange={(event) => update({ timer: event.target.value as NotchSceneConfig["timer"] })}
					className={fieldClasses}
				>
					<option value="none">Don't change</option>
					<option value="start">Start timer</option>
					<option value="stop">Stop timer</option>
				</select>
			</label>

			{/* Environment switch */}
			<label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-300">
				<span className="w-24 shrink-0">Environment</span>
				<select
					value={scene.environmentId}
					onChange={(event) => update({ environmentId: event.target.value })}
					onMouseDown={loadEnvironments}
					onFocus={loadEnvironments}
					className={fieldClasses}
				>
					<option value="">Don't switch</option>
					{environments.map((env) => (
						<option key={env.id} value={env.id}>
							{env.name}
						</option>
					))}
					{/* Keep the saved id selectable even before the list loads. */}
					{scene.environmentId && !environments.some((env) => env.id === scene.environmentId) && (
						<option value={scene.environmentId}>Saved environment</option>
					)}
				</select>
			</label>

			{/* Preset tasks */}
			<div className="grid gap-1.5">
				<span className="text-xs text-neutral-500 dark:text-neutral-300">Add tasks</span>
				{scene.tasks.map((task, index) => (
					<div key={index} className="flex items-center gap-1.5">
						<input
							type="text"
							value={task.title}
							onChange={(event) => {
								const tasks = scene.tasks.slice();
								tasks[index] = { ...tasks[index], title: event.target.value };
								update({ tasks });
							}}
							placeholder="Task title"
							className={fieldClasses}
						/>
						<select
							value={task.column ?? ""}
							onChange={(event) => {
								const tasks = scene.tasks.slice();
								tasks[index] = { ...tasks[index], column: event.target.value || undefined };
								update({ tasks });
							}}
							className="shrink-0 rounded-md border border-neutral-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-primary dark:border-neutral-600"
						>
							<option value="">First column</option>
							{taskColumns.map((column) => (
								<option key={column.status} value={column.status}>
									{column.label}
								</option>
							))}
						</select>
						<button
							type="button"
							onClick={() => update({ tasks: scene.tasks.filter((_, i) => i !== index) })}
							title="Remove task"
							aria-label="Remove task"
							className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-neutral-300 dark:hover:bg-red-950/40 dark:hover:text-red-400"
						>
							<TrashIcon className="h-3.5 w-3.5" />
						</button>
					</div>
				))}
				<button
					type="button"
					onClick={() => update({ tasks: [...scene.tasks, { title: "" }] })}
					className="flex w-fit items-center gap-1 text-xs font-medium text-primary"
				>
					<PlusIcon className="h-3.5 w-3.5" />
					Add task
				</button>
			</div>
		</div>
	);
}

// A small reusable editor for an ordered list of plain strings (apps, urls):
// one input per entry with a remove button, plus an "add" row. renderExtra
// lets the apps variant tuck a "Browse" button alongside the new-entry input.
function StringListEditor({
	label,
	items,
	placeholder,
	onChange,
	renderExtra,
}: {
	label: string;
	items: string[];
	placeholder: string;
	onChange: (next: string[]) => void;
	renderExtra?: (setValue: (value: string) => void) => React.ReactNode;
}) {
	const [draft, setDraft] = useState("");

	const commitDraft = (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;
		onChange([...items, trimmed]);
		setDraft("");
	};

	return (
		<div className="grid gap-1.5">
			<span className="text-xs text-neutral-500 dark:text-neutral-300">{label}</span>
			{items.map((item, index) => (
				<div key={index} className="flex items-center gap-1.5">
					<input
						type="text"
						value={item}
						onChange={(event) => {
							const next = items.slice();
							next[index] = event.target.value;
							onChange(next);
						}}
						className={fieldClasses}
					/>
					<button
						type="button"
						onClick={() => onChange(items.filter((_, i) => i !== index))}
						title="Remove"
						aria-label="Remove"
						className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-neutral-300 dark:hover:bg-red-950/40 dark:hover:text-red-400"
					>
						<TrashIcon className="h-3.5 w-3.5" />
					</button>
				</div>
			))}
			<div className="flex items-center gap-1.5">
				<input
					type="text"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							commitDraft(draft);
						}
					}}
					placeholder={placeholder}
					className={fieldClasses}
				/>
				{renderExtra?.(commitDraft)}
				<button
					type="button"
					onClick={() => commitDraft(draft)}
					disabled={!draft.trim()}
					title="Add"
					aria-label="Add"
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-30"
				>
					<PlusIcon className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}
