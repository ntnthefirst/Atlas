import { useState, useMemo } from "react";
import { ChartBarIcon, ClockIcon } from "@heroicons/react/24/outline";
import { AnalysisView } from "./AnalysisView";
import { LogbookView } from "./LogbookView";
import type { MainContentViewsProps } from "./types";
import { useCalendarFilter } from "../../hooks";
import { CalendarPopover } from "./CalendarPopover";

type ActivityMode = "analytics" | "log";

const segments: Array<{ id: ActivityMode; label: string; icon: typeof ChartBarIcon }> = [
	{ id: "analytics", label: "Analytics", icon: ChartBarIcon },
	{ id: "log", label: "Log", icon: ClockIcon },
];

export function ActivityView(props: MainContentViewsProps) {
	const [mode, setMode] = useState<ActivityMode>("analytics");

	const calendarFilter = useCalendarFilter(props.sessions, props.now, props.sessionElapsedMs);

	const yearOptions = useMemo(() => {
		const years = props.sessions.map((session) => new Date(session.started_at).getFullYear());
		years.push(new Date(props.now).getFullYear());

		const minYear = Math.min(...years, new Date(props.now).getFullYear()) - 2;
		const maxYear = Math.max(...years, new Date(props.now).getFullYear()) + 2;
		const options: number[] = [];
		for (let year = minYear; year <= maxYear; year += 1) {
			options.push(year);
		}
		return options;
	}, [props.sessions, props.now]);

	const childProps = {
		...props,
		sessions: calendarFilter.filteredSessions,
		// passing extra stats for AnalysisView so it doesn't have to recalculate
		filteredSessionStats: calendarFilter.filteredSessionStats,
	};

	return (
		<div className="flex h-full min-h-0 w-full flex-col gap-3">
			<div className="flex shrink-0 items-center justify-between">
				<div id="activity-view-header-left" className="flex items-center">
					<CalendarPopover
						{...calendarFilter}
						yearOptions={yearOptions}
						now={props.now}
						formatDuration={props.formatDuration}
					/>
				</div>
				<div className="flex shrink-0 items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 p-1 dark:border-neutral-600 dark:bg-neutral-800">
					{segments.map((segment) => {
						const Icon = segment.icon;
						const isActive = mode === segment.id;
						return (
							<button
								key={segment.id}
								type="button"
								onClick={() => setMode(segment.id)}
								className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${
									isActive
										? "bg-primary/10 text-primary"
										: "text-neutral-500 hover:text-neutral-700 dark:text-neutral-300 dark:hover:text-neutral-100"
								}`}
							>
								<Icon className="h-4 w-4" />
								{segment.label}
							</button>
						);
					})}
				</div>
			</div>
			<div className="min-h-0 flex-1">
				{mode === "analytics" ? <AnalysisView {...childProps} /> : <LogbookView {...childProps} />}
			</div>
		</div>
	);
}
