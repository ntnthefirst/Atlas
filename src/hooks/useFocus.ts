import { useCallback, useEffect, useMemo, useState } from "react";
import type { FocusConfig, FocusPhase, FocusState } from "../types";

// Mirrors electron/main.cjs defaultFocusConfig — used as the optimistic initial
// value before the real state arrives over IPC, so the UI never flashes empty.
const FALLBACK_STATE: FocusState = {
	config: {
		focusMinutes: 25,
		shortBreakMinutes: 5,
		longBreakMinutes: 15,
		roundsBeforeLongBreak: 4,
		autoStartBreaks: true,
		autoStartFocus: false,
		nudgesOnlyDuringFocus: true,
		nudges: [
			{ kind: "stand", enabled: false, everyMinutes: 50 },
			{ kind: "eyes", enabled: false, everyMinutes: 20 },
			{ kind: "hydrate", enabled: false, everyMinutes: 90 },
			{ kind: "posture", enabled: false, everyMinutes: 40 },
		],
	},
	runtime: null,
	stats: { day: "", focusRoundsCompleted: 0, focusMsCompleted: 0 },
};

export const FOCUS_PHASE_LABELS: Record<FocusPhase, string> = {
	focus: "Focus",
	shortBreak: "Short break",
	longBreak: "Long break",
};

// Formats milliseconds as a mm:ss countdown (hours fold into minutes).
export function formatCountdown(ms: number): string {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Subscribes to the main-process focus engine (the single source of truth shared
// across all windows) and derives a smooth local countdown. `now` is supplied by
// the caller's existing clock tick so we don't spin up a second timer per window.
export function useFocus(now: number) {
	const [state, setState] = useState<FocusState>(FALLBACK_STATE);

	useEffect(() => {
		let active = true;
		window.atlas
			.getFocusState()
			.then((next) => {
				if (active) setState(next);
			})
			.catch(() => {
				// Keep the fallback state if the engine isn't reachable.
			});
		const unsubscribe = window.atlas.onFocusStateChanged?.((next) => setState(next));
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, []);

	const runtime = state.runtime;
	const remainingMs = useMemo(() => {
		if (!runtime) return 0;
		if (runtime.isPaused) return runtime.remainingMs;
		return Math.max(0, runtime.phaseEndsAt - now);
	}, [runtime, now]);

	const progress = useMemo(() => {
		if (!runtime || runtime.phaseDurationMs <= 0) return 0;
		return Math.min(1, Math.max(0, 1 - remainingMs / runtime.phaseDurationMs));
	}, [runtime, remainingMs]);

	const isRunning = Boolean(runtime && !runtime.isPaused);

	const start = useCallback((goal?: string) => void window.atlas.startFocus(goal), []);
	const pause = useCallback(() => void window.atlas.pauseFocus(), []);
	const resume = useCallback(() => void window.atlas.resumeFocus(), []);
	const skip = useCallback(() => void window.atlas.skipFocusPhase(), []);
	const stop = useCallback(() => void window.atlas.stopFocus(), []);
	const setGoal = useCallback((goal: string) => void window.atlas.setFocusGoal(goal), []);
	const setConfig = useCallback(
		(patch: Partial<FocusConfig>) => void window.atlas.setFocusConfig(patch),
		[],
	);

	// One-press primary action: start when idle, pause/resume otherwise.
	const toggle = useCallback(() => {
		if (!runtime) {
			void window.atlas.startFocus();
		} else if (runtime.isPaused) {
			void window.atlas.resumeFocus();
		} else {
			void window.atlas.pauseFocus();
		}
	}, [runtime]);

	return {
		config: state.config,
		runtime,
		stats: state.stats,
		remainingMs,
		progress,
		isRunning,
		countdown: formatCountdown(remainingMs),
		start,
		pause,
		resume,
		skip,
		stop,
		toggle,
		setGoal,
		setConfig,
	};
}

export type UseFocusReturn = ReturnType<typeof useFocus>;
