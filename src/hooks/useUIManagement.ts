import { useState, useEffect, useSyncExternalStore } from "react";
import { THEME_KEY, QUICK_ACTIONS_KEY } from "../constants";
import { readStorage } from "../utils/storage";

export const useThemeManagement = () => {
	const [theme, setTheme] = useState<"dark" | "light" | "system">(() => readStorage(THEME_KEY, "light"));
	const prefersDark = useSyncExternalStore(
		(onStoreChange) => {
			const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
			mediaQuery.addEventListener("change", onStoreChange);
			return () => mediaQuery.removeEventListener("change", onStoreChange);
		},
		() => window.matchMedia("(prefers-color-scheme: dark)").matches,
		() => false,
	);
	const resolvedTheme: "dark" | "light" = theme === "system" ? (prefersDark ? "dark" : "light") : theme;

	useEffect(() => {
		document.documentElement.dataset.theme = resolvedTheme;
		document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
		window.atlas.setNativeTheme(theme).catch(() => {
			// Keep UI theme local if native titlebar sync is unavailable.
		});
		localStorage.setItem(THEME_KEY, JSON.stringify(theme));
	}, [theme, resolvedTheme]);

	return { theme, setTheme, resolvedTheme };
};

export const useQuickActionsManagement = () => {
	const [quickActions, setQuickActions] = useState<Array<{ id: string; label: string; command: string }>>(() =>
		readStorage(QUICK_ACTIONS_KEY, [
			{ id: "vscode", label: "Open VS Code", command: "code" },
			{ id: "figma", label: "Open Figma", command: "figma" },
			{ id: "chrome", label: "Open Chrome", command: "chrome" },
		]),
	);
	const [newActionLabel, setNewActionLabel] = useState("");
	const [newActionCommand, setNewActionCommand] = useState("");

	useEffect(() => {
		localStorage.setItem(QUICK_ACTIONS_KEY, JSON.stringify(quickActions));
	}, [quickActions]);

	return {
		quickActions,
		setQuickActions,
		newActionLabel,
		setNewActionLabel,
		newActionCommand,
		setNewActionCommand,
	};
};
