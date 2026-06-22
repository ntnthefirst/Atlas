import { useEffect, useState } from "react";
import { PauseIcon, PlayIcon, ForwardIcon, StopIcon } from "@heroicons/react/24/solid";
import type { FocusNudgeKind } from "../../types";
import { FOCUS_PHASE_LABELS } from "../../hooks";
import { Toggle } from "../ui";
import type { MainContentViewsProps } from "./types";

const NUDGE_LABELS: Record<FocusNudgeKind, { label: string; description: string }> = {
	stand: { label: "Stand up & stretch", description: "Nudge to get out of the chair" },
	eyes: { label: "Rest your eyes", description: "20-20-20 eye-strain break" },
	hydrate: { label: "Hydrate", description: "Reminder to drink water" },
	posture: { label: "Check your posture", description: "Sit back, screen at eye level" },
};

const RING_SIZE = 240;
const RING_STROKE = 14;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// A small labelled number stepper for the timing config — keeps the durations
// editable without pulling in a whole form library.
function NumberField({
	label,
	value,
	min,
	max,
	suffix,
	onCommit,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	suffix: string;
	onCommit: (value: number) => void;
}) {
	const [draft, setDraft] = useState(String(value));

	useEffect(() => {
		setDraft(String(value));
	}, [value]);

	const commit = () => {
		const parsed = Number(draft);
		if (!Number.isFinite(parsed)) {
			setDraft(String(value));
			return;
		}
		const clamped = Math.min(Math.max(Math.round(parsed), min), max);
		setDraft(String(clamped));
		if (clamped !== value) onCommit(clamped);
	};

	return (
		<label className="grid gap-1.5">
			{label && (
				<span className="text-[11px] font-medium uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
					{label}
				</span>
			)}
			<span className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-0 px-3 py-2 dark:border-neutral-600 dark:bg-neutral-700">
				<input
					type="number"
					min={min}
					max={max}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
					}}
					className="w-full bg-transparent text-sm font-semibold text-neutral-800 outline-none dark:text-neutral-50"
				/>
				<span className="shrink-0 text-[11px] text-neutral-400">{suffix}</span>
			</span>
		</label>
	);
}

