type ThemeMode = "dark" | "light" | "system";

type ThemeModePickerProps = {
	value: ThemeMode;
	onChange: (nextValue: ThemeMode) => void;
};

const themeModes: Array<{ value: ThemeMode; label: string; hint: string }> = [
	{ value: "light", label: "Light Mode", hint: "Bright neutral workspace" },
	{ value: "dark", label: "Dark Mode", hint: "Focused low-light look" },
	{ value: "system", label: "System Preferences", hint: "Auto match your OS" },
];

export function ThemeModePicker({ value, onChange }: ThemeModePickerProps) {
	return (
		<div className="grid gap-2">
			<span className="text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
				Theme
			</span>
			<div className="grid gap-3 xl:grid-cols-3">
				{themeModes.map((mode) => {
					const isActive = mode.value === value;
					const isDark = mode.value === "dark";
					const isSystem = mode.value === "system";

					return (
						<button
							key={mode.value}
							type="button"
							onClick={() => onChange(mode.value)}
							className={`grid gap-3 rounded-2xl border p-2.5 text-left transition ${
								isActive
									? "border-primary/70 bg-primary/10 shadow-[0_0_0_1px_rgba(125,83,222,0.35)]"
									: "border-neutral-200 bg-neutral-0 hover:border-primary/40 dark:border-neutral-600 dark:bg-neutral-800"
							}`}
						>
							<div
								className={`relative overflow-hidden rounded-xl border ${
									isDark ? "border-neutral-600 bg-neutral-800" : "border-neutral-200 bg-neutral-50"
								}`}
							>
								<div
									className={`h-5 w-full border-b ${isDark ? "border-neutral-600 bg-neutral-700" : "border-neutral-200 bg-neutral-100"}`}
								/>
								<div className="grid grid-cols-[34%_1fr]">
									<div
										className={`h-18.5 border-r ${isDark ? "border-neutral-600 bg-neutral-700" : "border-neutral-200 bg-neutral-100"}`}
									/>
									<div className="grid gap-1.5 p-1.5">
										<div
											className={`h-4 rounded ${isDark ? "bg-neutral-600" : "bg-neutral-200"}`}
										/>
										<div
											className={`h-4 rounded ${isDark ? "bg-neutral-600" : "bg-neutral-200"}`}
										/>
										<div
											className={`h-4 rounded ${isDark ? "bg-neutral-600" : "bg-neutral-200"}`}
										/>
									</div>
								</div>
								{isSystem ? (
									<div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 border-l border-neutral-500/40 bg-neutral-900/80" />
								) : null}
							</div>

							<div className="grid grid-cols-[auto_1fr] items-center gap-2 px-1 pb-0.5">
								<span
									className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-semibold ${
										isActive
											? "border-primary bg-primary text-neutral-0"
											: "border-neutral-300 text-transparent dark:border-neutral-500"
									}`}
								>
									●
								</span>
								<span className="grid gap-0.5">
									<span className="text-body-small font-medium text-neutral-700 dark:text-neutral-50">
										{mode.label}
									</span>
									<span className="text-[11px] text-neutral-500 dark:text-neutral-300">
										{mode.hint}
									</span>
								</span>
							</div>
						</button>
					);
				})}
			</div>
		</div>
	);
}
