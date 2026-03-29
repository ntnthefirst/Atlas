import { useEffect, useMemo, useState } from "react";
import type { ActivityBlock, Session } from "../../types";
import type { MainContentViewsProps } from "./types";

type AnalysisWindow = "7d" | "14d" | "30d" | "all" | "custom";
type DurationMode = "clock" | "focus";

const dutchDateShortFormatter = new Intl.DateTimeFormat("nl-NL", {
	day: "2-digit",
	month: "short",
});

const dutchDateLongFormatter = new Intl.DateTimeFormat("nl-NL", {
	weekday: "long",
	day: "numeric",
	month: "long",
});

const cleanAppLabel = (value: string) => {
	const cleaned = value
		.replace(/\s*\[[^\]]*\]\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return cleaned || "Unknown";
};

const toInputDate = (value: Date) => {
	const year = value.getFullYear();
	const month = `${value.getMonth() + 1}`.padStart(2, "0");
	const day = `${value.getDate()}`.padStart(2, "0");
	return `${year}-${month}-${day}`;
};

const startOfLocalDay = (value: Date) => {
	const start = new Date(value);
	start.setHours(0, 0, 0, 0);
	return start;
};

const endOfLocalDay = (value: Date) => {
	const end = new Date(value);
	end.setHours(23, 59, 59, 999);
	return end;
};

const durationForSession = (
	session: Session,
	now: number,
	mode: DurationMode,
	sessionElapsedMs: (session: Session, now: number) => number,
) => {
	const clockMs = session.is_active ? sessionElapsedMs(session, now) : session.total_duration;
	if (mode === "clock") {
		return Math.max(0, clockMs);
	}
	return Math.max(0, clockMs - session.paused_duration);
};

const blockDurationMs = (block: ActivityBlock, now: number) => {
	if (block.ended_at) {
		return Math.max(0, block.duration);
	}
	return Math.max(0, now - new Date(block.started_at).getTime());
};

const appColor = (index: number) => {
	const palette = [
		"#f97316",
		"#dc2626",
		"#7c3aed",
		"#2563eb",
		"#0891b2",
		"#16a34a",
		"#d97706",
		"#db2777",
		"#0f766e",
		"#4f46e5",
	];
	return palette[index % palette.length];
};

