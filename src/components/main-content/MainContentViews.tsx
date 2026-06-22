import { DashboardView } from "./DashboardView";
import { ActivityView } from "./ActivityView";
import { NotesView } from "./NotesView";
import { SettingsView } from "./SettingsView";
import { TasksView } from "./TasksView";
import type { MainContentViewsProps } from "./types";

export function MainContentViews(props: MainContentViewsProps) {
	if (props.view === "dashboard") {
		return <DashboardView {...props} />;
	}
	if (props.view === "activity") {
		return <ActivityView {...props} />;
	}
	if (props.view === "tasks") {
		return <TasksView {...props} />;
	}
	if (props.view === "notes") {
		return (
			<NotesView
				key={props.notebook?.id ?? props.selectedMapName}
				{...props}
			/>
		);
	}
	return <SettingsView {...props} />;
}
