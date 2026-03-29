import {
	CalendarDaysIcon,
	ChevronDownIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ChevronUpIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityBlock, Session } from "../../types";
import type { MainContentViewsProps } from "./types";

type SessionStats = {
	session: Session;
	clockMs: number;
	focusMs: number;
};

type PresetSelection = "thisWeek" | "last7Days" | "thisMonth" | "today" | "always";
type ActivityViewMode = "apps" | "windows";

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

const toWeekStartMonday = (value: Date) => {
	const date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
	const weekday = date.getDay();
	const offset = weekday === 0 ? -6 : 1 - weekday;
	date.setDate(date.getDate() + offset);
	return date;
};

const formatPercent = (value: number) => `${Math.round(value)}%`;

const formatHours = (valueMs: number) => `${dutchHourFormatter.format(valueMs / 3_600_000)}u`;

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
	sessionElapsedMs,
}: MainContentViewsProps) {
	const [blocksBySessionId, setBlocksBySessionId] = useState<Record<string, ActivityBlock[]>>({});
	const [isLoadingBlocks, setIsLoadingBlocks] = useState(false);
	const [activityError, setActivityError] = useState("");
	const [selectedStartDay, setSelectedStartDay] = useState<string | null>(null);
	const [selectedEndDay, setSelectedEndDay] = useState<string | null>(null);
	const [activePreset, setActivePreset] = useState<PresetSelection | null>(null);
	const [isTopMode, setIsTopMode] = useState(true);
	const [activityViewMode, setActivityViewMode] = useState<ActivityViewMode>("apps");
	const [isAppsSortAscending, setIsAppsSortAscending] = useState(false);
	const [displayedMonth, setDisplayedMonth] = useState(() => toMonthStart(new Date(now)));
	const [isCalendarCollapsed, setIsCalendarCollapsed] = useState(true);
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

	const applyPresetSelection = (preset: PresetSelection) => {
		const today = new Date(now);
		const todayDay = toInputDate(today);

		switch (preset) {
			case "thisWeek": {
				const weekStart = toInputDate(toWeekStartMonday(today));
				setSelectedStartDay(weekStart);
				setSelectedEndDay(todayDay);
				setDisplayedMonth(toMonthStart(today));
				break;
			}
			case "last7Days": {
				const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
				setSelectedStartDay(toInputDate(start));
				setSelectedEndDay(todayDay);
				setDisplayedMonth(toMonthStart(today));
				break;
			}
			case "thisMonth": {
				const monthStart = toMonthStart(today);
				setSelectedStartDay(toInputDate(monthStart));
				setSelectedEndDay(todayDay);
				setDisplayedMonth(monthStart);
				break;
			}
			case "today": {
				setSelectedStartDay(todayDay);
				setSelectedEndDay(null);
				setDisplayedMonth(toMonthStart(today));
				break;
			}
			case "always": {
				setSelectedStartDay(null);
				setSelectedEndDay(null);
				break;
			}
			default:
				break;
		}

		setActivePreset(preset);
	};

	const handleDaySelect = (day: string, withShift: boolean) => {
		setActivePreset(null);
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

	const toggleCalendarCollapsed = () => {
		setIsCalendarCollapsed((current) => {
			const next = !current;
			if (next) {
				setMonthDropdownOpen(false);
				setYearDropdownOpen(false);
			}
			return next;
		});
	};

	const isPresetActive = activePreset !== null;
	const presetButtons: Array<{ key: PresetSelection; label: string }> = [
		{ key: "thisWeek", label: "Deze week" },
		{ key: "last7Days", label: "Afgelopen 7 dagen" },
		{ key: "thisMonth", label: "Deze maand" },
		{ key: "today", label: "Vandaag" },
		{ key: "always", label: "Altijd" },
	];

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
						<div className="flex flex-wrap items-center justify-end gap-2.5">
							<div className="flex flex-wrap items-center gap-1 rounded-xl border border-neutral-200 bg-neutral-50 p-1.5 dark:border-neutral-600 dark:bg-neutral-700">
								{presetButtons.map((preset) => (
									<button
										key={preset.key}
										type="button"
										onClick={() => applyPresetSelection(preset.key)}
										className={`rounded-lg border px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] transition ${
											activePreset === preset.key
												? "border-primary/60 bg-primary/10 text-primary"
												: "border-neutral-200 text-neutral-600 hover:border-neutral-300 dark:border-neutral-500 dark:text-neutral-200"
										}`}
									>
										{preset.label}
									</button>
								))}
							</div>
							<button
								type="button"
								onClick={toggleCalendarCollapsed}
								aria-label={isCalendarCollapsed ? "Kalender openklappen" : "Kalender inklappen"}
								className="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500 transition hover:border-neutral-300 hover:text-neutral-700 dark:border-neutral-600 dark:text-neutral-300 dark:hover:text-neutral-100"
							>
								{isCalendarCollapsed ? "Open" : "Dicht"}
								{isCalendarCollapsed ? (
									<ChevronDownIcon className="h-3.5 w-3.5" />
								) : (
									<ChevronUpIcon className="h-3.5 w-3.5" />
								)}
							</button>
						</div>
					</div>

					{!isCalendarCollapsed ? (
						<>
							<div className="grid gap-2">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div className="flex items-center gap-1">
										<button
											type="button"
											onClick={goToPreviousMonth}
											className="rounded-full p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
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
												className="group inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-base font-semibold capitalize tracking-tight text-neutral-800 transition hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-700"
											>
												{MONTH_OPTIONS[displayedMonth.getMonth()]}
												<ChevronDownIcon className="h-3.5 w-3.5 text-neutral-400 transition group-hover:text-neutral-600 dark:group-hover:text-neutral-200" />
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
												className="group inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-base font-semibold tracking-tight text-neutral-800 transition hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-700"
											>
												{displayedMonth.getFullYear()}
												<ChevronDownIcon className="h-3.5 w-3.5 text-neutral-400 transition group-hover:text-neutral-600 dark:group-hover:text-neutral-200" />
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
											className="rounded-full p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
											aria-label="Volgende maand"
										>
											<ChevronRightIcon className="h-4 w-4" />
										</button>
									</div>
									<button
										type="button"
										onClick={() => setDisplayedMonth(toMonthStart(new Date(now)))}
										className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] transition ${
											isPresetActive
												? "border border-primary/60 bg-primary/10 text-primary hover:bg-primary/15"
												: "border border-primary bg-primary text-white hover:bg-primary/90"
										}`}
									>
										<CalendarDaysIcon className="h-3.5 w-3.5" />
										Naar vandaag
									</button>
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
														<span className="text-data-small font-semibold">
															{cell.dayNumber}
														</span>
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
							</div>

							{activityError ? <p className="text-[12px] text-amber-600">{activityError}</p> : null}
							{isLoadingBlocks ? (
								<p className="text-[12px] text-neutral-500">Activiteit laden...</p>
							) : null}
						</>
					) : null}
				</section>

				<section className="grid grid-cols-3 gap-3">
					<div className="atlas-card grid gap-2">
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							Focus tijd
						</p>
						<p className="m-0 font-data text-[clamp(36px,5vw,52px)] leading-none">
							{formatDuration(totals.totalFocusMs)}
						</p>
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							{formatPercent(totals.focusRatio)} van je totale tijd
						</p>
					</div>
					<div className="atlas-card grid gap-2">
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							Totale tijd
						</p>
						<p className="m-0 font-data text-[clamp(36px,5vw,52px)] leading-none">
							{formatDuration(totals.totalClockMs)}
						</p>
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							{filteredSessionStats.length} sessies
						</p>
					</div>
					<div className="atlas-card grid gap-2">
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							Gemiddelde sessie
						</p>
						<p className="m-0 font-data text-[clamp(36px,5vw,52px)] leading-none">
							{formatDuration(totals.averageSessionMs)}
						</p>
						<p className="mt-2 text-[12px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
							{totals.activeDays} actieve dagen
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
									Alle
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
								{isAppsSortAscending ? "Oplopend" : "Aflopend"}
							</button>
						) : (
							<span className="text-data-small">Gebaseerd op je huidige kalenderselectie</span>
						)}
					</header>
					<div className="stack-list">
						{visibleAppRows.map((entry) => (
							<div
								key={entry.name}
								className="grid gap-1 rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-600 dark:bg-neutral-700"
							>
								<div className="stack-row text-body-small">
									<span className="truncate">{entry.name}</span>
									<strong>{formatDuration(entry.durationMs)}</strong>
								</div>
								<progress
									className="h-1.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-neutral-700 [&::-webkit-progress-bar]:bg-neutral-200 [&::-webkit-progress-value]:bg-neutral-700 dark:[&::-webkit-progress-bar]:bg-neutral-600 dark:[&::-webkit-progress-value]:bg-neutral-100"
									max={totalSelectedAppsDuration || 1}
									value={Math.max(0, entry.durationMs)}
								/>
							</div>
						))}
						{!visibleAppRows.length ? (
							<p className="empty">
								Nog geen {activityViewMode === "apps" ? "app" : "window"}-data voor deze selectie.
							</p>
						) : null}
					</div>
				</section>
			</div>
		</div>
	);
}
