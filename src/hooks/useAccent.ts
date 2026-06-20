import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { applyAccent, isValidHexColor, readAccent, writeAccent } from "../utils/accent";

/**
 * Manages the user-configurable accent color.
 *
 * - Reads synchronously from localStorage so there is no color flash on mount
 *   (the inline script in index.html already applied it before React ran).
 * - Persists changes to localStorage and broadcasts them to every other window
 *   through the main process so the accent updates live everywhere at once.
 */
export const useAccent = () => {
	const [accent, setAccentState] = useState<string>(() => readAccent());

	// Keep the document in sync before paint whenever our state changes.
	useLayoutEffect(() => {
		applyAccent(accent);
	}, [accent]);

	// Apply + persist + broadcast to the other windows.
	const setAccent = useCallback((value: string) => {
		if (!isValidHexColor(value)) return;
		setAccentState(value);
		writeAccent(value);
		applyAccent(value);
		window.atlas?.setAccent?.(value).catch(() => {
			// Local accent stays applied even if the broadcast fails.
		});
	}, []);

	// React to accent changes coming from another window (e.g. the settings window).
	useEffect(() => {
		const unsubscribe = window.atlas?.onAccentChanged?.((value: string) => {
			if (!isValidHexColor(value)) return;
			writeAccent(value);
			setAccentState(value);
		});
		return () => unsubscribe?.();
	}, []);

	return { accent, setAccent };
};
