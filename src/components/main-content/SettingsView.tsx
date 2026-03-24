import { PlusIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { Select, ThemeModePicker, Toggle } from "../ui";
import type { MainContentViewsProps } from "./types";

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
		</div>
	);
}
