import type { TaskPriority } from "../../types";

// Priority accent colors, shared by the task cards and the detail panel so a
// glance communicates urgency consistently.
export const PRIORITY_META: Record<TaskPriority, { label: string; dot: string; text: string }> = {
	none: { label: "No priority", dot: "bg-neutral-300 dark:bg-neutral-500", text: "text-neutral-500" },
	low: { label: "Low", dot: "bg-sky-400", text: "text-sky-500" },
	medium: { label: "Medium", dot: "bg-amber-400", text: "text-amber-500" },
	high: { label: "High", dot: "bg-orange-500", text: "text-orange-500" },
	urgent: { label: "Urgent", dot: "bg-red-500", text: "text-red-500" },
};
