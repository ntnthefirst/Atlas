import { useState, useMemo } from "react";
import type { Session } from "../types";

export type SessionStats = {
	session: Session;
	clockMs: number;
	focusMs: number;
};

export type PresetSelection = "thisWeek" | "last7Days" | "thisMonth" | "today" | "always";

export const monthYearFormatter = new Intl.DateTimeFormat("en-US", {
	month: "long",
	year: "numeric",
});

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MONTH_OPTIONS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

export const toInputDate = (value: Date) => {
	const year = value.getFullYear();
	const month = `${value.getMonth() + 1}`.padStart(2, "0");
	const day = `${value.getDate()}`.padStart(2, "0");
	return `${year}-${month}-${day}`;
};

export const toMonthStart = (value: Date) => new Date(value.getFullYear(), value.getMonth(), 1);

export const toWeekStartMonday = (value: Date) => {
	const date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
	const weekday = date.getDay();
	const offset = weekday === 0 ? -6 : 1 - weekday;
	date.setDate(date.getDate() + offset);
	return date;
};

export function useCalendarFilter(
	sessions: Session[],
	now: number,
	sessionElapsedMs: (session: Session, now: number) => number,
) {
	const [selectedStartDay, setSelectedStartDay] = useState<string | null>(null);
	const [selectedEndDay, setSelectedEndDay] = useState<string | null>(null);
	const [activePreset, setActivePreset] = useState<PresetSelection | null>(null);
	const [displayedMonth, setDisplayedMonth] = useState(() => toMonthStart(new Date(now)));
	const [isCalendarCollapsed, setIsCalendarCollapsed] = useState(true);

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

	const filteredSessions = useMemo(
		() => filteredSessionStats.map((entry) => entry.session),
		[filteredSessionStats]
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
			title: monthYearFormatter.format(monthStart),
			cells,
		};
	}, [allSessionStats, displayedMonth, selectedRange, now]);

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
	};

	const setDisplayedMonthIndex = (monthIndex: number) => {
		setDisplayedMonth((prev) => new Date(prev.getFullYear(), monthIndex, 1));
	};

	const toggleCalendarCollapsed = () => {
		setIsCalendarCollapsed((current) => !current);
	};

	return {
		selectedStartDay,
		selectedEndDay,
		activePreset,
		displayedMonth,
		isCalendarCollapsed,
		setIsCalendarCollapsed,
		selectedRange,
		filteredSessions,
		filteredSessionStats,
		calendarData,
		applyPresetSelection,
		handleDaySelect,
		goToPreviousMonth,
		goToNextMonth,
		setDisplayedYear,
		setDisplayedMonthIndex,
		toggleCalendarCollapsed,
	};
}
