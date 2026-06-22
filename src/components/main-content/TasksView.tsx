import { CalendarIcon, MinusIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useRef, useState } from "react";
import type { MainContentViewsProps } from "./types";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { PRIORITY_META } from "./taskMeta";

type DropPosition = "before" | "after";

// "2026-06-25" -> "25 Jun", and flags whether it's already past.
const formatDue = (iso: string) => {
	const date = new Date(`${iso}T00:00:00`);
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	return {
		label: date.toLocaleDateString([], { day: "numeric", month: "short" }),
		overdue: date.getTime() < today.getTime(),
	};
};

export function TasksView({
	statusColumns,
	tasks,
	dropStatus,
	setDropStatus,
	onDropInColumn,
	onDropOnTask,
	setDraggedTaskId,
	onCreateTaskInColumn,
	onUpdateTask,
	onDeleteTask,
	onRenameTaskColumn,
	onReorderTaskColumns,
	onAddTaskColumn,
	onRemoveTaskColumn,
}: MainContentViewsProps) {
	const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
	const detailTask = tasks.find((task) => task.id === detailTaskId) ?? null;
	const [composerStatus, setComposerStatus] = useState<string>(statusColumns[0]?.status ?? "");
	const [composerTitle, setComposerTitle] = useState("");
	const [isComposerOpen, setIsComposerOpen] = useState(false);
	const [editingStatus, setEditingStatus] = useState<string | null>(null);
	const [editingLabel, setEditingLabel] = useState("");
	const [draggedColumnStatus, setDraggedColumnStatus] = useState<string | null>(null);
	const [draggedTaskLocalId, setDraggedTaskLocalId] = useState<string | null>(null);
	const [columnDropTarget, setColumnDropTarget] = useState<{
		status: string;
		position: DropPosition;
	} | null>(null);
	const [taskDropTarget, setTaskDropTarget] = useState<{
		columnStatus: string;
		taskId: string;
		position: DropPosition;
	} | null>(null);
	const draggedColumnStatusRef = useRef<string | null>(null);
	const draggedTaskLocalIdRef = useRef<string | null>(null);
	const composerInputRef = useRef<HTMLInputElement | null>(null);
	const safeComposerStatus =
		statusColumns.length === 0
			? ""
			: statusColumns.some((column) => column.status === composerStatus)
				? composerStatus
				: statusColumns[0].status;

	const commitColumnRename = (status: string) => {
		const nextLabel = editingLabel.trim();
		if (nextLabel) {
			onRenameTaskColumn(status, nextLabel);
		}
		setEditingStatus(null);
		setEditingLabel("");
	};

	const submitComposerTask = async () => {
		const title = composerTitle.trim();
		if (!safeComposerStatus || !title) {
			return;
		}
		await onCreateTaskInColumn(safeComposerStatus, title);
		setComposerTitle("");
		composerInputRef.current?.focus();
	};

	const closeComposer = () => {
		setIsComposerOpen(false);
		setComposerTitle("");
	};

	const openComposerForStatus = (status: string) => {
		setComposerStatus(status);
		setComposerTitle("");
		setIsComposerOpen(true);
		window.requestAnimationFrame(() => {
			composerInputRef.current?.focus();
		});
	};

	const composerColumn = statusColumns.find((column) => column.status === safeComposerStatus);
	const composerPlaceholder = composerColumn ? `Add a task in ${composerColumn.label}` : "Add a task";

	const clearDragState = () => {
		draggedColumnStatusRef.current = null;
		draggedTaskLocalIdRef.current = null;
		setDraggedColumnStatus(null);
		setDraggedTaskLocalId(null);
		setColumnDropTarget(null);
		setTaskDropTarget(null);
		setDropStatus(null);
	};

	return (
		<div className="relative grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-[10px]">
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-subtitle-small m-0">Board</h3>
				<button
					type="button"
					className="inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border border-neutral-200 bg-neutral-0 px-[10px] py-[7px] text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-50"
					onClick={onAddTaskColumn}
				>
					<PlusIcon className="h-4 w-4" />
					Add column
				</button>
			</div>

			<div className="relative h-full w-full overflow-x-auto">
				<div className="grid h-full min-h-0 grid-flow-col auto-cols-[minmax(280px,1fr)] items-stretch gap-2.5 pb-0.5">
					{statusColumns.map((column) => {
						const columnTasks = tasks.filter((task) => task.status === column.status);
						const showColumnPlaceholderBefore =
							columnDropTarget?.status === column.status && columnDropTarget.position === "before";
						const showColumnPlaceholderAfter =
							columnDropTarget?.status === column.status && columnDropTarget.position === "after";

						return (
							<div
								key={column.status}
								className="relative flex h-full min-h-0 min-w-[280px] flex-col overflow-visible"
							>
								{showColumnPlaceholderBefore ? (
									<div className="pointer-events-none absolute bottom-3 left-[-6px] top-3 z-30 w-1.5 rounded-full bg-blue-500 shadow-[0_0_0_2px_rgba(59,130,246,0.25)]" />
								) : null}
								<section
									className={`atlas-card flex h-full w-full min-h-0 min-w-[280px] flex-col transition-[border-color,box-shadow] duration-[140ms] ease-in-out ${
										dropStatus === column.status
											? "border-primary shadow-[0_0_0_2px_rgba(91,140,255,0.22)]"
											: ""
									} ${draggedColumnStatus === column.status ? "opacity-35" : ""}`}
									onDragOver={(event) => {
										event.preventDefault();
										if (draggedColumnStatusRef.current) {
											const rect = event.currentTarget.getBoundingClientRect();
											const position: DropPosition =
												event.clientX < rect.left + rect.width / 2 ? "before" : "after";
											setColumnDropTarget({ status: column.status, position });
											setTaskDropTarget(null);
											return;
										}
										if (draggedTaskLocalIdRef.current) {
											setDropStatus(column.status);
										}
									}}
									onDragLeave={() => {
										if (dropStatus === column.status) {
											setDropStatus(null);
										}
									}}
									onDrop={(event) => {
										event.preventDefault();
										if (taskDropTarget?.columnStatus === column.status) {
											return;
										}
										if (draggedColumnStatusRef.current) {
											const draggedStatus = draggedColumnStatusRef.current;
											if (draggedStatus && draggedStatus !== column.status) {
												onReorderTaskColumns(
													draggedStatus,
													column.status,
													columnDropTarget?.status === column.status
														? columnDropTarget.position
														: "before",
												);
											}
											clearDragState();
											return;
										}
										if (draggedTaskLocalIdRef.current) {
											onDropInColumn(column.status).catch(console.error);
											setTaskDropTarget(null);
										}
									}}
								>
									<header
										className="card-head items-center gap-1.5"
										draggable
										onDragStart={(event) => {
											setDraggedTaskId("");
											draggedTaskLocalIdRef.current = null;
											setDraggedTaskLocalId(null);
											draggedColumnStatusRef.current = column.status;
											setDraggedColumnStatus(column.status);
											event.dataTransfer.setData("text/plain", `column:${column.status}`);
											event.dataTransfer.effectAllowed = "move";
										}}
										onDragEnd={clearDragState}
									>
										{editingStatus === column.status ? (
											<input
												value={editingLabel}
												onChange={(event) => setEditingLabel(event.target.value)}
												onBlur={() => commitColumnRename(column.status)}
												aria-label="Column title"
												title="Column title"
												placeholder="Column title"
												onKeyDown={(event) => {
													if (event.key === "Enter") {
														event.preventDefault();
														commitColumnRename(column.status);
													}
													if (event.key === "Escape") {
														event.preventDefault();
														setEditingStatus(null);
														setEditingLabel("");
													}
												}}
												autoFocus
											/>
										) : (
											<h3
												className="text-subtitle-small m-0 cursor-text select-none"
												onDoubleClick={() => {
													setEditingStatus(column.status);
													setEditingLabel(column.label);
												}}
											>
												{column.label}
											</h3>
										)}
										<div className="inline-flex items-center gap-1.5">
											<span className="text-data-small">
												{tasks.filter((task) => task.status === column.status).length}
											</span>
											<button
												type="button"
												className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-transparent text-neutral-500 hover:border-[color-mix(in_srgb,var(--primary)_22%,transparent)] hover:text-primary dark:text-neutral-300"
												onClick={() => openComposerForStatus(column.status)}
												title="Add task"
											>
												<PlusIcon className="h-4 w-4" />
											</button>
											<button
												type="button"
												className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-transparent text-neutral-500 hover:border-[color-mix(in_srgb,var(--secondary-hover)_22%,transparent)] hover:text-secondary-hover disabled:cursor-not-allowed disabled:opacity-45 dark:text-neutral-300"
												onClick={() => {
													onRemoveTaskColumn(column.status).catch(console.error);
												}}
												title="Remove column"
												disabled={statusColumns.length <= 1}
											>
												<MinusIcon className="h-4 w-4" />
											</button>
										</div>
									</header>
									<div className="stack-list min-h-0">
										{columnTasks.map((task) => (
											<div
												key={task.id}
												className="contents"
											>
												{taskDropTarget?.columnStatus === column.status &&
												taskDropTarget.taskId === task.id &&
												taskDropTarget.position === "before" ? (
													<div className="mx-0.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_0_2px_rgba(59,130,246,0.25)]" />
												) : null}
												<div
													className={`group/task grid cursor-grab gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-[10px] transition-shadow hover:shadow-sm active:cursor-grabbing dark:border-neutral-600 dark:bg-neutral-700 ${
														draggedTaskLocalId === task.id ? "opacity-35" : ""
													}`}
													draggable
													onClick={() => setDetailTaskId(task.id)}
													onDragStart={(event) => {
														draggedColumnStatusRef.current = null;
														setDraggedColumnStatus(null);
														draggedTaskLocalIdRef.current = task.id;
														setDraggedTaskLocalId(task.id);
														setDraggedTaskId(task.id);
														event.dataTransfer.setData("text/plain", `task:${task.id}`);
														event.dataTransfer.effectAllowed = "move";
													}}
													onDragEnd={() => {
														setDraggedTaskId("");
														clearDragState();
													}}
													onDragOver={(event) => {
														event.preventDefault();
														if (
															!draggedTaskLocalIdRef.current ||
															draggedTaskLocalIdRef.current === task.id
														) {
															return;
														}
														const rect = event.currentTarget.getBoundingClientRect();
														const position: DropPosition =
															event.clientY < rect.top + rect.height / 2
																? "before"
																: "after";
														setTaskDropTarget({
															columnStatus: column.status,
															taskId: task.id,
															position,
														});
														setDropStatus(column.status);
													}}
													onDrop={(event) => {
														event.preventDefault();
														event.stopPropagation();
														if (
															draggedTaskLocalIdRef.current &&
															draggedTaskLocalIdRef.current !== task.id
														) {
															const dropPosition =
																taskDropTarget?.columnStatus === column.status &&
																taskDropTarget.taskId === task.id
																	? taskDropTarget.position
																	: "before";
															onDropOnTask(task, dropPosition).catch(console.error);
															setTaskDropTarget(null);
														}
													}}
												>
													<div className="flex items-start justify-between gap-2">
														<strong className="text-body-small text-[14px] font-semibold">
															{task.title}
														</strong>
														{task.priority !== "none" && (
															<span
																className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${PRIORITY_META[task.priority].dot}`}
																title={`${PRIORITY_META[task.priority].label} priority`}
															/>
														)}
													</div>
													{task.description && (
														<p className="m-0 line-clamp-2 text-[12px] text-neutral-500 dark:text-neutral-300">
															{task.description}
														</p>
													)}
													{(task.due_date || task.tags.length > 0) && (
														<div className="flex flex-wrap items-center gap-1">
															{task.due_date &&
																(() => {
																	const due = formatDue(task.due_date);
																	return (
																		<span
																			className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${
																				due.overdue
																					? "bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400"
																					: "bg-neutral-200/70 text-neutral-600 dark:bg-neutral-600/60 dark:text-neutral-200"
																			}`}
																		>
																			<CalendarIcon className="h-3 w-3" />
																			{due.label}
																		</span>
																	);
																})()}
															{task.tags.map((tag) => (
																<span
																	key={tag}
																	className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
																>
																	{tag}
																</span>
															))}
														</div>
													)}
												</div>
												{taskDropTarget?.columnStatus === column.status &&
												taskDropTarget.taskId === task.id &&
												taskDropTarget.position === "after" ? (
													<div className="mx-0.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_0_2px_rgba(59,130,246,0.25)]" />
												) : null}
											</div>
										))}
										{!columnTasks.length && dropStatus === column.status ? (
											<div className="mx-0.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_0_2px_rgba(59,130,246,0.25)]" />
										) : null}
										{!tasks.some((task) => task.status === column.status) && (
											<p className="empty">No tasks</p>
										)}
									</div>
								</section>
								{showColumnPlaceholderAfter ? (
									<div className="pointer-events-none absolute bottom-3 right-[-6px] top-3 z-30 w-1.5 rounded-full bg-blue-500 shadow-[0_0_0_2px_rgba(59,130,246,0.25)]" />
								) : null}
							</div>
						);
					})}
				</div>
			</div>
			{isComposerOpen ? (
				<div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-0 px-2 py-1 shadow-sm max-[920px]:grid-cols-1 max-[920px]:items-stretch dark:border-neutral-600 dark:bg-neutral-700">
					<input
						className="h-full w-full border border-neutral-200 outline-none"
						ref={composerInputRef}
						value={composerTitle}
						onChange={(event) => setComposerTitle(event.target.value)}
						onBlur={closeComposer}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								submitComposerTask().catch(console.error);
							}
							if (event.key === "Escape") {
								event.preventDefault();
								closeComposer();
							}
						}}
						placeholder={composerPlaceholder}
						aria-label="New task title"
					/>
				</div>
			) : null}

			{detailTask && (
				<TaskDetailPanel
					key={detailTask.id}
					task={detailTask}
					columns={statusColumns}
					onUpdate={(fields) => {
						void onUpdateTask(detailTask.id, fields);
					}}
					onDelete={() => {
						void onDeleteTask(detailTask.id);
						setDetailTaskId(null);
					}}
					onClose={() => setDetailTaskId(null)}
				/>
			)}
		</div>
	);
}
