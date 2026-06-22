import { useEffect, useState } from "react";
import { ArrowTopRightOnSquareIcon, GlobeAltIcon, RocketLaunchIcon } from "@heroicons/react/24/outline";
import type { DashboardWidgetId, DashboardOverview, NoteItem, Session, TaskColumn, TaskItem } from "../../../types";

// Everything a dashboard card might need, assembled by DashboardView from the
// data it already loads. Passing one bag keeps DashboardWidget decoupled from
// the main view's full prop list.
export type DashboardWidgetData = {
	dashboard: DashboardOverview;
	activeSession: Session | null;
	activeElapsed: string;
	currentAppName: string;
	selectedMapName: string;
	quickActions: Array<{ id: string; label: string; command: string }>;
	onLaunchQuickAction: (command: string) => void;
	sessions: Session[];
	now: number;
	formatDuration: (ms: number) => string;
	tasks: TaskItem[];
	statusColumns: TaskColumn[];
	notebook: NoteItem | null;
};

// Strips the "[tracked-name]" suffix the tracker appends, matching the
// original DashboardView so app labels read cleanly.
const cleanAppLabel = (value: string) => {
	const cleaned = value
		.replace(/\s*\[[^\]]*\]\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return cleaned || "Unknown";
};

const isToday = (iso: string, reference: Date) => {
	const date = new Date(iso);
	return (
		date.getFullYear() === reference.getFullYear() &&
		date.getMonth() === reference.getMonth() &&
		date.getDate() === reference.getDate()
	);
};

function Stat({ value, label }: { value: string | number; label: string }) {
	return (
		<div className="flex h-full flex-col items-start justify-center gap-1">
			<span className="font-data text-[28px] font-semibold leading-none text-neutral-800 dark:text-neutral-0">
				{value}
			</span>
			<span className="text-[12px] uppercase tracking-[0.1em] text-neutral-500 dark:text-neutral-300">
				{label}
			</span>
		</div>
	);
}

function CardHeader({ title }: { title: string }) {
	return (
		<header className="card-head">
			<h3 className="text-subtitle-small">{title}</h3>
		</header>
	);
}

// "C:\\...\\Code.exe" or Code.exe -> "Code". Quotes/paths/extension stripped
// so a launch button can show a friendly name.
const appNameFromCommand = (command: string) => {
	const cleaned = command.trim().replace(/^"+|"+$/g, "");
	const base = cleaned.split(/[\\/]/).pop() ?? cleaned;
	return base.replace(/\.(exe|app|lnk|bat|cmd)$/i, "") || "App";
};

