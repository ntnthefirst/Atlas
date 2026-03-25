import { PlusIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Select, ThemeModePicker, Toggle } from "../ui";
import type { MainContentViewsProps } from "./types";

type UpdateInfo = {
	hasUpdate: boolean;
	local: string;
	latest: string | null;
	downloadUrl?: string;
	error?: string;
};

export function SettingsView({
	theme,
	onThemeChange,
	newActionLabel,
	newActionCommand,
	onNewActionLabelChange,
	onNewActionCommandChange,
	onAddQuickAction,
	quickActions,
	onRemoveQuickAction,
}: MainContentViewsProps) {
	const [timeFormat, setTimeFormat] = useState("24h");
	const [startWeekOn, setStartWeekOn] = useState("monday");
	const [density, setDensity] = useState("comfortable");
	const [useSoftAnimations, setUseSoftAnimations] = useState(true);
	const [highlightCurrentSession, setHighlightCurrentSession] = useState(true);
	const [pinMapSwitcher, setPinMapSwitcher] = useState(false);
	const [autoUpdates, setAutoUpdates] = useState(() => {
		const stored = localStorage.getItem("atlas.autoUpdates");
		return stored !== null ? JSON.parse(stored) : true;
	});
	const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
	const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);

	useEffect(() => {
		localStorage.setItem("atlas.autoUpdates", JSON.stringify(autoUpdates));
	}, [autoUpdates]);

	const handleCheckUpdates = async () => {
		setIsCheckingUpdates(true);
		try {
			const result = await window.atlas.checkForUpdates();
			setUpdateInfo(result);
		} catch {
			setUpdateInfo({
				hasUpdate: false,
				local: "unknown",
				latest: null,
				error: "Failed to check for updates",
			});
		} finally {
			setIsCheckingUpdates(false);
		}
	};

	const handleDownloadUpdate = () => {
		if (updateInfo?.downloadUrl) {
			void window.atlas.launchApp(`start ${updateInfo.downloadUrl}`);
		}
	};

	return (
		<div className="grid gap-3.5 xl:grid-cols-[1.35fr_1fr]">
			<section className="atlas-card grid gap-4">
				<header className="card-head">
					<h3 className="text-subtitle-small">Appearance</h3>
				</header>
				<div className="grid gap-4">
					<ThemeModePicker
						value={theme}
						onChange={(nextValue) => onThemeChange(nextValue)}
					/>

					<div className="grid gap-3 md:grid-cols-2">
						<Select
							label="Time format"
							value={timeFormat}
							onChange={setTimeFormat}
							options={[
								{ value: "24h", label: "24-hour", description: "13:00, 18:30" },
								{ value: "12h", label: "12-hour", description: "1:00 PM, 6:30 PM" },
							]}
						/>
						<Select
							label="Week starts on"
							value={startWeekOn}
							onChange={setStartWeekOn}
							options={[
								{ value: "monday", label: "Monday", description: "ISO week layout" },
								{ value: "sunday", label: "Sunday", description: "US week layout" },
							]}
						/>
					</div>

					<div className="grid gap-3 md:grid-cols-2">
						<Toggle
							label="Soft panel animations"
							description="Smooth transitions between dashboard, notes and tasks"
							checked={useSoftAnimations}
							onChange={setUseSoftAnimations}
						/>
						<Toggle
							label="Highlight active session"
							description="Keep your current recording context visually pinned"
							checked={highlightCurrentSession}
							onChange={setHighlightCurrentSession}
						/>
					</div>
				</div>
			</section>

			<section className="atlas-card grid gap-4">
				<header className="card-head">
					<h3 className="text-subtitle-small">Workspace controls</h3>
				</header>
				<div className="grid gap-3">
					<Select
						label="Density"
						value={density}
						onChange={setDensity}
						options={[
							{ value: "compact", label: "Compact", description: "More information, tighter spacing" },
							{ value: "comfortable", label: "Comfortable", description: "Balanced spacing" },
							{ value: "spacious", label: "Spacious", description: "Relaxed breathing room" },
						]}
					/>
					<Toggle
						label="Pin map switcher"
						description="Always keep current map visible in the titlebar"
						checked={pinMapSwitcher}
						onChange={setPinMapSwitcher}
					/>

					<div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-600 dark:bg-neutral-700">
						<p className="m-0 text-[11px] uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
							Quick actions
						</p>
						<div className="mt-3 grid gap-2">
							<input
								value={newActionLabel}
								onChange={(event) => onNewActionLabelChange(event.target.value)}
								placeholder="Action label"
							/>
							<input
								value={newActionCommand}
								onChange={(event) => onNewActionCommandChange(event.target.value)}
								placeholder="Command, for example code"
							/>
							<button
								className="action-btn"
								onClick={onAddQuickAction}
							>
								<PlusIcon className="h-4 w-4" />
								Add action
							</button>
						</div>
					</div>

					<ul className="simple-list">
						{quickActions.map((action) => (
							<li key={action.id}>
								<div>
									<span>{action.label}</span>
									<small>{action.command}</small>
								</div>
								<button
									className="action-btn"
									onClick={() => onRemoveQuickAction(action.id)}
								>
									Remove
								</button>
							</li>
						))}
					</ul>
				</div>
			</section>

			<section className="atlas-card grid gap-4 xl:col-span-2">
				<header className="card-head">
					<h3 className="text-subtitle-small">Updates</h3>
				</header>
				<div className="grid gap-4">
					<div className="grid gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-600 dark:bg-neutral-700">
						<div className="flex items-center justify-between">
							<div>
								<p className="text-[11px] uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
									Current version
								</p>
								<p className="mt-1 text-sm font-medium text-neutral-800 dark:text-neutral-100">
									v{updateInfo?.local || "Loading..."}
								</p>
							</div>
							{updateInfo?.hasUpdate && (
								<div className="flex items-center gap-2">
									<div className="flex h-6 w-6 items-center justify-center rounded-full bg-orange-500">
										<span className="text-[10px] font-bold text-white">!</span>
									</div>
									<span className="text-xs font-semibold text-orange-600 dark:text-orange-400">
										Update available
									</span>
								</div>
							)}
						</div>
					</div>

					{updateInfo?.latest && updateInfo.hasUpdate && (
						<div className="grid gap-2 rounded-lg border border-orange-200 bg-orange-50 p-3 dark:border-orange-900 dark:bg-orange-950">
							<p className="text-[11px] uppercase tracking-[0.14em] text-orange-600 dark:text-orange-400">
								New version available
							</p>
							<p className="mt-1 text-sm font-medium text-orange-700 dark:text-orange-300">
								v{updateInfo.latest}
							</p>
							<button
								onClick={handleDownloadUpdate}
								className="action-btn mt-2 bg-orange-600 text-white hover:bg-orange-700 dark:hover:bg-orange-500"
							>
								Download update
							</button>
						</div>
					)}

					{updateInfo?.error && (
						<div className="rounded-lg border border-neutral-200 bg-neutral-100 p-3 dark:border-neutral-600 dark:bg-neutral-800">
							<p className="text-xs text-neutral-600 dark:text-neutral-400">{updateInfo.error}</p>
						</div>
					)}

					<button
						onClick={handleCheckUpdates}
						disabled={isCheckingUpdates}
						className="action-btn disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{isCheckingUpdates ? "Checking..." : "Check for updates"}
					</button>

					<Toggle
						label="Automatic updates"
						description="Automatically check for updates when the app starts"
						checked={autoUpdates}
						onChange={setAutoUpdates}
					/>
				</div>
			</section>
		</div>
	);
}
