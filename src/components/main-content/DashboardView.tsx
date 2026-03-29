import type { MainContentViewsProps } from "./types";

const cleanAppLabel = (value: string) => {
	const cleaned = value
		.replace(/\s*\[[^\]]*\]\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return cleaned || "Unknown";
};

export function DashboardView({
	dashboard,
	activeSession,
	activeElapsed,
	currentAppName,
	selectedMapName,
	quickActions,
	onLaunchQuickAction,
	formatDuration,
}: MainContentViewsProps) {
	const appTotals = dashboard.timePerApp.reduce<Array<{ appName: string; duration: number }>>((acc, entry) => {
		const appName = cleanAppLabel(entry.appName);
		const existing = acc.find((item) => item.appName === appName);
		if (existing) {
			existing.duration += entry.duration;
			return acc;
		}
		acc.push({ appName, duration: entry.duration });
		return acc;
	}, []);
	appTotals.sort((a, b) => b.duration - a.duration);
	const topDuration = appTotals[0]?.duration ?? 1;

	return (
		<div className="view-grid">
			<section className="atlas-card grid gap-2">
				<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
					Total time today
				</p>
				<p className="m-0 font-data text-[clamp(36px,5vw,52px)] leading-none">
					{formatDuration(dashboard.totalTodayMs)}
				</p>
				<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
					{activeSession ? `Live: ${activeElapsed}` : "No active session"}
				</p>
			</section>

			<section className="atlas-card">
				<header className="card-head">
					<h3 className="text-subtitle-small">Quick stats</h3>
				</header>
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
						<strong className="text-body-regular font-semibold">{cleanAppLabel(currentAppName)}</strong>
					</div>
					<div>
						<span className="text-data-small">Current map</span>
						<strong className="text-body-regular font-semibold">{selectedMapName}</strong>
					</div>
				</div>
			</section>

			<section className="atlas-card">
				<header className="card-head">
					<h3 className="text-subtitle-small">Time per app</h3>
				</header>
				<div className="stack-list">
					{appTotals.map((entry, index) => (
						<div key={`${entry.appName}-${index}`}>
							<div className="stack-row text-body-small">
								<span>{entry.appName}</span>
								<span className="font-semibold">{formatDuration(entry.duration)}</span>
							</div>
							<div className="meter">
								<div style={{ width: `${Math.max(8, (entry.duration / topDuration) * 100)}%` }} />
							</div>
						</div>
					))}
					{!dashboard.timePerApp.length && <p className="empty">No app data yet.</p>}
				</div>
			</section>

			<section className="atlas-card">
				<header className="card-head">
					<h3 className="text-subtitle-small">Time per map</h3>
				</header>
				<ul className="simple-list">
					{dashboard.timePerMap.map((entry) => (
						<li key={entry.mapName}>
							<span className="text-body-small">{entry.mapName}</span>
							<strong className="text-body-small font-semibold">{formatDuration(entry.duration)}</strong>
						</li>
					))}
					{!dashboard.timePerMap.length && <li className="empty">No map totals yet.</li>}
				</ul>
			</section>

			<section className="atlas-card">
				<header className="card-head">
					<h3 className="text-subtitle-small">Quick actions</h3>
				</header>
				<div className="quick-actions">
					{quickActions.map((action) => (
						<button
							key={action.id}
							className="action-btn"
							onClick={() => onLaunchQuickAction(action.command)}
						>
							{action.label}
						</button>
					))}
					{!quickActions.length && <p className="empty">Add quick actions in Settings.</p>}
				</div>
			</section>
		</div>
	);
}