export function FocusView({ focus, formatDuration }: MainContentViewsProps) {
	const { config, runtime, stats, remainingMs, progress, isRunning, countdown } = focus;
	const [goalDraft, setGoalDraft] = useState(runtime?.goal ?? "");

	// Mirror the engine's goal into the field whenever it changes upstream (a new
	// cycle, a stop that clears it, or an edit from another window). Done during
	// render rather than in an effect — the React-recommended way to reset state
	// from a changing value, and it avoids a cascading-render lint warning. The
	// engine only broadcasts the goal on blur, so this never stomps mid-typing.
	const externalGoal = runtime?.goal ?? "";
	const [syncedGoal, setSyncedGoal] = useState(externalGoal);
	if (externalGoal !== syncedGoal) {
		setSyncedGoal(externalGoal);
		setGoalDraft(externalGoal);
	}

	const phaseLabel = runtime ? FOCUS_PHASE_LABELS[runtime.phase] : "Ready";
	const isBreak = runtime?.phase === "shortBreak" || runtime?.phase === "longBreak";
	const dashOffset = RING_CIRCUMFERENCE * (1 - (runtime ? progress : 0));
	const roundsThisCycle = config.roundsBeforeLongBreak;
	const currentRound = runtime ? runtime.roundIndex % roundsThisCycle : 0;

	const commitGoal = () => {
		const trimmed = goalDraft.trim();
		if (runtime) {
			if (trimmed !== runtime.goal) focus.setGoal(trimmed);
		}
	};

	const onPrimary = () => {
		if (!runtime) {
			focus.start(goalDraft.trim() || undefined);
		} else {
			focus.toggle();
		}
	};

	return (
		<div className="mx-auto grid w-full max-w-5xl gap-4 pb-6">
			{/* Timer hero */}
			<section
				className={`atlas-card grid place-items-center gap-5 py-7 transition-colors ${
					isBreak ? "bg-emerald-50/60 dark:bg-emerald-950/20" : ""
				}`}
			>
				<div className="relative" style={{ width: RING_SIZE, height: RING_SIZE }}>
					<svg width={RING_SIZE} height={RING_SIZE} className="-rotate-90">
						<circle
							cx={RING_SIZE / 2}
							cy={RING_SIZE / 2}
							r={RING_RADIUS}
							fill="none"
							strokeWidth={RING_STROKE}
							className="stroke-neutral-200 dark:stroke-neutral-700"
						/>
						<circle
							cx={RING_SIZE / 2}
							cy={RING_SIZE / 2}
							r={RING_RADIUS}
							fill="none"
							strokeWidth={RING_STROKE}
							strokeLinecap="round"
							strokeDasharray={RING_CIRCUMFERENCE}
							strokeDashoffset={dashOffset}
							className={`transition-[stroke-dashoffset] duration-500 ${
								isBreak ? "stroke-emerald-500" : "stroke-primary"
							}`}
						/>
					</svg>
					<div className="absolute inset-0 grid place-items-center text-center">
						<div>
							<p
								className={`m-0 text-[12px] font-semibold uppercase tracking-[0.18em] ${
									isBreak ? "text-emerald-600 dark:text-emerald-400" : "text-primary"
								}`}
							>
								{phaseLabel}
							</p>
							<p className="m-0 font-data text-[44px] font-semibold leading-tight text-neutral-800 dark:text-neutral-50">
								{runtime ? countdown : `${config.focusMinutes}:00`}
							</p>
							{runtime?.isPaused && (
								<p className="m-0 text-[11px] font-medium uppercase tracking-wide text-amber-500">
									Paused
								</p>
							)}
						</div>
					</div>
				</div>

				{/* Round dots */}
				<div className="flex items-center gap-2">
					{Array.from({ length: roundsThisCycle }).map((_, index) => {
						const filled = runtime && (runtime.phase === "focus" ? index < currentRound : index <= currentRound);
						return (
							<span
								key={index}
								className={`h-2.5 w-2.5 rounded-full transition-colors ${
									filled ? "bg-primary" : "bg-neutral-300 dark:bg-neutral-600"
								}`}
							/>
						);
					})}
					<span className="ml-1 text-[11px] text-neutral-500 dark:text-neutral-300">
						{Math.min(currentRound + (runtime?.phase === "focus" ? 1 : 0), roundsThisCycle)}/{roundsThisCycle}
					</span>
				</div>

				{/* Goal */}
				<input
					value={goalDraft}
					onChange={(event) => setGoalDraft(event.target.value)}
					onBlur={commitGoal}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
					}}
					placeholder="What are you focusing on?"
					className="w-full max-w-sm rounded-lg border border-neutral-200 bg-neutral-0 px-3 py-2 text-center text-sm text-neutral-800 outline-none transition focus:border-primary dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-50"
				/>

				{/* Controls */}
				<div className="flex items-center gap-2.5">
					<button
						type="button"
						onClick={onPrimary}
						className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-neutral-0 transition hover:opacity-90"
					>
						{isRunning ? <PauseIcon className="h-5 w-5" /> : <PlayIcon className="h-5 w-5" />}
						{!runtime ? "Start focus" : isRunning ? "Pause" : "Resume"}
					</button>
					<button
						type="button"
						onClick={() => focus.skip()}
						disabled={!runtime}
						className="inline-flex items-center gap-2 rounded-full border border-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-600 transition hover:border-primary/40 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-200 dark:hover:text-neutral-0"
						title="Skip to next phase"
					>
						<ForwardIcon className="h-5 w-5" />
						Skip
					</button>
					<button
						type="button"
						onClick={() => focus.stop()}
						disabled={!runtime}
						className="inline-flex items-center gap-2 rounded-full border border-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-600 transition hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-200"
						title="End the focus cycle"
					>
						<StopIcon className="h-5 w-5" />
						Reset
					</button>
				</div>
			</section>

			<div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
				{/* Today's stats */}
				<section className="atlas-card grid content-start gap-4">
					<header className="card-head">
						<h3 className="text-subtitle-small">Today</h3>
					</header>
					<div className="grid grid-cols-2 gap-3">
						<div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-600 dark:bg-neutral-700/50">
							<p className="m-0 text-[28px] font-semibold leading-none text-neutral-800 dark:text-neutral-50">
								{stats.focusRoundsCompleted}
							</p>
							<p className="m-0 mt-1 text-[11px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
								Focus rounds
							</p>
						</div>
						<div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-600 dark:bg-neutral-700/50">
							<p className="m-0 text-[28px] font-semibold leading-none text-neutral-800 dark:text-neutral-50">
								{formatDuration(stats.focusMsCompleted)}
							</p>
							<p className="m-0 mt-1 text-[11px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-300">
								Focused time
							</p>
						</div>
					</div>
					{runtime && (
						<p className="m-0 text-[12px] text-neutral-500 dark:text-neutral-300">
							{isBreak
								? "On a break — step away from the screen."
								: `${Math.ceil(remainingMs / 60000)} min left in this round.`}
						</p>
					)}
				</section>

				{/* Timing config */}
				<section className="atlas-card grid content-start gap-4">
					<header className="card-head">
						<h3 className="text-subtitle-small">Timing</h3>
					</header>
					<div className="grid grid-cols-2 gap-3">
						<NumberField
							label="Focus"
							value={config.focusMinutes}
							min={1}
							max={180}
							suffix="min"
							onCommit={(value) => focus.setConfig({ focusMinutes: value })}
						/>
						<NumberField
							label="Short break"
							value={config.shortBreakMinutes}
							min={1}
							max={60}
							suffix="min"
							onCommit={(value) => focus.setConfig({ shortBreakMinutes: value })}
						/>
						<NumberField
							label="Long break"
							value={config.longBreakMinutes}
							min={1}
							max={120}
							suffix="min"
							onCommit={(value) => focus.setConfig({ longBreakMinutes: value })}
						/>
						<NumberField
							label="Rounds / long break"
							value={config.roundsBeforeLongBreak}
							min={1}
							max={12}
							suffix="rounds"
							onCommit={(value) => focus.setConfig({ roundsBeforeLongBreak: value })}
						/>
					</div>
					<div className="grid gap-2">
						<Toggle
							label="Auto-start breaks"
							description="Begin the break as soon as a focus round ends"
							checked={config.autoStartBreaks}
							onChange={(checked) => focus.setConfig({ autoStartBreaks: checked })}
						/>
						<Toggle
							label="Auto-start next focus"
							description="Jump back into focus when a break ends"
							checked={config.autoStartFocus}
							onChange={(checked) => focus.setConfig({ autoStartFocus: checked })}
						/>
					</div>
				</section>
			</div>

			{/* Wellbeing nudges */}
			<section className="atlas-card grid gap-4">
				<header className="card-head flex items-center justify-between">
					<h3 className="text-subtitle-small">Wellbeing nudges</h3>
				</header>
				<p className="m-0 -mt-2 text-[12px] text-neutral-500 dark:text-neutral-300">
					Gentle desktop reminders while you work. Each fires on its own interval.
				</p>
				<div className="grid gap-2.5 md:grid-cols-2">
					{config.nudges.map((nudge) => {
						const copy = NUDGE_LABELS[nudge.kind];
						return (
							<div
								key={nudge.kind}
								className="grid gap-2.5 rounded-xl border border-neutral-200 bg-neutral-0 p-3 dark:border-neutral-600 dark:bg-neutral-700"
							>
								<Toggle
									label={copy.label}
									description={copy.description}
									checked={nudge.enabled}
									onChange={(checked) =>
										focus.setConfig({
											nudges: config.nudges.map((entry) =>
												entry.kind === nudge.kind ? { ...entry, enabled: checked } : entry,
											),
										})
									}
								/>
								<div className="flex items-center justify-between pl-1">
									<span className="text-[11px] text-neutral-500 dark:text-neutral-300">Every</span>
									<NumberField
										label=""
										value={nudge.everyMinutes}
										min={1}
										max={360}
										suffix="min"
										onCommit={(value) =>
											focus.setConfig({
												nudges: config.nudges.map((entry) =>
													entry.kind === nudge.kind ? { ...entry, everyMinutes: value } : entry,
												),
											})
										}
									/>
								</div>
							</div>
						);
					})}
				</div>
				<Toggle
					label="Only nudge during focus"
					description="Pause reminders on breaks and when no focus round is running"
					checked={config.nudgesOnlyDuringFocus}
					onChange={(checked) => focus.setConfig({ nudgesOnlyDuringFocus: checked })}
				/>
			</section>
		</div>
	);
}
