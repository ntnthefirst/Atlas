import type { MainContentViewsProps } from "./types";
import { Tooltip } from "../ui";
import { useState } from "react";
import { TrashIcon } from "@heroicons/react/24/outline";
import { TrashIcon as TrashIconSolid } from "@heroicons/react/24/solid";

const cleanAppLabel = (value: string) => {
	const cleaned = value
		.replace(/\s*\[[^\]]*\]\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return cleaned || "Unknown";
};

const getAppColor = (appName: string) => {
	const normalized = appName.toLowerCase();

	if (normalized.includes("figma")) {
		return "#F24E1E";
	}
	if (normalized.includes("visual studio code") || normalized.includes("vscode") || normalized === "code") {
		return "#007ACC";
	}
	if (normalized.includes("edge") || normalized.includes("msedge")) {
		return "#0EA5E9";
	}
	if (normalized.includes("chrome") || normalized.includes("chromium")) {
		return "#EA4335";
	}
	if (normalized.includes("youtube") || normalized.includes("yt")) {
		return "#FF0033";
	}
	if (normalized.includes("explorer") || normalized.includes("taakbeheer") || normalized.includes("task manager")) {
		return "#2563EB";
	}
	if (normalized.includes("atlas")) {
		return "#F97316";
	}
	if (normalized.includes("unknown")) {
		return "#6B7280";
	}

	const fallbackPalette = [
		"#F97316",
		"#DC2626",
		"#7C3AED",
		"#0284C7",
		"#16A34A",
		"#D97706",
		"#DB2777",
		"#0F766E",
		"#4F46E5",
		"#B91C1C",
	];

	let hash = 0;
	for (let index = 0; index < appName.length; index += 1) {
		hash = appName.charCodeAt(index) + ((hash << 5) - hash);
	}
	return fallbackPalette[Math.abs(hash) % fallbackPalette.length];
};

