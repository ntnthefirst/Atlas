import { CalendarDaysIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useRef, useState, useEffect } from "react";
import type { PresetSelection } from "../../hooks/useCalendarFilter";
import { MONTH_OPTIONS, WEEKDAY_LABELS, toMonthStart } from "../../hooks/useCalendarFilter";

export function CalendarPopover({
	selectedRange,
	displayedMonth,
	isCalendarCollapsed,
	setIsCalendarCollapsed,
	calendarData,
	applyPresetSelection,
	handleDaySelect,
	goToPreviousMonth,
	goToNextMonth,
	setDisplayedYear,
	setDisplayedMonthIndex,
	activePreset,
	yearOptions,
	now,
	formatDuration,
}: any) {
	const [monthDropdownOpen, setMonthDropdownOpen] = useState(false);
	const [yearDropdownOpen, setYearDropdownOpen] = useState(false);
	const monthDropdownRef = useRef<HTMLDivElement | null>(null);
	const yearDropdownRef = useRef<HTMLDivElement | null>(null);

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

	const selectionLabel = (() => {
		if (!selectedRange) {
			return "All time";
		}
		if (!selectedRange.isRange) {
			return selectedRange.startDay;
		}
		return `${selectedRange.startDay} to ${selectedRange.endDay}`;
	})();

	const presetButtons: Array<{ key: PresetSelection; label: string }> = [
		{ key: "thisWeek", label: "This week" },
		{ key: "last7Days", label: "Last 7 days" },
		{ key: "thisMonth", label: "This month" },
		{ key: "today", label: "Today" },
		{ key: "always", label: "All time" },
	];

	const isTodayVisibleInCalendar =
		displayedMonth.getFullYear() === toMonthStart(new Date(now)).getFullYear() &&
		displayedMonth.getMonth() === toMonthStart(new Date(now)).getMonth();

	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => setIsCalendarCollapsed(!isCalendarCollapsed)}
				className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[12px] font-semibold transition hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-200"
			>
				<CalendarDaysIcon className="h-4 w-4" />
				Calendar: {selectionLabel}
				<ChevronDownIcon
					className={`h-3 w-3 transition-transform duration-300 ease-out ${
						isCalendarCollapsed ? "rotate-0" : "rotate-180"
					}`}
				/>
			</button>

			{!isCalendarCollapsed && (
				<div className="absolute left-0 top-full z-50 mt-2 w-[800px] max-w-[90vw] origin-top-left rounded-2xl border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-600 dark:bg-neutral-800">
					<div className="mb-4 flex flex-wrap items-center justify-between gap-4">
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
						<div className="flex items-center gap-1">
							<button
								type="button"
								onClick={goToPreviousMonth}
								className="rounded-full p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
								aria-label="Previous month"
							>
								<ChevronLeftIcon className="h-4 w-4" />
							</button>

							<div ref={monthDropdownRef} className="relative">
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
								{monthDropdownOpen && (
									<div className="absolute left-0 z-20 mt-1 grid w-40 grid-cols-2 gap-1 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-600 dark:bg-neutral-800">
										{MONTH_OPTIONS.map((month, index) => (
											<button
												key={month}
												type="button"
												onClick={() => {
													setDisplayedMonthIndex(index);
													setMonthDropdownOpen(false);
												}}
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
								)}
							</div>

							<div ref={yearDropdownRef} className="relative">
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
								{yearDropdownOpen && (
									<div className="absolute left-0 z-20 mt-1 grid max-h-44 w-28 gap-1 overflow-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-600 dark:bg-neutral-800">
										{yearOptions.map((year: number) => (
											<button
												key={year}
												type="button"
												onClick={() => {
													setDisplayedYear(year);
													setYearDropdownOpen(false);
												}}
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
								)}
							</div>

							<button
								type="button"
								onClick={goToNextMonth}
								className="rounded-full p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
								aria-label="Next month"
							>
								<ChevronRightIcon className="h-4 w-4" />
							</button>

							{!isTodayVisibleInCalendar && (
								<button
									type="button"
									onClick={() => setDisplayedMonthIndex(new Date(now).getMonth(), new Date(now).getFullYear())}
									className={`ml-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] transition ${
										activePreset
											? "border border-primary/60 bg-primary/10 text-primary hover:bg-primary/15"
											: "border border-primary bg-primary text-white hover:bg-primary/90"
									}`}
								>
									<CalendarDaysIcon className="h-3.5 w-3.5" />
									Today
								</button>
							)}
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
							{calendarData.cells.map((cell: any) =>
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
											{cell.isToday && (
												<span className="text-[10px] uppercase tracking-[0.06em] text-primary">
													Today
												</span>
											)}
										</div>
										<p className="text-body-small font-medium text-neutral-700 dark:text-neutral-100">
											{formatDuration(cell.clockMs)}
										</p>
									</button>
								)
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
