import { useEffect, useMemo, useState } from "react";
import type { ActivityBlock, Session } from "../../types";
import type { MainContentViewsProps } from "./types";

type PeriodKey = "today" | "7d" | "30d" | "all";

type SessionStats = {
	session: Session;
	clockMs: number;
	focusMs: number;
	pausedMs: number;
};

const PERIOD_OPTIONS: Array<{ id: PeriodKey; label: string }> = [
	{ id: "today", label: "Vandaag" },
	{ id: "7d", label: "Laatste 7 dagen" },
	{ id: "30d", label: "Laatste 30 dagen" },
	{ id: "all", label: "Alles" },
];

const dutchDayFormatter = new Intl.DateTimeFormat("nl-NL", {
	weekday: "short",
	day: "2-digit",
	month: "2-digit",
});

const dutchDateTimeFormatter = new Intl.DateTimeFormat("nl-NL", {
	day: "2-digit",
	month: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
});

const toInputDate = (value: Date) => {
	const year = value.getFullYear();
	const month = `${value.getMonth() + 1}`.padStart(2, "0");
	const day = `${value.getDate()}`.padStart(2, "0");
	return `${year}-${month}-${day}`;
};

const toDayStartMs = (value: number) => {
	const date = new Date(value);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
};

const getPeriodStartMs = (period: PeriodKey, now: number) => {
	const dayStart = toDayStartMs(now);
	if (period === "today") {
		return dayStart;
	}
	if (period === "7d") {
		return dayStart - 6 * 24 * 60 * 60 * 1000;
	}
	if (period === "30d") {
		return dayStart - 29 * 24 * 60 * 60 * 1000;
	}
	return Number.NEGATIVE_INFINITY;
};

const formatPercent = (value: number) => `${Math.round(value)}%`;

