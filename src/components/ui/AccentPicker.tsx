import { useEffect, useState } from "react";
import { CheckIcon } from "@heroicons/react/24/solid";
import { ACCENT_PRESETS, DEFAULT_ACCENT, isValidHexColor } from "../../utils/accent";

type AccentPickerProps = {
	value: string;
	onChange: (value: string) => void;
};

export function AccentPicker({ value, onChange }: AccentPickerProps) {
	const [hexDraft, setHexDraft] = useState(value);

	useEffect(() => {
		setHexDraft(value);
	}, [value]);

	const normalized = value.trim().toLowerCase();
	const isCustom = !ACCENT_PRESETS.some((preset) => preset.value.toLowerCase() === normalized);

	const commitHex = (raw: string) => {
		const next = raw.trim().startsWith("#") ? raw.trim() : `#${raw.trim()}`;
		if (isValidHexColor(next)) {
			onChange(next.toLowerCase());
		} else {
			setHexDraft(value);
		}
	};

	return (
		<div className="grid gap-3">
			<span className="text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
				Accent color
			</span>

			<div className="flex flex-wrap items-center gap-2.5">
				{ACCENT_PRESETS.map((preset) => {
					const active = preset.value.toLowerCase() === normalized;
					return (
						<button
							key={preset.id}
							type="button"
							title={preset.name}
							aria-label={preset.name}
							aria-pressed={active}
							onClick={() => onChange(preset.value)}
							style={{ backgroundColor: preset.value, color: preset.value }}
							className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-transform duration-150 ${
								active
									? "shadow-[0_0_0_2px_var(--neutral-0),0_0_0_4px_currentColor] dark:shadow-[0_0_0_2px_var(--neutral-800),0_0_0_4px_currentColor]"
									: "hover:scale-110"
							}`}
						>
							{active ? <CheckIcon className="h-4 w-4 text-white" /> : null}
						</button>
					);
				})}
			</div>

			<div className="flex items-center gap-2.5">
				<input
					type="color"
					value={isValidHexColor(value) ? value : DEFAULT_ACCENT}
					onChange={(event) => onChange(event.target.value.toLowerCase())}
					aria-label="Custom accent color"
					className="h-8 w-8 shrink-0 cursor-pointer rounded-lg border border-neutral-300 bg-transparent p-0 dark:border-neutral-500"
				/>
				<input
					value={hexDraft}
					onChange={(event) => setHexDraft(event.target.value)}
					onBlur={() => commitHex(hexDraft)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							commitHex(hexDraft);
						}
					}}
					spellCheck={false}
					placeholder={DEFAULT_ACCENT}
					className="w-28 font-data text-[12px] uppercase"
				/>
				<span className="text-[11px] text-neutral-500 dark:text-neutral-300">
					{isCustom ? "Custom" : ACCENT_PRESETS.find((preset) => preset.value.toLowerCase() === normalized)?.name}
				</span>
			</div>
		</div>
	);
}
