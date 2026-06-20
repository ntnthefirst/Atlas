import { useEffect, useMemo, useState } from "react";
import type { ActivityBlock } from "../../types";
import type { MainContentViewsProps } from "./types";

type ActivityViewMode = "apps" | "windows";

const formatPercent = (value: number) => `${Math.round(value)}%`;

const cleanAppLabel = (value: string) => {
	const cleaned = value
		.replace(/\s*\[[^\]]*\]\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return cleaned || "Unknown";
};

const KNOWN_APP_NAMES = new Map<string, string>([
	["figma", "Figma"],
	["chrome", "Google Chrome"],
	["msedge", "Microsoft Edge"],
	["edge", "Microsoft Edge"],
	["firefox", "Firefox"],
	["code", "VS Code"],
	["vscode", "VS Code"],
	["spotify", "Spotify"],
	["discord", "Discord"],
	["notion", "Notion"],
	["slack", "Slack"],
	["teams", "Microsoft Teams"],
	["explorer", "File Explorer"],
	["obsidian", "Obsidian"],
	["postman", "Postman"],
	["atlas", "Atlas"],
]);

const normalizeAppNameFromWindowLabel = (value: string) => {
	const cleaned = cleanAppLabel(value);
	const lowered = cleaned.toLowerCase();

	for (const [needle, canonical] of KNOWN_APP_NAMES) {
		if (lowered === needle || lowered.includes(` ${needle}`) || lowered.includes(`${needle} `)) {
			return canonical;
		}
	}

	const parts = cleaned
		.split(/\s[-|\u2014\u2013\u00b7]\s/g)
		.map((part) => part.trim())
		.filter(Boolean);

	if (parts.length > 1) {
		const firstPart = parts[0];
		const lastPart = parts[parts.length - 1];
		const firstWords = firstPart.split(/\s+/).length;
		const lastWords = lastPart.split(/\s+/).length;

		if (lastWords <= 3) {
			return lastPart;
		}
		if (firstWords <= 3) {
			return firstPart;
		}
	}

	return cleaned;
};

const blockDurationMs = (block: ActivityBlock, now: number) => {
	if (block.ended_at) {
		return Math.max(0, block.duration);
	}
	return Math.max(0, now - new Date(block.started_at).getTime());
};

