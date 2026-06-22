import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarIcon, FlagIcon, TagIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { TASK_PRIORITIES, type TaskColumn, type TaskItem, type TaskPriority, type TaskUpdate } from "../../types";
import { PRIORITY_META } from "./taskMeta";

const fieldClasses =
	"w-full rounded-lg border border-neutral-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-primary dark:border-neutral-600";

// A GitHub-Projects-style detail drawer: open a task to edit its title,
// description, status, priority, due date and tags, or delete it. Each field
// commits independently (selects/date/tags on change, text on blur).
export function TaskDetailPanel({
	task,
	columns,
	onUpdate,
	onDelete,
	onClose,
}: {
	task: TaskItem;
	columns: TaskColumn[];
	onUpdate: (fields: TaskUpdate) => void;
	onDelete: () => void;
	onClose: () => void;
}) {
	// Local drafts for the free-text fields (committed on blur). The parent
	// mounts this with key={task.id}, so switching tasks re-seeds these.
	const [title, setTitle] = useState(task.title);
	const [description, setDescription] = useState(task.description);
	const [tagDraft, setTagDraft] = useState("");

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const commitTitle = () => {
		const next = title.trim();
		if (next && next !== task.title) onUpdate({ title: next });
		else setTitle(task.title);
	};

	const addTag = () => {
		const tag = tagDraft.trim();
		if (!tag || task.tags.includes(tag)) {
			setTagDraft("");
			return;
		}
		onUpdate({ tags: [...task.tags, tag] });
		setTagDraft("");
	};

	const removeTag = (tag: string) => onUpdate({ tags: task.tags.filter((t) => t !== tag) });

	return (
		<AnimatePresence>
			<div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
				<motion.div
					className="absolute inset-0 bg-neutral-900/40"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
				/>
				<motion.aside
					className="relative flex h-full w-full max-w-md flex-col overflow-hidden border-l border-neutral-200 bg-neutral-0 shadow-2xl dark:border-neutral-600 dark:bg-neutral-800"
					initial={{ x: 32, opacity: 0.6 }}
					animate={{ x: 0, opacity: 1 }}
					exit={{ x: 32, opacity: 0 }}
					transition={{ type: "spring", stiffness: 520, damping: 44 }}
					onClick={(event) => event.stopPropagation()}
				>
					<header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-600">
						<span className="text-[12px] uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
							Task details
						</span>
						<button
							type="button"
							onClick={onClose}
							aria-label="Close"
							className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
						>
							<XMarkIcon className="h-5 w-5" />
						</button>
					</header>

					<div className="grid content-start gap-4 overflow-y-auto p-4">
						<textarea
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							onBlur={commitTitle}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									event.currentTarget.blur();
								}
							}}
							rows={2}
							placeholder="Task title"
							className="w-full resize-none rounded-lg border border-transparent bg-transparent px-2 py-1 text-lg font-semibold text-neutral-800 outline-none focus:border-neutral-200 dark:text-neutral-0 dark:focus:border-neutral-600"
						/>

						<div className="grid grid-cols-2 gap-3">
							<label className="grid gap-1">
								<span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
									Status
								</span>
								<select
									value={task.status}
									onChange={(event) => onUpdate({ status: event.target.value })}
									className={fieldClasses}
								>
									{columns.map((column) => (
										<option key={column.status} value={column.status}>
											{column.label}
										</option>
									))}
								</select>
							</label>

							<label className="grid gap-1">
								<span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
									<FlagIcon className="h-3.5 w-3.5" /> Priority
								</span>
								<select
									value={task.priority}
									onChange={(event) => onUpdate({ priority: event.target.value as TaskPriority })}
									className={fieldClasses}
								>
									{TASK_PRIORITIES.map((priority) => (
										<option key={priority} value={priority}>
											{PRIORITY_META[priority].label}
										</option>
									))}
								</select>
							</label>
						</div>

						<label className="grid gap-1">
							<span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
								<CalendarIcon className="h-3.5 w-3.5" /> Due date
							</span>
							<input
								type="date"
								value={task.due_date ?? ""}
								onChange={(event) => onUpdate({ due_date: event.target.value || null })}
								className={fieldClasses}
							/>
						</label>

						<div className="grid gap-1.5">
							<span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
								<TagIcon className="h-3.5 w-3.5" /> Tags
							</span>
							<div className="flex flex-wrap gap-1.5">
								{task.tags.map((tag) => (
									<span
										key={tag}
										className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[12px] text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700/60 dark:text-neutral-100"
									>
										{tag}
										<button
											type="button"
											onClick={() => removeTag(tag)}
											aria-label={`Remove ${tag}`}
											className="text-neutral-400 hover:text-red-500"
										>
											<XMarkIcon className="h-3 w-3" />
										</button>
									</span>
								))}
							</div>
							<input
								type="text"
								value={tagDraft}
								onChange={(event) => setTagDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										addTag();
									}
								}}
								onBlur={addTag}
								placeholder="Add a tag and press Enter"
								className={fieldClasses}
							/>
						</div>

						<label className="grid gap-1">
							<span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
								Description
							</span>
							<textarea
								value={description}
								onChange={(event) => setDescription(event.target.value)}
								onBlur={() => description !== task.description && onUpdate({ description })}
								rows={6}
								placeholder="Add more detail…"
								className={`${fieldClasses} resize-none`}
							/>
						</label>
					</div>

					<footer className="mt-auto border-t border-neutral-200 px-4 py-3 dark:border-neutral-600">
						<button
							type="button"
							onClick={onDelete}
							className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/40"
						>
							<TrashIcon className="h-4 w-4" />
							Delete task
						</button>
					</footer>
				</motion.aside>
			</div>
		</AnimatePresence>
	);
}
