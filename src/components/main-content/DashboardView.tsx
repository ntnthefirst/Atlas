import type { MainContentViewsProps } from "./types";
import { DashboardGrid } from "./dashboard/DashboardGrid";
import type { DashboardWidgetData } from "./dashboard/DashboardWidget";

export function DashboardView(props: MainContentViewsProps) {
	// The dashboard cards draw entirely from data the main view already loads;
	// gather just what they need into one bag for DashboardGrid.
	const data: DashboardWidgetData = {
		dashboard: props.dashboard,
		activeSession: props.activeSession,
		activeElapsed: props.activeElapsed,
		currentAppName: props.currentAppName,
		selectedEnvironmentName: props.selectedEnvironmentName,
		sessions: props.sessions,
		now: props.now,
		formatDuration: props.formatDuration,
		tasks: props.tasks,
		statusColumns: props.statusColumns,
		notebook: props.notebook,
		focus: props.focus,
	};

	return <DashboardGrid data={data} />;
}