export function AnalysisView({
	sessions,
	selectedSession,
	activityBlocks,
	now,
	formatDuration,
	filteredSessionStats = [],
}: MainContentViewsProps) {
	const [blocksBySessionId, setBlocksBySessionId] = useState<Record<string, ActivityBlock[]>>({});
	const [isLoadingBlocks, setIsLoadingBlocks] = useState(false);
	const [activityError, setActivityError] = useState("");
	const [isTopMode, setIsTopMode] = useState(true);
	const [activityViewMode, setActivityViewMode] = useState<ActivityViewMode>("apps");
	const [isAppsSortAscending, setIsAppsSortAscending] = useState(false);

	const resolvedBlocksBySessionId = useMemo(() => {
		if (!selectedSession) {
			return blocksBySessionId;
		}

		return {
			...blocksBySessionId,
			[selectedSession.id]: activityBlocks,
		};
	}, [blocksBySessionId, selectedSession, activityBlocks]);

	useEffect(() => {
		const missingSessionIds = sessions
			.map((session) => session.id)
			.filter((sessionId) => resolvedBlocksBySessionId[sessionId] === undefined);

		if (!missingSessionIds.length) {
			queueMicrotask(() => {
				setIsLoadingBlocks(false);
			});
			return;
		}

		let cancelled = false;
		queueMicrotask(() => {
			setIsLoadingBlocks(true);
			setActivityError("");
		});

		void Promise.all(
			missingSessionIds.map(async (sessionId) => ({
				sessionId,
				blocks: await window.atlas.listActivityBySession(sessionId),
			})),
		)
			.then((results) => {
				if (cancelled) {
					return;
				}
				setBlocksBySessionId((current) => {
					const next = { ...current };
					for (const result of results) {
						next[result.sessionId] = result.blocks;
					}
					return next;
				});
			})
			.catch(() => {
				if (!cancelled) {
					setActivityError("Could not load activity data completely. Some results may be incomplete.");
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingBlocks(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [sessions, resolvedBlocksBySessionId]);

	const filteredSessionIds = useMemo(
		() => new Set(filteredSessionStats.map((entry) => entry.session.id)),
		[filteredSessionStats],
	);

	const filteredBlocks = useMemo(
		() =>
			Object.entries(resolvedBlocksBySessionId)
				.filter(([sessionId]) => filteredSessionIds.has(sessionId))
				.flatMap(([, blocks]) => blocks),
		[resolvedBlocksBySessionId, filteredSessionIds],
	);

	const totals = useMemo(() => {
		const totalClockMs = filteredSessionStats.reduce((sum, entry) => sum + entry.clockMs, 0);
		const totalFocusMs = filteredSessionStats.reduce((sum, entry) => sum + entry.focusMs, 0);
		const averageSessionMs = filteredSessionStats.length ? totalClockMs / filteredSessionStats.length : 0;
		const activeDays = new Set(filteredSessionStats.map((entry) => new Date(entry.session.started_at).toDateString())).size;
		const focusRatio = totalClockMs > 0 ? (totalFocusMs / totalClockMs) * 100 : 0;

		return {
			totalClockMs,
			totalFocusMs,
			averageSessionMs,
			activeDays,
			focusRatio,
		};
	}, [filteredSessionStats]);

	const windowRows = useMemo(() => {
		const windowTotals = new Map<string, number>();
		for (const block of filteredBlocks) {
			const windowName = cleanAppLabel(block.app_name);
			const durationMs = blockDurationMs(block, now);
			windowTotals.set(windowName, (windowTotals.get(windowName) ?? 0) + durationMs);
		}

		return Array.from(windowTotals.entries()).map(([name, durationMs]) => ({ name, durationMs }));
	}, [filteredBlocks, now]);

	const appRows = useMemo(() => {
		const appTotals = new Map<string, number>();
		for (const block of filteredBlocks) {
			const appName = normalizeAppNameFromWindowLabel(block.app_name);
			const durationMs = blockDurationMs(block, now);
			appTotals.set(appName, (appTotals.get(appName) ?? 0) + durationMs);
		}

		return Array.from(appTotals.entries()).map(([name, durationMs]) => ({ name, durationMs }));
	}, [filteredBlocks, now]);

	const activityRows = useMemo(
		() => (activityViewMode === "apps" ? appRows : windowRows),
		[activityViewMode, appRows, windowRows],
	);

	const appRowsSorted = useMemo(
		() =>
			activityRows
				.slice()
				.sort((a, b) => (isAppsSortAscending ? a.durationMs - b.durationMs : b.durationMs - a.durationMs)),
		[activityRows, isAppsSortAscending],
	);

	const visibleAppRows = useMemo(
		() => (isTopMode ? appRowsSorted.slice(0, 6) : appRowsSorted),
		[isTopMode, appRowsSorted],
	);

	const totalSelectedAppsDuration = useMemo(
		() => activityRows.reduce((sum, entry) => sum + entry.durationMs, 0),
		[activityRows],
	);

	const totalDistributableDuration = useMemo(() => Math.max(0, totals.totalClockMs), [totals.totalClockMs]);

	const untrackedDurationMs = useMemo(
		() => Math.max(0, totalDistributableDuration - totalSelectedAppsDuration),
		[totalDistributableDuration, totalSelectedAppsDuration],
	);

	const displayRows = useMemo(() => {
		const rows = [...visibleAppRows];
		if (untrackedDurationMs > 0) {
			rows.push({
				name: "Untracked",
				durationMs: untrackedDurationMs,
			});
		}
		return rows;
	}, [visibleAppRows, untrackedDurationMs]);

	return (
		<div className="grid h-full min-h-0 content-start gap-3 overflow-hidden">
			<div className="grid min-h-0 content-start gap-3 overflow-auto pr-1">
				{activityError ? <p className="text-[12px] text-amber-600">{activityError}</p> : null}
				{isLoadingBlocks ? (
					<p className="text-[12px] text-neutral-500">Loading activity...</p>
				) : null}

				<section className="grid grid-cols-3 items-start gap-3">
					<div className="atlas-card grid gap-2">
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							Focus time
						</p>
						<p className="m-0 font-data text-[clamp(36px,5vw,52px)] leading-none">
							{formatDuration(totals.totalFocusMs)}
						</p>
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							{formatPercent(totals.focusRatio)} of your total time
						</p>
					</div>
					<div className="atlas-card grid gap-2">
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							Total time
						</p>
						<p className="m-0 font-data text-[clamp(36px,5vw,52px)] leading-none">
							{formatDuration(totals.totalClockMs)}
						</p>
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							{filteredSessionStats.length} sessions
						</p>
					</div>
					<div className="atlas-card grid gap-2">
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							Average session
						</p>
						<p className="m-0 font-data text-[clamp(36px,5vw,52px)] leading-none">
							{formatDuration(totals.averageSessionMs)}
						</p>
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							{totals.activeDays} active days
						</p>
					</div>
				</section>

				<section className="atlas-card grid gap-3">
					<header className="card-head">
						<div className="flex items-center gap-2">
							<div className="inline-flex rounded-full border border-neutral-200 p-1 dark:border-neutral-600">
								<button
									type="button"
									onClick={() => setIsTopMode(true)}
									className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] transition ${
										isTopMode
											? "bg-primary/10 text-primary"
											: "text-neutral-500 hover:text-neutral-700 dark:text-neutral-300 dark:hover:text-neutral-100"
									}`}
								>
									Top
								</button>
								<button
									type="button"
									onClick={() => setIsTopMode(false)}
									className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] transition ${
										!isTopMode
											? "bg-primary/10 text-primary"
											: "text-neutral-500 hover:text-neutral-700 dark:text-neutral-300 dark:hover:text-neutral-100"
									}`}
								>
									All
								</button>
							</div>
							<div className="inline-flex rounded-full border border-neutral-200 p-1 dark:border-neutral-600">
								<button
									type="button"
									onClick={() => setActivityViewMode("apps")}
									className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] transition ${
										activityViewMode === "apps"
											? "bg-primary/10 text-primary"
											: "text-neutral-500 hover:text-neutral-700 dark:text-neutral-300 dark:hover:text-neutral-100"
									}`}
								>
									Apps
								</button>
								<button
									type="button"
									onClick={() => setActivityViewMode("windows")}
									className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] transition ${
										activityViewMode === "windows"
											? "bg-primary/10 text-primary"
											: "text-neutral-500 hover:text-neutral-700 dark:text-neutral-300 dark:hover:text-neutral-100"
									}`}
								>
									Windows
								</button>
							</div>
						</div>
						{!isTopMode ? (
							<button
								type="button"
								onClick={() => setIsAppsSortAscending((current) => !current)}
								className="rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500 transition hover:border-neutral-300 hover:text-neutral-700 dark:border-neutral-600 dark:text-neutral-300 dark:hover:text-neutral-100"
							>
								{isAppsSortAscending ? "Ascending" : "Descending"}
							</button>
						) : (
							<span className="text-data-small">Based on your current calendar selection</span>
						)}
					</header>
					<div className="stack-list">
						{displayRows.map((entry) => (
							<div
								key={entry.name}
								className="grid gap-1 rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-600 dark:bg-neutral-700"
							>
								<div className="stack-row text-body-small">
									<span className="truncate">{entry.name}</span>
									<strong>
										{formatDuration(entry.durationMs)} (
										{formatPercent((entry.durationMs / (totalDistributableDuration || 1)) * 100)})
									</strong>
								</div>
								<progress
									className="h-1.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-neutral-700 [&::-webkit-progress-bar]:bg-neutral-200 [&::-webkit-progress-value]:bg-neutral-700 dark:[&::-webkit-progress-bar]:bg-neutral-600 dark:[&::-webkit-progress-value]:bg-neutral-100"
									max={totalDistributableDuration || 1}
									value={Math.max(0, entry.durationMs)}
								/>
							</div>
						))}
						{!displayRows.length ? (
							<p className="empty">
								No {activityViewMode === "apps" ? "app" : "window"} data for this selection yet.
							</p>
						) : null}
					</div>
				</section>
			</div>
		</div>
	);
}
