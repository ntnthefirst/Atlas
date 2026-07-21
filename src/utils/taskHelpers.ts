import type { TaskItem, TaskColumn } from "../types";
import { readStorage } from "./storage";
import { TASK_COLUMNS_KEY } from "../constants";

export const reorderTaskIds = (
	ids: string[],
	draggedId: string,
	targetId: string,
	position: "before" | "after" = "before",
) => {
	const withoutDragged = ids.filter((id) => id !== draggedId);
	const targetIndex = withoutDragged.indexOf(targetId);
	if (targetIndex < 0) {
		return [...withoutDragged, draggedId];
	}
	const next = [...withoutDragged];
	const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
	next.splice(insertIndex, 0, draggedId);
	return next;
};

export const sortTasksByOrder = (nextTasks: TaskItem[], orderedIds: string[]) => {
	if (!orderedIds.length) {
		return nextTasks;
	}
	const rank = new Map(orderedIds.map((id, index) => [id, index]));
	return [...nextTasks].sort((a, b) => {
		const rankA = rank.get(a.id);
		const rankB = rank.get(b.id);
		if (rankA === undefined && rankB === undefined) {
			return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
		}
		if (rankA === undefined) {
			return 1;
		}
		if (rankB === undefined) {
			return -1;
		}
		return rankA - rankB;
	});
};

// The active environment's task columns, read straight from the same
// localStorage key the Tasks board itself writes to (TASK_COLUMNS_KEY) —
// lets any window (notch, settings, action editor) show the real per-map
// columns without needing the map's data passed in.
export const getActiveEnvironmentTaskColumns = (environmentId: string | null, defaultColumns: TaskColumn[]): TaskColumn[] => {
	if (!environmentId) return [...defaultColumns];
	const columnsByMap = readStorage<Record<string, TaskColumn[]>>(TASK_COLUMNS_KEY, {});
	return normalizeColumns(columnsByMap[environmentId] ?? defaultColumns, defaultColumns);
};

export const normalizeColumns = (columns: TaskColumn[], defaultTaskColumns: TaskColumn[]) => {
	const seen = new Set<string>();
	const nextColumns: TaskColumn[] = [];

	for (const column of columns) {
		const status = (column.status || "").trim();
		if (!status || seen.has(status)) {
			continue;
		}
		seen.add(status);
		nextColumns.push({
			status,
			label: (column.label || "").trim() || status,
		});
	}

	if (!nextColumns.length) {
		return [...defaultTaskColumns];
	}

	return nextColumns;
};
