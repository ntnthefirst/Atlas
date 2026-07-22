import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import type { LauncherResult } from "../../types";
import { clampSelectedIndex, moveSelection, reconcileLauncherResults } from "./launcherResults";

// ---------------------------------------------------------------------------
// The launcher's input surface and result-list SHELL (WP-2.1).
//
// Renders inside the pre-created, always-alive popup window (see
// electron/windows/launcher-window.cjs) -- this component itself never
// closes the window, only hides it (window.atlas.hideLauncherWindow()),
// mirroring how the window factory hides rather than destroys on blur.
//
// Results currently come from a fixed stub list (electron/services/
// launcher-providers.cjs) filtered by the query -- WP-2.2 replaces that
// provider without any change needed here; this component only ever calls
// window.atlas.queryLauncher/executeLauncherResult, whatever answers them.
//
// Two things this file exists to get right, both acceptance criteria:
//   1. Sub-50ms open, MEASURED. window.atlas.onLauncherShow hands over the
//      main process's own Date.now() at the moment the hotkey fired
//      (`firedAtMs`); a requestAnimationFrame callback queued right after
//      resetting state fires on the NEXT PAINT -- which, because a hidden
//      BrowserWindow's renderer suspends rAF until shown again, naturally
//      lands on the first paint AFTER this window becomes visible, not some
//      earlier queued frame. That gap is what gets reported back over
//      reportLauncherOpenLatency.
//   2. Results never reorder under an active selection. `selectionActiveRef`
//      flips true the moment the user presses Up/Down, and every subsequent
//      result set is run through reconcileLauncherResults (see that file's
//      header) before being rendered, so a debounced query landing mid-
//      navigation can never yank the row the cursor is on.
// ---------------------------------------------------------------------------

const QUERY_DEBOUNCE_MS = 120;