const hostFromUrl = (url: string) => {
	try {
		return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
};

const fileIconCache = new Map<string, string | null>();

function LaunchAppCard({ command }: { command: string }) {
	// Icons are cached by command; the effect only fetches uncached ones and
	// bumps a counter when the async result lands, so the next render reads the
	// fresh icon straight from the cache (no setState in the effect body).
	const [, bump] = useState(0);

	useEffect(() => {
		if (!command || fileIconCache.has(command)) return;
		let active = true;
		window.atlas
			.getFileIcon(command)
			.then((value) => {
				fileIconCache.set(command, value);
				if (active) bump((n) => n + 1);
			})
			.catch(() => fileIconCache.set(command, null));
		return () => {
			active = false;
		};
	}, [command]);

	const icon = command ? (fileIconCache.get(command) ?? null) : null;

	return (
		<button
			type="button"
			disabled={!command}
			onClick={() => command && void window.atlas.launchApp(command)}
			className="flex h-full w-full items-center gap-3 px-1 text-left disabled:cursor-default"
		>
			<span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-neutral-100 dark:bg-neutral-700/60">
				{icon ? (
					<img src={icon} alt="" className="h-7 w-7" />
				) : (
					<RocketLaunchIcon className="h-6 w-6 text-neutral-500 dark:text-neutral-300" />
				)}
			</span>
			<span className="min-w-0">
				<span className="block truncate text-body-regular font-semibold text-neutral-800 dark:text-neutral-0">
					{command ? appNameFromCommand(command) : "Launch app"}
				</span>
				<span className="block text-[11px] text-neutral-500 dark:text-neutral-300">
					{command ? "Click to open" : "Set a program in edit mode"}
				</span>
			</span>
		</button>
	);
}

function OpenUrlCard({ url }: { url: string }) {
	return (
		<button
			type="button"
			disabled={!url}
			onClick={() => url && void window.atlas.launchApp(`start "" "${url}"`)}
			className="flex h-full w-full items-center gap-3 px-1 text-left disabled:cursor-default"
		>
			<span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-400/15 text-sky-500 dark:text-sky-300">
				<GlobeAltIcon className="h-6 w-6" />
			</span>
			<span className="min-w-0">
				<span className="flex items-center gap-1 truncate text-body-regular font-semibold text-neutral-800 dark:text-neutral-0">
					{url ? hostFromUrl(url) : "Open link"}
					{url && <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />}
				</span>
				<span className="block text-[11px] text-neutral-500 dark:text-neutral-300">
					{url ? "Click to open" : "Set a URL in edit mode"}
				</span>
			</span>
		</button>
	);
}

// Renders a single dashboard card's inner content. The surrounding .atlas-card
// frame (and any edit-mode chrome) is provided by DashboardGrid.
export function DashboardWidget({
	widget,
	data,
	config,
}: {
	widget: DashboardWidgetId;
	data: DashboardWidgetData;
	config?: string;
}) {
	const { dashboard, formatDuration } = data;

	switch (widget) {
		case "totalTimeToday":
			return (
				<div className="grid h-full content-center gap-2">
					<p className="m-0 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
						Total time today
					</p>
					<p className="m-0 font-data text-[clamp(32px,4vw,48px)] leading-none">
						{formatDuration(dashboard.totalTodayMs)}
					</p>
					<p className="m-0 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
						{data.activeSession ? `Live: ${data.activeElapsed}` : "No active session"}
					</p>
				</div>
			);

		case "quickStats":
			return (
				<>
					<CardHeader title="Quick stats" />
					<div className="stat-grid">
						<div>
							<span className="text-data-small">Sessions today</span>
							<strong className="text-body-regular font-semibold">
								{dashboard.quickStats.sessionsToday}
							</strong>
						</div>
						<div>
							<span className="text-data-small">Open tasks</span>
							<strong className="text-body-regular font-semibold">{dashboard.quickStats.openTasks}</strong>
						</div>
						<div>
							<span className="text-data-small">Current app</span>
							<strong className="text-body-regular font-semibold">
								{cleanAppLabel(data.currentAppName)}
							</strong>
						</div>
						<div>
							<span className="text-data-small">Current environment</span>
							<strong className="text-body-regular font-semibold">{data.selectedMapName}</strong>
						</div>
					</div>
				</>
			);

		case "sessionsToday":
			return <Stat value={dashboard.quickStats.sessionsToday} label="Sessions today" />;

		case "openTasks":
			return <Stat value={dashboard.quickStats.openTasks} label="Open tasks" />;

		case "currentApp":
			return <Stat value={cleanAppLabel(data.currentAppName)} label="Current app" />;

		case "currentEnvironment":
			return <Stat value={data.selectedMapName} label="Environment" />;

		case "topApp": {
			const top = [...dashboard.timePerApp].sort((a, b) => b.duration - a.duration)[0];
			return (
				<div className="grid h-full content-center gap-1">
					<span className="text-[12px] uppercase tracking-[0.1em] text-neutral-500 dark:text-neutral-300">
						Top app
					</span>
					<span className="truncate font-data text-[20px] font-semibold text-neutral-800 dark:text-neutral-0">
						{top ? cleanAppLabel(top.appName) : "No data yet"}
					</span>
					{top && (
						<span className="text-body-small text-neutral-500 dark:text-neutral-300">
							{formatDuration(top.duration)}
						</span>
					)}
				</div>
			);
		}

		case "timePerApp": {
			const totals = dashboard.timePerApp.reduce<Array<{ appName: string; duration: number }>>(
				(acc, entry) => {
					const appName = cleanAppLabel(entry.appName);
					const existing = acc.find((item) => item.appName === appName);
					if (existing) existing.duration += entry.duration;
					else acc.push({ appName, duration: entry.duration });
					return acc;
				},
				[],
			);
			totals.sort((a, b) => b.duration - a.duration);
			const top = totals[0]?.duration ?? 1;
			return (
				<>
					<CardHeader title="Time per app" />
					<div className="stack-list">
						{totals.map((entry, index) => (
							<div key={`${entry.appName}-${index}`}>
								<div className="stack-row text-body-small">
									<span>{entry.appName}</span>
									<span className="font-semibold">{formatDuration(entry.duration)}</span>
								</div>
								<div className="meter">
									<div style={{ width: `${Math.max(8, (entry.duration / top) * 100)}%` }} />
								</div>
							</div>
						))}
						{!totals.length && <p className="empty">No app data yet.</p>}
					</div>
				</>
			);
		}

		case "timePerEnvironment":
			return (
				<>
					<CardHeader title="Time per environment" />
					<ul className="simple-list">
						{dashboard.timePerMap.map((entry) => (
							<li key={entry.mapName}>
								<span className="text-body-small">{entry.mapName}</span>
								<strong className="text-body-small font-semibold">{formatDuration(entry.duration)}</strong>
							</li>
						))}
						{!dashboard.timePerMap.length && <li className="empty">No environment totals yet.</li>}
					</ul>
				</>
			);

		case "quickActions":
			return (
				<>
					<CardHeader title="Quick actions" />
					<div className="quick-actions">
						{data.quickActions.map((action) => (
							<button
								key={action.id}
								className="action-btn"
								onClick={() => data.onLaunchQuickAction(action.command)}
							>
								{action.label}
							</button>
						))}
						{!data.quickActions.length && <p className="empty">Add quick actions in Settings.</p>}
					</div>
				</>
			);

		case "taskProgress": {
			const lastColumn = data.statusColumns[data.statusColumns.length - 1];
			const total = data.tasks.length;
			const done = lastColumn ? data.tasks.filter((task) => task.status === lastColumn.status).length : 0;
			const ratio = total > 0 ? done / total : 0;
			return (
				<>
					<CardHeader title="Task progress" />
					<div className="grid content-center gap-2">
						<div className="flex items-baseline justify-between">
							<span className="font-data text-[24px] font-semibold text-neutral-800 dark:text-neutral-0">
								{done}/{total}
							</span>
							<span className="text-body-small text-neutral-500 dark:text-neutral-300">
								{lastColumn?.label.toLowerCase() ?? "done"}
							</span>
						</div>
						<div className="relative h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-600">
							<span
								className="absolute inset-y-0 left-0 bg-primary"
								style={{ width: `${Math.round(ratio * 100)}%` }}
							/>
						</div>
					</div>
				</>
			);
		}

		case "notesCount": {
			const words = data.notebook?.content?.trim() ? data.notebook.content.trim().split(/\s+/).length : 0;
			return <Stat value={words} label="Words in notebook" />;
		}

		case "activityTimeline": {
			const nowDate = new Date(data.now);
			const minutesSince = (date: Date) => date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
			const todaySessions = data.sessions.filter((session) => isToday(session.started_at, nowDate));
			const segments = todaySessions.map((session) => {
				const start = minutesSince(new Date(session.started_at));
				const end = minutesSince(session.ended_at ? new Date(session.ended_at) : nowDate);
				return {
					startPercent: (start / 1440) * 100,
					widthPercent: Math.max((end - start) / 1440, 0) * 100,
				};
			});
			const nowPercent = (minutesSince(nowDate) / 1440) * 100;
			return (
				<>
					<CardHeader title="Activity timeline" />
					<div className="grid content-center gap-1.5">
						<div className="relative h-4 w-full overflow-hidden rounded-md bg-neutral-200 dark:bg-neutral-600">
							{segments.map((segment, index) => (
								<span
									key={index}
									className="absolute top-0 h-full bg-primary"
									style={{
										left: `${segment.startPercent}%`,
										width: `${Math.max(segment.widthPercent, 0.4)}%`,
									}}
								/>
							))}
							<span
								className="absolute top-0 h-full w-px bg-neutral-700 dark:bg-neutral-100"
								style={{ left: `${nowPercent}%` }}
							/>
						</div>
						<div className="flex justify-between text-[10px] text-neutral-500 dark:text-neutral-300">
							<span>00:00</span>
							<span>06:00</span>
							<span>12:00</span>
							<span>18:00</span>
							<span>24:00</span>
						</div>
					</div>
				</>
			);
		}

		case "untrackedToday": {
			const midnight = new Date(data.now);
			midnight.setHours(0, 0, 0, 0);
			const untracked = Math.max(0, data.now - midnight.getTime() - dashboard.totalTodayMs);
			return <Stat value={formatDuration(untracked)} label="Untracked today" />;
		}

		case "avgSessionLength": {
			const count = dashboard.quickStats.sessionsToday;
			const avg = count > 0 ? dashboard.totalTodayMs / count : 0;
			return <Stat value={formatDuration(avg)} label="Avg session" />;
		}

		case "taskColumnsOverview": {
			const counts = data.statusColumns.map((column) => ({
				label: column.label,
				count: data.tasks.filter((task) => task.status === column.status).length,
			}));
			return (
				<>
					<CardHeader title="Task columns" />
					<ul className="simple-list">
						{counts.map((entry) => (
							<li key={entry.label}>
								<span className="text-body-small">{entry.label}</span>
								<strong className="text-body-small font-semibold">{entry.count}</strong>
							</li>
						))}
						{!counts.length && <li className="empty">No columns yet.</li>}
					</ul>
				</>
			);
		}

		case "upcomingTasks": {
			const lastColumn = data.statusColumns[data.statusColumns.length - 1];
			const upcoming = data.tasks
				.filter((task) => !lastColumn || task.status !== lastColumn.status)
				.slice(0, 5);
			return (
				<>
					<CardHeader title="Upcoming tasks" />
					<div className="stack-list">
						{upcoming.map((task) => (
							<div key={task.id} className="flex items-center gap-2 text-body-small">
								<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
								<span className="truncate">{task.title}</span>
							</div>
						))}
						{!upcoming.length && <p className="empty">Nothing queued up.</p>}
					</div>
				</>
			);
		}

		case "lastNote": {
			const snippet = data.notebook?.content?.trim() ?? "";
			return (
				<>
					<CardHeader title="Latest note" />
					<p className="m-0 line-clamp-4 text-body-small text-neutral-600 dark:text-neutral-300">
						{snippet ? snippet.slice(0, 240) : "No notes yet."}
					</p>
				</>
			);
		}

		case "clock": {
			const date = new Date(data.now);
			const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			return (
				<div className="grid h-full content-center gap-1">
					<span className="font-data text-[clamp(26px,3.4vw,40px)] font-semibold leading-none text-neutral-800 dark:text-neutral-0">
						{time}
					</span>
					<span className="text-[12px] uppercase tracking-[0.1em] text-neutral-500 dark:text-neutral-300">
						{date.toLocaleDateString([], { weekday: "long" })}
					</span>
				</div>
			);
		}

		case "date": {
			const date = new Date(data.now);
			return (
				<div className="grid h-full content-center gap-1">
					<span className="font-data text-[28px] font-semibold leading-none text-neutral-800 dark:text-neutral-0">
						{date.toLocaleDateString([], { day: "numeric", month: "short" })}
					</span>
					<span className="text-[12px] uppercase tracking-[0.1em] text-neutral-500 dark:text-neutral-300">
						{date.toLocaleDateString([], { weekday: "long" })}
					</span>
				</div>
			);
		}

		case "greeting": {
			const hour = new Date(data.now).getHours();
			const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
			return (
				<div className="grid h-full content-center gap-1">
					<span className="text-[20px] font-semibold text-neutral-800 dark:text-neutral-0">{part}</span>
					<span className="text-body-small text-neutral-500 dark:text-neutral-300">
						You're in {data.selectedMapName}
					</span>
				</div>
			);
		}

		case "launchApp":
			return <LaunchAppCard command={config ?? ""} />;

		case "openUrl":
			return <OpenUrlCard url={config ?? ""} />;

		default:
			return null;
	}
}