const cleanAppLabel = (value: string) => {
	const cleaned = value
		.replace(/\s*\[[^\]]*\]\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return cleaned || "Unknown";
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
	sessionElapsedMs,
}: MainContentViewsProps) {
	const [blocksBySessionId, setBlocksBySessionId] = useState<Record<string, ActivityBlock[]>>({});
	const [isLoadingBlocks, setIsLoadingBlocks] = useState(false);
	const [activityError, setActivityError] = useState("");
	const [period, setPeriod] = useState<PeriodKey>("7d");

	useEffect(() => {
		if (!selectedSession) {
			return;
		}
		setBlocksBySessionId((current) => {
			const existing = current[selectedSession.id];
			if (existing && existing.length === activityBlocks.length) {
				return current;
			}
			return {
				...current,
				[selectedSession.id]: activityBlocks,
			};
		});
	}, [selectedSession, activityBlocks]);

	useEffect(() => {
		const missingSessionIds = sessions
			.map((session) => session.id)
			.filter((sessionId) => blocksBySessionId[sessionId] === undefined);

		if (!missingSessionIds.length) {
			setIsLoadingBlocks(false);
			return;
		}

		let cancelled = false;
		setIsLoadingBlocks(true);
		setActivityError("");

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
					setActivityError(
						"Kon activity-data niet volledig laden. Sommige resultaten kunnen onvolledig zijn.",
					);
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
	}, [sessions, blocksBySessionId]);

	const periodStartMs = useMemo(() => getPeriodStartMs(period, now), [period, now]);

	const sessionsInPeriod = useMemo(
		() =>
			sessions
				.filter((session) => new Date(session.started_at).getTime() >= periodStartMs)
				.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()),
		[sessions, periodStartMs],
	);

	const sessionStats = useMemo<SessionStats[]>(
		() =>
			sessionsInPeriod.map((session) => {
				const clockMs = session.is_active ? sessionElapsedMs(session, now) : session.total_duration;
				const pausedMs = Math.max(0, session.paused_duration);
				return {
					session,
					clockMs: Math.max(0, clockMs),
					pausedMs,
					focusMs: Math.max(0, clockMs - pausedMs),
				};
			}),
		[sessionsInPeriod, sessionElapsedMs, now],
	);

	const sessionIdSet = useMemo(() => new Set(sessionStats.map((entry) => entry.session.id)), [sessionStats]);

	const periodBlocks = useMemo(
		() =>
			Object.entries(blocksBySessionId)
				.filter(([sessionId]) => sessionIdSet.has(sessionId))
				.flatMap(([, blocks]) => blocks),
		[blocksBySessionId, sessionIdSet],
	);

	const totals = useMemo(() => {
		const totalClockMs = sessionStats.reduce((sum, entry) => sum + entry.clockMs, 0);
		const totalFocusMs = sessionStats.reduce((sum, entry) => sum + entry.focusMs, 0);
		const totalPausedMs = sessionStats.reduce((sum, entry) => sum + entry.pausedMs, 0);
		const averageSessionMs = sessionStats.length ? totalClockMs / sessionStats.length : 0;
		const activeDays = new Set(sessionStats.map((entry) => toInputDate(new Date(entry.session.started_at)))).size;
		const focusRatio = totalClockMs > 0 ? (totalFocusMs / totalClockMs) * 100 : 0;
		const pauseRatio = totalClockMs > 0 ? (totalPausedMs / totalClockMs) * 100 : 0;

		return {
			totalClockMs,
			totalFocusMs,
			totalPausedMs,
			averageSessionMs,
			activeDays,
			focusRatio,
			pauseRatio,
		};
	}, [sessionStats]);

	const topApps = useMemo(() => {
		const appTotals = new Map<string, number>();
		for (const block of periodBlocks) {
			const appName = cleanAppLabel(block.app_name);
			const durationMs = blockDurationMs(block, now);
			appTotals.set(appName, (appTotals.get(appName) ?? 0) + durationMs);
		}

		const rows = Array.from(appTotals.entries())
			.map(([appName, durationMs]) => ({ appName, durationMs }))
			.sort((a, b) => b.durationMs - a.durationMs)
			.slice(0, 6);

		const topDuration = rows[0]?.durationMs ?? 1;
		return { rows, topDuration };
	}, [periodBlocks, now]);

	const dailyFocus = useMemo(() => {
		const totalsByDay = new Map<string, number>();
		for (const entry of sessionStats) {
			const day = toInputDate(new Date(entry.session.started_at));
			totalsByDay.set(day, (totalsByDay.get(day) ?? 0) + entry.focusMs);
		}

		const rows = Array.from(totalsByDay.entries())
			.map(([day, focusMs]) => ({
				day,
				label: dutchDayFormatter.format(new Date(`${day}T00:00:00`)),
				focusMs,
			}))
			.sort((a, b) => a.day.localeCompare(b.day));

		const visibleRows = rows.slice(-10);
		const topFocusMs = visibleRows.reduce((max, row) => Math.max(max, row.focusMs), 0);
		return { rows: visibleRows, topFocusMs };
	}, [sessionStats]);

	const bestHourWindow = useMemo(() => {
		const bucketByHour = new Map<number, number>();
		for (const block of periodBlocks) {
			const startHour = new Date(block.started_at).getHours();
			const duration = blockDurationMs(block, now);
			bucketByHour.set(startHour, (bucketByHour.get(startHour) ?? 0) + duration);
		}

		const best = Array.from(bucketByHour.entries()).sort((a, b) => b[1] - a[1])[0];
		if (!best) {
			return "Nog niet genoeg data";
		}

		const [hour] = best;
		const start = `${String(hour).padStart(2, "0")}:00`;
		const end = `${String((hour + 1) % 24).padStart(2, "0")}:00`;
		return `${start} - ${end}`;
	}, [periodBlocks, now]);

	const insightItems = useMemo(() => {
		if (!sessionStats.length) {
			return [
				"Start met 1 korte sessie van 20 tot 30 minuten om je ritme op te bouwen.",
				"Open deze pagina na je eerste sessie; je ziet dan meteen je eerste inzichten.",
			];
		}

		const items: string[] = [];
		if (totals.focusRatio >= 75) {
			items.push(`Sterke focus: ${formatPercent(totals.focusRatio)} van je tijd was echt werktijd.`);
		} else if (totals.focusRatio >= 55) {
			items.push(`Goede basis: ${formatPercent(totals.focusRatio)} focus. Er is nog ruimte om te groeien.`);
		} else {
			items.push(
				`Je focus is nu ${formatPercent(totals.focusRatio)}. Probeer sessies op te delen in kortere blokken.`,
			);
		}

		if (topApps.rows[0]) {
			items.push(
				`Je meeste tijd ging naar ${topApps.rows[0].appName} (${formatDuration(topApps.rows[0].durationMs)}).`,
			);
		}

		items.push(`Je beste focusmoment ligt rond ${bestHourWindow}.`);

		if (totals.pauseRatio > 35) {
			items.push("Je pauzetijd is relatief hoog. Kortere, geplande pauzes kunnen helpen.");
		}

		return items.slice(0, 4);
	}, [sessionStats.length, totals.focusRatio, totals.pauseRatio, topApps.rows, formatDuration, bestHourWindow]);

	return (
		<div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden">
			<section className="atlas-card grid gap-3">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="grid gap-1">
						<h3 className="text-subtitle-small">Tijd Analyse</h3>
						<p className="text-body-small text-neutral-500 dark:text-neutral-300">
							Duidelijke inzichten in gewone taal: waar je tijd naartoe ging, wanneer je focus het sterkst
							was en wat je morgen meteen kunt verbeteren.
						</p>
					</div>
					<div className="flex flex-wrap gap-1.5">
						{PERIOD_OPTIONS.map((option) => (
							<button
								key={option.id}
								type="button"
								onClick={() => setPeriod(option.id)}
								className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition ${
									period === option.id
										? "border-primary/70 bg-primary/10 text-primary"
										: "border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-600 dark:text-neutral-300"
								}`}
							>
								{option.label}
							</button>
						))}
					</div>
				</div>

				{activityError ? <p className="text-[12px] text-amber-600">{activityError}</p> : null}
				{isLoadingBlocks ? <p className="text-[12px] text-neutral-500">Activiteit laden...</p> : null}
			</section>

			<div className="grid min-h-0 gap-3 overflow-auto pr-1">
				{!sessionStats.length ? (
					<section className="atlas-card">
						<p className="empty">
							Nog geen sessies in deze periode. Start een sessie en kom hier terug voor inzicht.
						</p>
					</section>
				) : (
					<>
						<section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
							<div className="atlas-card metric-card">
								<p className="card-kicker text-label-small">Focus tijd</p>
								<p className="metric-value text-title-small">{formatDuration(totals.totalFocusMs)}</p>
								<p className="metric-sub text-data-small">
									{formatPercent(totals.focusRatio)} van je totale tijd
								</p>
							</div>
							<div className="atlas-card metric-card">
								<p className="card-kicker text-label-small">Totale tijd</p>
								<p className="metric-value text-title-small">{formatDuration(totals.totalClockMs)}</p>
								<p className="metric-sub text-data-small">{sessionStats.length} sessies</p>
							</div>
							<div className="atlas-card metric-card">
								<p className="card-kicker text-label-small">Gemiddelde sessie</p>
								<p className="metric-value text-title-small">
									{formatDuration(totals.averageSessionMs)}
								</p>
								<p className="metric-sub text-data-small">{totals.activeDays} actieve dagen</p>
							</div>
							<div className="atlas-card metric-card">
								<p className="card-kicker text-label-small">Pauze tijd</p>
								<p className="metric-value text-title-small">{formatDuration(totals.totalPausedMs)}</p>
								<p className="metric-sub text-data-small">
									{formatPercent(totals.pauseRatio)} van je totale tijd
								</p>
							</div>
						</section>

						<section className="grid gap-3 xl:grid-cols-[1.25fr_1fr]">
							<div className="atlas-card grid gap-3">
								<header className="card-head">
									<h3 className="text-subtitle-small">Focus per dag</h3>
									<span className="text-data-small">Laatste {dailyFocus.rows.length} dagen</span>
								</header>
								<div className="grid gap-2">
									{dailyFocus.rows.map((row) => {
										const max = dailyFocus.topFocusMs || 1;
										const value = Math.max(0, row.focusMs);
										return (
											<div
												key={row.day}
												className="grid grid-cols-[90px_minmax(0,1fr)_auto] items-center gap-2"
											>
												<span className="text-data-small text-neutral-500 dark:text-neutral-300">
													{row.label}
												</span>
												<progress
													className="h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-[linear-gradient(90deg,#f97316,#dc2626,#7c3aed)] [&::-webkit-progress-bar]:bg-neutral-200 [&::-webkit-progress-value]:bg-[linear-gradient(90deg,#f97316,#dc2626,#7c3aed)] dark:[&::-webkit-progress-bar]:bg-neutral-700"
													max={max}
													value={value}
												/>
												<strong className="text-data-small">
													{formatDuration(row.focusMs)}
												</strong>
											</div>
										);
									})}
								</div>
							</div>

							<div className="atlas-card grid gap-3">
								<header className="card-head">
									<h3 className="text-subtitle-small">Top apps</h3>
									<span className="text-data-small">Waar je meeste tijd zat</span>
								</header>
								<div className="stack-list">
									{topApps.rows.map((entry) => (
										<div
											key={entry.appName}
											className="grid gap-1 rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-600 dark:bg-neutral-700"
										>
											<div className="stack-row text-body-small">
												<span className="truncate">{entry.appName}</span>
												<strong>{formatDuration(entry.durationMs)}</strong>
											</div>
											<progress
												className="h-1.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-[linear-gradient(90deg,#f97316,#dc2626,#7c3aed)] [&::-webkit-progress-bar]:bg-neutral-200 [&::-webkit-progress-value]:bg-[linear-gradient(90deg,#f97316,#dc2626,#7c3aed)] dark:[&::-webkit-progress-bar]:bg-neutral-700"
												max={topApps.topDuration || 1}
												value={Math.max(0, entry.durationMs)}
											/>
										</div>
									))}
									{!topApps.rows.length ? (
										<p className="empty">Nog geen app-data voor deze periode.</p>
									) : null}
								</div>
							</div>
						</section>

						<section className="grid gap-3 xl:grid-cols-[1fr_1fr]">
							<div className="atlas-card grid gap-2">
								<header className="card-head">
									<h3 className="text-subtitle-small">Snelle samenvatting</h3>
									<span className="text-data-small">Zonder technische details</span>
								</header>
								<div className="grid gap-1.5">
									{insightItems.map((item) => (
										<div
											key={item}
											className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-body-small dark:border-neutral-600 dark:bg-neutral-700"
										>
											{item}
										</div>
									))}
								</div>
							</div>

							<div className="atlas-card grid gap-2">
								<header className="card-head">
									<h3 className="text-subtitle-small">Geselecteerde sessie</h3>
									<span className="text-data-small">
										{selectedSession
											? dutchDateTimeFormatter.format(new Date(selectedSession.started_at))
											: "Selecteer in Logbook een sessie"}
									</span>
								</header>
								{selectedSession ? (
									<div className="grid gap-2">
										<div className="rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-600 dark:bg-neutral-700">
											<div className="stack-row text-body-small">
												<span>Duur</span>
												<strong>
													{formatDuration(
														selectedSession.is_active
															? sessionElapsedMs(selectedSession, now)
															: selectedSession.total_duration,
													)}
												</strong>
											</div>
											<div className="stack-row text-data-small text-neutral-500 dark:text-neutral-300">
												<span>Pauze</span>
												<span>{formatDuration(selectedSession.paused_duration)}</span>
											</div>
										</div>
										<div className="rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 text-data-small dark:border-neutral-600 dark:bg-neutral-700">
											{activityBlocks.length
												? `Aantal activiteitblokken: ${activityBlocks.length}`
												: "Nog geen activiteitblokken beschikbaar voor deze sessie."}
										</div>
									</div>
								) : (
									<p className="empty">Open in Logbook een sessie om hier details te zien.</p>
								)}
							</div>
						</section>
					</>
				)}
			</div>
		</div>
	);
}