export function LauncherWindowApp() {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<LauncherResult[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Refs (not state) for values read inside callbacks/effects that must
	// always see the LATEST value without re-subscribing effects on every
	// change -- exactly like NotchInputWindowApp's inputRef pattern, extended
	// to the launcher's own selection/results bookkeeping.
	const resultsRef = useRef<LauncherResult[]>([]);
	const selectionActiveRef = useRef(false);
	// Bumped on every query kicked off; a response is only applied if it's
	// still the most recent one requested, so a slow/stale response (a
	// cancelled-in-spirit in-flight search) can never clobber what a faster,
	// more recent query already rendered.
	const queryTokenRef = useRef(0);

	const applyResults = useCallback((next: LauncherResult[]) => {
		const reconciled = reconcileLauncherResults(resultsRef.current, next, selectionActiveRef.current);
		resultsRef.current = reconciled;
		setResults(reconciled);
		setSelectedIndex((current) => clampSelectedIndex(current, reconciled.length));
	}, []);

	const runQuery = useCallback(
		async (value: string) => {
			const token = ++queryTokenRef.current;
			try {
				const next = await window.atlas.queryLauncher(value);
				if (token !== queryTokenRef.current) {
					return; // superseded by a newer query issued while this one was in flight
				}
				applyResults(next);
			} catch {
				if (token === queryTokenRef.current) {
					applyResults([]);
				}
			}
		},
		[applyResults],
	);

	const hide = useCallback(() => void window.atlas.hideLauncherWindow(), []);

	// Resets to a clean slate every time the launcher is (re)shown -- a stale
	// query or a selection frozen from the last session must never carry over.
	const resetForShow = useCallback(() => {
		setQuery("");
		setBusy(false);
		selectionActiveRef.current = false;
		void runQuery("");
	}, [runQuery]);

	useEffect(() => {
		const theme = (() => {
			try {
				return JSON.parse(localStorage.getItem("atlas.theme") || '"dark"');
			} catch {
				return "dark";
			}
		})();
		document.documentElement.classList.toggle("dark", theme === "dark");

		const unsubscribe = window.atlas.onLauncherShow((meta) => {
			resetForShow();
			// See this file's header: rAF here lands on the first paint after
			// the window becomes visible again, which is exactly what "opens in
			// under 50ms" needs measured.
			window.requestAnimationFrame(() => {
				const latencyMs = Date.now() - meta.firedAtMs;
				void window.atlas.reportLauncherOpenLatency(latencyMs);
			});
			window.requestAnimationFrame(() => inputRef.current?.focus());
		});

		// Covers the very first mount too (nothing has "shown" it yet, since the
		// window is pre-created hidden) so the shell already has its default
		// result set the instant it's first inspected.
		void runQuery("");
		window.requestAnimationFrame(() => inputRef.current?.focus());

		return () => unsubscribe?.();
		// Mount-only: resetForShow/runQuery are stable across renders (their own
		// deps never change identity in a way that matters here).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const handle = window.setTimeout(
			() => {
				void runQuery(query);
			},
			query ? QUERY_DEBOUNCE_MS : 0,
		);
		return () => window.clearTimeout(handle);
	}, [query, runQuery]);

	const execute = useCallback(
		async (index: number, modifier: string | null) => {
			const target = resultsRef.current[index];
			if (!target || busy) {
				return;
			}
			setBusy(true);
			try {
				await window.atlas.executeLauncherResult(target.id, modifier);
			} finally {
				setBusy(false);
				hide();
			}
		},
		[busy, hide],
	);

	const hasResults = results.length > 0;

	return (
		<div className="flex h-screen w-screen items-start justify-center bg-transparent p-2 text-neutral-700 dark:text-neutral-50">
			<motion.div
				initial={{ opacity: 0, scale: 0.97, y: -6 }}
				animate={{ opacity: 1, scale: 1, y: 0 }}
				transition={{ type: "spring", stiffness: 560, damping: 42 }}
				className="flex w-full flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-0 shadow-2xl dark:border-neutral-600 dark:bg-neutral-800"
			>
				<div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-600">
					<MagnifyingGlassIcon className="h-5 w-5 shrink-0 text-neutral-400" />
					<input
						ref={inputRef}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							switch (event.key) {
								case "Escape":
									event.preventDefault();
									hide();
									return;
								case "ArrowDown":
									event.preventDefault();
									selectionActiveRef.current = true;
									setSelectedIndex((current) => moveSelection(current, resultsRef.current.length, 1));
									return;
								case "ArrowUp":
									event.preventDefault();
									selectionActiveRef.current = true;
									setSelectedIndex((current) => moveSelection(current, resultsRef.current.length, -1));
									return;
								case "Enter": {
									event.preventDefault();
									// Modifier-execute: Ctrl+Enter (or Shift+Enter) for a
									// secondary action, exactly like the acceptance criterion
									// asks for -- the stub provider just echoes which one was
									// used (see launcher-providers.cjs#execute) until WP-2.2's
									// real providers give it something to actually mean.
									const modifier = event.ctrlKey ? "ctrl" : event.shiftKey ? "shift" : null;
									void execute(selectedIndex, modifier);
									return;
								}
								default:
									return;
							}
						}}
						placeholder="Search Atlas..."
						className="w-full bg-transparent text-base outline-none placeholder:text-neutral-400"
						autoComplete="off"
						spellCheck={false}
						aria-label="Launcher search"
					/>
				</div>

				<div role="listbox" aria-label="Launcher results" className="max-h-72 overflow-y-auto py-1.5">
					{hasResults ? (
						results.map((result, index) => (
							<div
								key={result.id}
								role="option"
								aria-selected={index === selectedIndex}
								onMouseEnter={() => {
									selectionActiveRef.current = true;
									setSelectedIndex(index);
								}}
								onClick={() => void execute(index, null)}
								className={`mx-1.5 flex cursor-pointer flex-col rounded-xl px-3 py-2 ${
									index === selectedIndex
										? "bg-primary/15 text-neutral-900 dark:text-neutral-0"
										: "text-neutral-600 dark:text-neutral-300"
								}`}
							>
								<span className="text-sm font-medium">{result.title}</span>
								{result.subtitle ? <span className="text-xs text-neutral-400">{result.subtitle}</span> : null}
							</div>
						))
					) : (
						<div className="px-4 py-6 text-center text-sm text-neutral-400">No results</div>
					)}
				</div>
			</motion.div>
		</div>
	);
}
