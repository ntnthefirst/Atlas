import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CalendarDaysIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityBlock, Session } from "../../types";
import type { MainContentViewsProps } from "./types";

type SessionStats = {
	session: Session;
	clockMs: number;
	focusMs: number;
};

const dutchMonthYearFormatter = new Intl.DateTimeFormat("nl-NL", {
	month: "long",
	year: "numeric",
});

const dutchHourFormatter = new Intl.NumberFormat("nl-NL", {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
});

const WEEKDAY_LABELS = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];
const MONTH_OPTIONS = [
	"januari",
	"februari",
	"maart",
	"april",
	"mei",
	"juni",
	"juli",
	"augustus",
	"september",
	"oktober",
	"november",
	"december",
];

const toInputDate = (value: Date) => {
	const year = value.getFullYear();
	const month = `${value.getMonth() + 1}`.padStart(2, "0");
	const day = `${value.getDate()}`.padStart(2, "0");
	return `${year}-${month}-${day}`;
};

const toMonthStart = (value: Date) => new Date(value.getFullYear(), value.getMonth(), 1);

const formatPercent = (value: number) => `${Math.round(value)}%`;

const formatHours = (valueMs: number) => `${dutchHourFormatter.format(valueMs / 3_600_000)}u`;

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
	const [selectedStartDay, setSelectedStartDay] = useState<string | null>(null);
	const [selectedEndDay, setSelectedEndDay] = useState<string | null>(null);
	const [displayedMonth, setDisplayedMonth] = useState(() => toMonthStart(new Date(now)));
	const [monthDropdownOpen, setMonthDropdownOpen] = useState(false);
	const [yearDropdownOpen, setYearDropdownOpen] = useState(false);
	const monthDropdownRef = useRef<HTMLDivElement | null>(null);
	const yearDropdownRef = useRef<HTMLDivElement | null>(null);

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
	}, [sessions, resolvedBlocksBySessionId]);

	useEffect(() => {
		const onPointerDown = (event: MouseEvent) => {
			const target = event.target as Node;
			if (monthDropdownRef.current && !monthDropdownRef.current.contains(target)) {
				setMonthDropdownOpen(false);
			}
			if (yearDropdownRef.current && !yearDropdownRef.current.contains(target)) {
				setYearDropdownOpen(false);
			}
		};

		document.addEventListener("mousedown", onPointerDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
		};
	}, []);

	const allSessionStats = useMemo<SessionStats[]>(
		() =>
			sessions
				.slice()
				.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
				.map((session) => {
					const clockMs = session.is_active ? sessionElapsedMs(session, now) : session.total_duration;
					const pausedMs = Math.max(0, session.paused_duration);
					return {
						session,
						clockMs: Math.max(0, clockMs),
						focusMs: Math.max(0, clockMs - pausedMs),
					};
				}),
		[sessions, sessionElapsedMs, now],
	);

	const selectedRange = useMemo(() => {
		if (!selectedStartDay) {
			return null;
		}

		if (!selectedEndDay) {
			return {
				startDay: selectedStartDay,
				endDay: selectedStartDay,
				isRange: false,
			};
		}

		const startDay = selectedStartDay <= selectedEndDay ? selectedStartDay : selectedEndDay;
		const endDay = selectedStartDay <= selectedEndDay ? selectedEndDay : selectedStartDay;

		return {
			startDay,
			endDay,
			isRange: startDay !== endDay,
		};
	}, [selectedStartDay, selectedEndDay]);

	const filteredSessionStats = useMemo(() => {
		if (!selectedRange) {
			return allSessionStats;
		}

		return allSessionStats.filter((entry) => {
			const day = toInputDate(new Date(entry.session.started_at));
			return day >= selectedRange.startDay && day <= selectedRange.endDay;
		});
	}, [allSessionStats, selectedRange]);

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
		const activeDays = new Set(filteredSessionStats.map((entry) => toInputDate(new Date(entry.session.started_at))))
			.size;
		const focusRatio = totalClockMs > 0 ? (totalFocusMs / totalClockMs) * 100 : 0;

		return {
			totalClockMs,
			totalFocusMs,
			averageSessionMs,
			activeDays,
			focusRatio,
		};
	}, [filteredSessionStats]);

	const topApps = useMemo(() => {
		const appTotals = new Map<string, number>();
		for (const block of filteredBlocks) {
			const appName = cleanAppLabel(block.app_name);
			const durationMs = blockDurationMs(block, now);
			appTotals.set(appName, (appTotals.get(appName) ?? 0) + durationMs);
		}

		const rows = Array.from(appTotals.entries())
			.map(([appName, durationMs]) => ({ appName, durationMs }))
			.sort((a, b) => b.durationMs - a.durationMs)
			.slice(0, 6);

		return {
			rows,
			topDuration: rows[0]?.durationMs ?? 1,
		};
	}, [filteredBlocks, now]);

	const calendarData = useMemo(() => {
		const totalsByDay = new Map<string, number>();
		for (const entry of allSessionStats) {
			const day = toInputDate(new Date(entry.session.started_at));
			totalsByDay.set(day, (totalsByDay.get(day) ?? 0) + entry.clockMs);
		}

		const monthStart = toMonthStart(displayedMonth);
		const year = monthStart.getFullYear();
		const month = monthStart.getMonth();
		const daysInMonth = new Date(year, month + 1, 0).getDate();
		const leadingEmptyCells = (monthStart.getDay() + 6) % 7;
		const todayKey = toInputDate(new Date(now));

		const cells: Array<
			| { key: string; isEmpty: true }
			| {
					key: string;
					isEmpty: false;
					day: string;
					dayNumber: number;
					clockMs: number;
					isToday: boolean;
					isSelected: boolean;
					isInRange: boolean;
			  }
		> = [];

		for (let index = 0; index < leadingEmptyCells; index += 1) {
			cells.push({ key: `empty-${index}`, isEmpty: true });
		}

		for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
			const date = new Date(year, month, dayNumber);
			const day = toInputDate(date);
			const isInRange = selectedRange ? day >= selectedRange.startDay && day <= selectedRange.endDay : false;
			const isSelected = selectedRange ? day === selectedRange.startDay || day === selectedRange.endDay : false;
			cells.push({
				key: day,
				isEmpty: false,
				day,
				dayNumber,
				clockMs: totalsByDay.get(day) ?? 0,
				isToday: day === todayKey,
				isSelected,
				isInRange,
			});
		}

		return {
			title: dutchMonthYearFormatter.format(monthStart),
			cells,
		};
	}, [allSessionStats, displayedMonth, selectedRange, now]);

	const selectionLabel = useMemo(() => {
		if (!selectedRange) {
			return "Alles";
		}
		if (!selectedRange.isRange) {
			return selectedRange.startDay;
		}
		return `${selectedRange.startDay} t/m ${selectedRange.endDay}`;
	}, [selectedRange]);

	const yearOptions = useMemo(() => {
		const years = sessions.map((session) => new Date(session.started_at).getFullYear());
		years.push(new Date(now).getFullYear());

		const minYear = Math.min(...years, new Date(now).getFullYear()) - 2;
		const maxYear = Math.max(...years, new Date(now).getFullYear()) + 2;
		const options: number[] = [];
		for (let year = minYear; year <= maxYear; year += 1) {
			options.push(year);
		}
		return options;
	}, [sessions, now]);

	const handleDaySelect = (day: string, withShift: boolean) => {
		if (withShift && selectedStartDay && !selectedEndDay) {
			if (day === selectedStartDay) {
				return;
			}
			setSelectedEndDay(day);
			return;
		}

		setSelectedStartDay(day);
		setSelectedEndDay(null);
	};

	const goToPreviousMonth = () => {
		setDisplayedMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
	};

	const goToNextMonth = () => {
		setDisplayedMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
	};

	const setDisplayedYear = (year: number) => {
		setDisplayedMonth((prev) => new Date(year, prev.getMonth(), 1));
		setYearDropdownOpen(false);
	};

	const setDisplayedMonthIndex = (monthIndex: number) => {
		setDisplayedMonth((prev) => new Date(prev.getFullYear(), monthIndex, 1));
		setMonthDropdownOpen(false);
	};

	return (
		<div className="grid h-full min-h-0 gap-3 overflow-hidden">
			<div className="grid min-h-0 gap-3 overflow-auto pr-1">
				<section className="atlas-card grid gap-3">
					<div className="flex flex-wrap items-start justify-between gap-2">
						<div className="grid gap-1">
							<h3 className="text-subtitle-small">Kalender</h3>
							<p className="text-data-small text-neutral-500 dark:text-neutral-300">
								Selectie: {selectionLabel}
							</p>
						</div>
						<div className="flex items-center gap-1.5">
							<button
								type="button"
								onClick={() => setDisplayedMonth(toMonthStart(new Date(now)))}
								className="inline-flex items-center gap-1.5 rounded-full border border-primary/60 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-primary hover:bg-primary/15"
							>
								<CalendarDaysIcon className="h-3.5 w-3.5" />
								Vandaag
							</button>
							<button
								type="button"
								onClick={() => {
									setSelectedStartDay(null);
									setSelectedEndDay(null);
								}}
								disabled={!selectedStartDay}
								className="rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500 hover:border-neutral-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300"
							>
								Selectie wissen
							</button>
						</div>
					</div>

					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="flex items-center gap-1.5">
							<button
								type="button"
								onClick={goToPreviousMonth}
								className="rounded-full border border-neutral-200 p-1.5 text-neutral-500 hover:border-neutral-300 dark:border-neutral-600 dark:text-neutral-300"
								aria-label="Vorige maand"
							>
								<ChevronLeftIcon className="h-4 w-4" />
							</button>

							<div
								ref={monthDropdownRef}
								className="relative"
							>
								<button
									type="button"
									onClick={() => {
										setMonthDropdownOpen((open) => !open);
										setYearDropdownOpen(false);
									}}
									className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-sm font-semibold capitalize text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
								>
									{MONTH_OPTIONS[displayedMonth.getMonth()]}
									<ChevronDownIcon className="h-4 w-4" />
								</button>
								{monthDropdownOpen ? (
									<div className="absolute left-0 z-20 mt-1 grid w-40 grid-cols-2 gap-1 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-600 dark:bg-neutral-800">
										{MONTH_OPTIONS.map((month, index) => (
											<button
												key={month}
												type="button"
												onClick={() => setDisplayedMonthIndex(index)}
												className={`rounded-lg px-2 py-1 text-left text-xs capitalize ${
													index === displayedMonth.getMonth()
														? "bg-primary/10 text-primary"
														: "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
												}`}
											>
												{month}
											</button>
										))}
									</div>
								) : null}
							</div>

							<div
								ref={yearDropdownRef}
								className="relative"
							>
								<button
									type="button"
									onClick={() => {
										setYearDropdownOpen((open) => !open);
										setMonthDropdownOpen(false);
									}}
									className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-sm font-semibold text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
								>
									{displayedMonth.getFullYear()}
									<ChevronDownIcon className="h-4 w-4" />
								</button>
								{yearDropdownOpen ? (
									<div className="absolute left-0 z-20 mt-1 grid max-h-44 w-28 gap-1 overflow-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-600 dark:bg-neutral-800">
										{yearOptions.map((year) => (
											<button
												key={year}
												type="button"
												onClick={() => setDisplayedYear(year)}
												className={`rounded-lg px-2 py-1 text-left text-xs ${
													year === displayedMonth.getFullYear()
														? "bg-primary/10 text-primary"
														: "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
												}`}
											>
												{year}
											</button>
										))}
									</div>
								) : null}
							</div>

							<button
								type="button"
								onClick={goToNextMonth}
								className="rounded-full border border-neutral-200 p-1.5 text-neutral-500 hover:border-neutral-300 dark:border-neutral-600 dark:text-neutral-300"
								aria-label="Volgende maand"
							>
								<ChevronRightIcon className="h-4 w-4" />
							</button>
						</div>
					</div>

					<div className="grid gap-2">
						<div className="grid grid-cols-7 gap-2">
							{WEEKDAY_LABELS.map((label) => (
								<span
									key={label}
									className="px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500 dark:text-neutral-300"
								>
									{label}
								</span>
							))}
						</div>
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
							{calendarData.cells.map((cell) =>
								cell.isEmpty ? (
									<div
										key={cell.key}
										aria-hidden
										className="min-h-20 rounded-xl border border-transparent"
									/>
								) : (
									<button
										key={cell.key}
										type="button"
										onClick={(event) => handleDaySelect(cell.day, event.shiftKey)}
										className={`grid min-h-20 content-between gap-1 rounded-xl border bg-neutral-50 p-2 text-left transition dark:bg-neutral-700 ${
											cell.isSelected
												? "border-primary/80 ring-1 ring-primary/50"
												: cell.isInRange
													? "border-primary/40 bg-primary/5"
													: "border-neutral-200 hover:border-neutral-300 dark:border-neutral-600"
										}`}
									>
										<div className="flex items-center justify-between">
											<span className="text-data-small font-semibold">{cell.dayNumber}</span>
											{cell.isToday ? (
												<span className="text-[10px] uppercase tracking-[0.06em] text-primary">
													Vandaag
												</span>
											) : null}
										</div>
										<p className="text-body-small font-medium text-neutral-700 dark:text-neutral-100">
											{formatHours(cell.clockMs)}
										</p>
									</button>
								),
							)}
						</div>
					</div>

					{activityError ? <p className="text-[12px] text-amber-600">{activityError}</p> : null}
					{isLoadingBlocks ? <p className="text-[12px] text-neutral-500">Activiteit laden...</p> : null}
				</section>

				<section className="atlas-card grid gap-3">
					<header className="card-head">
						<h3 className="text-subtitle-small">Top apps</h3>
						<span className="text-data-small">Gebaseerd op je huidige kalenderselectie</span>
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
									className="h-1.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-neutral-700 [&::-webkit-progress-bar]:bg-neutral-200 [&::-webkit-progress-value]:bg-neutral-700 dark:[&::-webkit-progress-bar]:bg-neutral-600 dark:[&::-webkit-progress-value]:bg-neutral-100"
									max={topApps.topDuration || 1}
									value={Math.max(0, entry.durationMs)}
								/>
							</div>
						))}
						{!topApps.rows.length ? <p className="empty">Nog geen app-data voor deze selectie.</p> : null}
					</div>
				</section>

				<section className="grid grid-cols-1 gap-3 md:grid-cols-3">
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
						<p className="metric-sub text-data-small">{filteredSessionStats.length} sessies</p>
					</div>
					<div className="atlas-card metric-card">
						<p className="card-kicker text-label-small">Gemiddelde sessie</p>
						<p className="metric-value text-title-small">{formatDuration(totals.averageSessionMs)}</p>
						<p className="metric-sub text-data-small">{totals.activeDays} actieve dagen</p>
					</div>
				</section>
			</div>
		</div>
	);
}