export function LogbookView({
	sessions,
	selectedSession,
	onOpenSession,
	onDeleteSession,
	activityBlocks,
	now,
	formatClock,
	sessionElapsedMs,
}: MainContentViewsProps) {
	const [hoveredAppName, setHoveredAppName] = useState<string>("");
	const formatElapsed = (ms: number) => formatClock(ms);
	const formatPercent = (value: number) => `${value.toFixed(value >= 10 ? 1 : 2)}%`;
	const scrollAreaClasses =
		"min-h-0 overflow-auto pr-1 [scrollbar-width:thin] [scrollbar-color:var(--neutral-400)_transparent] dark:[scrollbar-color:var(--neutral-500)_transparent] [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-[linear-gradient(180deg,var(--neutral-400),var(--neutral-500))] [&::-webkit-scrollbar-thumb]:bg-clip-padding [&::-webkit-scrollbar-thumb:hover]:bg-[linear-gradient(180deg,var(--primary-hover),var(--primary-active))] dark:[&::-webkit-scrollbar-thumb]:bg-[linear-gradient(180deg,var(--neutral-500),var(--neutral-600))] dark:[&::-webkit-scrollbar-thumb:hover]:bg-[linear-gradient(180deg,var(--primary-soft),var(--primary))]";

	const selectedSessionTotal = selectedSession
		? selectedSession.is_active
			? sessionElapsedMs(selectedSession, now)
			: selectedSession.total_duration
		: 0;
	const selectedSessionStartMs = selectedSession ? new Date(selectedSession.started_at).getTime() : 0;
	const selectedSessionEndMs = selectedSession
		? selectedSession.ended_at
			? new Date(selectedSession.ended_at).getTime()
			: now
		: 0;
	const selectedSessionWindowMs = Math.max(1, selectedSessionEndMs - selectedSessionStartMs);
	const appTotals = activityBlocks
		.reduce<Array<{ appName: string; duration: number }>>((entries, block) => {
			const cleanedName = cleanAppLabel(block.app_name);

			// For completed sessions, always use block.duration (never recalculate from now)
			// For active sessions, calculate from now if block is open
			const blockMs =
				selectedSession && !selectedSession.is_active
					? block.duration || 0
					: block.ended_at
						? block.duration
						: Math.max(0, now - new Date(block.started_at).getTime());

			const existing = entries.find((entry) => entry.appName === cleanedName);
			if (existing) {
				existing.duration += blockMs;
				return entries;
			}
			entries.push({ appName: cleanedName, duration: blockMs });
			return entries;
		}, [])
		.sort((a, b) => b.duration - a.duration)
		.slice(0, 12);

	return (
		<div className="grid h-full min-h-0 grid-cols-[340px_minmax(0,1fr)] items-start gap-3">
			<section className="atlas-card grid min-h-0 max-h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
				<header className="card-head">
					<h3 className="text-subtitle-small">Sessions</h3>
					<span className="text-data-small">{sessions.length} total</span>
				</header>
				<div className={`stack-list ${scrollAreaClasses} p-0.5`}>
					{sessions.map((session) => {
						const isSelected = selectedSession?.id === session.id;
						return (
							<div
								key={session.id}
								className={`group session-item grid grid-cols-[1fr_auto] items-center gap-2 ${isSelected ? "active" : ""}`}
							>
								<button
									onClick={() => onOpenSession(session.id)}
									className="col-span-1 text-left"
								>
									<div>
										<p className="text-body-small">
											{new Date(session.started_at).toLocaleString()}
										</p>
										<small className="text-data-small">
											{session.is_active ? "Running" : "Completed"}
										</small>
									</div>
									<strong className="text-data-regular">
										{formatClock(
											session.is_active ? sessionElapsedMs(session, now) : session.total_duration,
										)}
									</strong>
								</button>
								{!session.is_active && (
									<Tooltip content="Delete session">
										<button
											onClick={(e) => {
												e.stopPropagation();
												void onDeleteSession(session.id);
											}}
											className="group/delete col-span-1 opacity-0 transition-opacity group-hover:opacity-100 inline-flex h-7 w-7 items-center justify-center rounded border border-transparent text-neutral-400 hover:bg-neutral-200 hover:text-red-600 dark:hover:bg-neutral-700 dark:hover:text-red-400"
											aria-label="Delete session"
										>
											<span className="relative h-4 w-4">
												<TrashIcon className="absolute inset-0 h-4 w-4 transition-opacity group-hover/delete:opacity-0" />
												<TrashIconSolid className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity group-hover/delete:opacity-100" />
											</span>
										</button>
									</Tooltip>
								)}
							</div>
						);
					})}
					{!sessions.length && <p className="empty">Start your first session to build a logbook.</p>}
				</div>
			</section>

			<section className="atlas-card grid min-h-0 max-h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
				<header className="card-head">
					<h3 className="text-subtitle-small">Timeline</h3>
					<span className="text-data-small">
						{selectedSession ? "Total per app this session" : "Select a session"}
					</span>
				</header>
				<div className={`grid content-start gap-2.5 ${scrollAreaClasses}`}>
					{selectedSession && activityBlocks.length > 0 && (
						<div className="mb-2.5 grid gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-600 dark:bg-neutral-700">
							<div className="flex items-center justify-between gap-2">
								<span className="text-data-small">Session rail</span>
								<strong className="text-data-small">{formatElapsed(selectedSessionTotal)}</strong>
							</div>
							<div className="relative h-3.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
								{activityBlocks.map((block) => {
									const cleanedName = cleanAppLabel(block.app_name);
									const blockStart = new Date(block.started_at).getTime();
									const blockEnd = block.ended_at ? new Date(block.ended_at).getTime() : now;
									const left = Math.max(
										0,
										((blockStart - selectedSessionStartMs) / selectedSessionWindowMs) * 100,
									);
									const width = Math.max(
										0.9,
										((Math.max(blockStart, blockEnd) - blockStart) / selectedSessionWindowMs) * 100,
									);
									const percent = Math.max(
										0,
										((Math.max(blockStart, blockEnd) - blockStart) / selectedSessionWindowMs) * 100,
									);

									return (
										<Tooltip
											key={block.id}
											content={`${cleanedName} (${new Date(block.started_at).toLocaleTimeString()} - ${block.ended_at ? new Date(block.ended_at).toLocaleTimeString() : "now"}) • ${formatPercent(percent)}`}
										>
											<span
												className={`absolute top-0 h-full min-w-[2px] rounded-full transition-[opacity,filter,transform] duration-150 ${
													hoveredAppName
														? hoveredAppName === cleanedName
															? "opacity-100 translate-y-[-0.5px]"
															: "opacity-30 saturate-[0.65]"
														: ""
												}`}
												style={{
													left: `${left}%`,
													width: `${width}%`,
													backgroundColor: getAppColor(cleanedName),
												}}
												onMouseEnter={() => setHoveredAppName(cleanedName)}
												onMouseLeave={() => setHoveredAppName("")}
											/>
										</Tooltip>
									);
								})}
							</div>
							<div className="flex justify-between text-data-small text-neutral-500 dark:text-neutral-300">
								<span>{new Date(selectedSession.started_at).toLocaleTimeString()}</span>
								<span>
									{selectedSession.ended_at
										? new Date(selectedSession.ended_at).toLocaleTimeString()
										: new Date(now).toLocaleTimeString()}
								</span>
							</div>
						</div>
					)}
					{appTotals.length > 0 ? (
						<div className="grid gap-2">
							{appTotals.map((entry) => {
								const percent = Math.max(0, (entry.duration / selectedSessionWindowMs) * 100);

								return (
									<div
										key={entry.appName}
										className={`grid grid-cols-[220px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 transition-[opacity,filter,border-color] duration-150 dark:border-neutral-600 dark:bg-neutral-700 ${
											hoveredAppName
												? hoveredAppName === entry.appName
													? "opacity-100 border-neutral-400 dark:border-neutral-400"
													: "opacity-[0.38] saturate-[0.7]"
												: ""
										}`}
									>
										<div className="flex min-w-0 items-center gap-2 text-body-small">
											<span
												className="h-2.5 w-2.5 shrink-0 cursor-pointer rounded-full"
												style={{ backgroundColor: getAppColor(entry.appName) }}
												onMouseEnter={() => setHoveredAppName(entry.appName)}
												onMouseLeave={() => setHoveredAppName("")}
											/>
											<span className="truncate">{entry.appName}</span>
										</div>
										<Tooltip
											content={`${entry.appName}: ${formatPercent(percent)} van totale opname`}
										>
											<div className="h-2.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
												<div
													className="h-full rounded-full"
													style={{
														width: `${percent}%`,
														backgroundColor: getAppColor(entry.appName),
													}}
												/>
											</div>
										</Tooltip>
										<strong className="whitespace-nowrap text-data-small text-neutral-500 dark:text-neutral-300">
											{formatElapsed(entry.duration)} • {formatPercent(percent)}
										</strong>
									</div>
								);
							})}
						</div>
					) : (
						<p className="empty">No timeline blocks available for this session yet.</p>
					)}
				</div>
			</section>
		</div>
	);
}