export function AnalysisView({
	sessions,
	selectedSession,
	activityBlocks,
	now,
	formatDuration,
	sessionElapsedMs,
}: MainContentViewsProps) {
	const nowDate = useMemo(() => new Date(now), [now]);
	const [windowSize, setWindowSize] = useState<AnalysisWindow>("7d");
	const [customStartDate, setCustomStartDate] = useState(() => {
		const start = new Date();
		start.setDate(start.getDate() - 6);
		return toInputDate(start);
	});
	const [customEndDate, setCustomEndDate] = useState(() => toInputDate(new Date()));
	const [durationMode, setDurationMode] = useState<DurationMode>("focus");
	const [minimumBlockMinutes, setMinimumBlockMinutes] = useState(1);
	const [topAppsLimit, setTopAppsLimit] = useState(8);
	const [blocksBySessionId, setBlocksBySessionId] = useState<Record<string, ActivityBlock[]>>({});
	const [isLoadingBlocks, setIsLoadingBlocks] = useState(false);
	const [activityError, setActivityError] = useState("");

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

	const rangeMs = useMemo(() => {
		if (windowSize === "all") {
			return { startMs: Number.NEGATIVE_INFINITY, endMs: Number.POSITIVE_INFINITY };
		}

		if (windowSize === "custom") {
			const safeStart = customStartDate ? startOfLocalDay(new Date(customStartDate)) : startOfLocalDay(nowDate);
			const safeEnd = customEndDate ? endOfLocalDay(new Date(customEndDate)) : endOfLocalDay(nowDate);
			const startMs = Math.min(safeStart.getTime(), safeEnd.getTime());
			const endMs = Math.max(safeStart.getTime(), safeEnd.getTime());
			return { startMs, endMs };
		}

		const days = windowSize === "14d" ? 14 : windowSize === "30d" ? 30 : 7;
		const end = endOfLocalDay(nowDate).getTime();
		const startDate = startOfLocalDay(nowDate);
		startDate.setDate(startDate.getDate() - (days - 1));
		return { startMs: startDate.getTime(), endMs: end };
	}, [windowSize, customStartDate, customEndDate, nowDate]);

	const sessionsInRange = useMemo(
		() =>
			sessions.filter((session) => {
				const startedAtMs = new Date(session.started_at).getTime();
				return startedAtMs >= rangeMs.startMs && startedAtMs <= rangeMs.endMs;
			}),
		[sessions, rangeMs],
	);

	useEffect(() => {
		const missingSessionIds = sessionsInRange
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
						"Kon activity-data niet volledig laden. Probeer opnieuw door van periode te wisselen.",
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
	}, [sessionsInRange, blocksBySessionId]);

	const analytics = useMemo(() => {
		const perDay = new Map<string, { label: string; duration: number; dateMs: number }>();
		let totalDuration = 0;

		for (const session of sessionsInRange) {
			const startedAt = new Date(session.started_at);
			const key = toInputDate(startedAt);
			const sessionDuration = durationForSession(session, now, durationMode, sessionElapsedMs);
			totalDuration += sessionDuration;

			const current = perDay.get(key);
			if (current) {
				current.duration += sessionDuration;
				continue;
			}

			perDay.set(key, {
				label: dutchDateShortFormatter.format(startedAt),
				duration: sessionDuration,
				dateMs: startOfLocalDay(startedAt).getTime(),
			});
		}

		const dailyRows = Array.from(perDay.entries())
			.map(([dayKey, value]) => ({
				dayKey,
				label: value.label,
				duration: value.duration,
				dateMs: value.dateMs,
			}))
			.sort((a, b) => b.dateMs - a.dateMs);

		const distinctDays = Math.max(1, dailyRows.length);
		const averagePerDay = totalDuration / distinctDays;
		const mostProductiveDay = dailyRows.reduce<{ dayKey: string; label: string; duration: number } | null>(
			(best, row) => {
				if (!best || row.duration > best.duration) {
					return { dayKey: row.dayKey, label: row.label, duration: row.duration };
				}
				return best;
			},
			null,
		);

		const minBlockMs = Math.max(0, minimumBlockMinutes * 60_000);
		const appTotals = new Map<string, number>();
		for (const session of sessionsInRange) {
			const blocks = blocksBySessionId[session.id] ?? [];
			for (const block of blocks) {
				const durationMs = blockDurationMs(block, now);
				if (durationMs < minBlockMs) {
					continue;
				}
				const appName = cleanAppLabel(block.app_name);
				const previous = appTotals.get(appName) ?? 0;
				appTotals.set(appName, previous + durationMs);
			}
		}

		const topApps = Array.from(appTotals.entries())
			.map(([appName, duration]) => ({ appName, duration }))
			.sort((a, b) => b.duration - a.duration)
			.slice(0, Math.max(1, topAppsLimit));

		return {
			totalDuration,
			averagePerDay,
			mostProductiveDay,
			dailyRows,
			topApps,
			totalSessions: sessionsInRange.length,
		};
	}, [sessionsInRange, now, durationMode, sessionElapsedMs, minimumBlockMinutes, blocksBySessionId, topAppsLimit]);

	const maxDaily = analytics.dailyRows[0]?.duration ?? 1;
	const maxAppDuration = analytics.topApps[0]?.duration ?? 1;

	return (
		<div className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3">
			<section className="atlas-card grid gap-3">
				<header className="card-head mb-0">
					<h3 className="text-subtitle-small">Analyse instellingen</h3>
					<span className="text-data-small">Kies je parameters en bekijk trends</span>
				</header>

				<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
					<label className="grid gap-1.5">
						<span className="text-data-small">Periode</span>
						<select
							value={windowSize}
							onChange={(event) => setWindowSize(event.target.value as AnalysisWindow)}
						>
							<option value="7d">Laatste 7 dagen</option>
							<option value="14d">Laatste 14 dagen</option>
							<option value="30d">Laatste 30 dagen</option>
							<option value="all">Alle sessies</option>
							<option value="custom">Custom bereik</option>
						</select>
					</label>

					<label className="grid gap-1.5">
						<span className="text-data-small">Uren berekenen op</span>
						<select
							value={durationMode}
							onChange={(event) => setDurationMode(event.target.value as DurationMode)}
						>
							<option value="focus">Focus time (pauzes eruit)</option>
							<option value="clock">Clock time (volledige sessie)</option>
						</select>
					</label>

					<label className="grid gap-1.5">
						<span className="text-data-small">Min. blokduur (min)</span>
						<input
							type="number"
							min={0}
							max={180}
							value={minimumBlockMinutes}
							onChange={(event) => setMinimumBlockMinutes(Math.max(0, Number(event.target.value) || 0))}
						/>
					</label>

					<label className="grid gap-1.5">
						<span className="text-data-small">Top apps</span>
						<input
							type="number"
							min={1}
							max={20}
							value={topAppsLimit}
							onChange={(event) => setTopAppsLimit(Math.max(1, Number(event.target.value) || 1))}
						/>
					</label>
				</div>

				{windowSize === "custom" ? (
					<div className="grid gap-3 md:grid-cols-2">
						<label className="grid gap-1.5">
							<span className="text-data-small">Startdatum</span>
							<input
								type="date"
								value={customStartDate}
								onChange={(event) => setCustomStartDate(event.target.value)}
							/>
						</label>
						<label className="grid gap-1.5">
							<span className="text-data-small">Einddatum</span>
							<input
								type="date"
								value={customEndDate}
								onChange={(event) => setCustomEndDate(event.target.value)}
							/>
						</label>
					</div>
				) : null}
			</section>

			<section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
				<article className="atlas-card">
					<p className="card-kicker text-label-small">Totaal gewerkt</p>
					<p className="metric-value text-title-small">{formatDuration(analytics.totalDuration)}</p>
					<p className="metric-sub text-data-small">Binnen geselecteerde periode</p>
				</article>
				<article className="atlas-card">
					<p className="card-kicker text-label-small">Gemiddeld per dag</p>
					<p className="metric-value text-title-small">{formatDuration(analytics.averagePerDay)}</p>
					<p className="metric-sub text-data-small">Gebaseerd op actieve dagen</p>
				</article>
				<article className="atlas-card">
					<p className="card-kicker text-label-small">Productiefste dag</p>
					<p className="metric-value text-title-small">
						{analytics.mostProductiveDay ? formatDuration(analytics.mostProductiveDay.duration) : "-"}
					</p>
					<p className="metric-sub text-data-small">
						{analytics.mostProductiveDay
							? dutchDateLongFormatter.format(new Date(analytics.mostProductiveDay.dayKey))
							: "Nog geen data"}
					</p>
				</article>
				<article className="atlas-card">
					<p className="card-kicker text-label-small">Sessies in bereik</p>
					<p className="metric-value text-title-small">{analytics.totalSessions}</p>
					<p className="metric-sub text-data-small">Alleen sessies binnen gekozen periode</p>
				</article>
			</section>

			<div className="grid min-h-0 gap-3 xl:grid-cols-[1.15fr_1fr]">
				<section className="atlas-card grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
					<header className="card-head">
						<h3 className="text-subtitle-small">Uren per dag</h3>
						<span className="text-data-small">{analytics.dailyRows.length} dagen met data</span>
					</header>
					<div className="stack-list min-h-0 overflow-auto pr-1">
						{analytics.dailyRows.map((row) => {
							const percent = maxDaily > 0 ? (row.duration / maxDaily) * 100 : 0;
							return (
								<div
									key={row.dayKey}
									className="grid gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-600 dark:bg-neutral-700"
								>
									<div className="stack-row">
										<span className="text-body-small">{row.label}</span>
										<strong className="text-data-small">{formatDuration(row.duration)}</strong>
									</div>
									<div className="meter">
										<div style={{ width: `${percent}%` }} />
									</div>
								</div>
							);
						})}
						{!analytics.dailyRows.length && <p className="empty">Geen sessies in de gekozen periode.</p>}
					</div>
				</section>

				<section className="atlas-card grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
					<header className="card-head">
						<h3 className="text-subtitle-small">Top apps</h3>
						<span className="text-data-small">Vanaf {minimumBlockMinutes} min per block</span>
					</header>
					<div className="stack-list min-h-0 overflow-auto pr-1">
						{isLoadingBlocks ? <p className="empty">Activity-data wordt geladen...</p> : null}
						{activityError ? <p className="error-banner">{activityError}</p> : null}
						{analytics.topApps.map((entry, index) => {
							const percent = maxAppDuration > 0 ? (entry.duration / maxAppDuration) * 100 : 0;
							return (
								<div
									key={entry.appName}
									className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-600 dark:bg-neutral-700"
								>
									<div className="grid gap-1.5">
										<div className="flex items-center gap-2">
											<span
												className="h-2.5 w-2.5 rounded-full"
												style={{ backgroundColor: appColor(index) }}
											/>
											<span className="text-body-small truncate">{entry.appName}</span>
										</div>
										<div className="meter">
											<div
												style={{
													width: `${percent}%`,
													background: `linear-gradient(90deg, ${appColor(index)}, color-mix(in srgb, ${appColor(index)} 72%, #ffffff 28%))`,
												}}
											/>
										</div>
									</div>
									<strong className="text-data-small whitespace-nowrap">
										{formatDuration(entry.duration)}
									</strong>
								</div>
							);
						})}
						{!isLoadingBlocks && !analytics.topApps.length ? (
							<p className="empty">
								Geen app-data met deze filters. Zet min. blokduur lager of kies langere periode.
							</p>
						) : null}
					</div>
				</section>
			</div>
		</div>
	);
}
