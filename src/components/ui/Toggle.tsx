type ToggleProps = {
	label: string;
	description: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
};

export function Toggle({ label, description, checked, onChange }: ToggleProps) {
	return (
		<button
			type="button"
			onClick={() => onChange(!checked)}
			className="grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-0 px-3 py-2.5 text-left shadow-[0_8px_18px_-14px_rgba(15,23,42,0.35)] transition hover:border-primary/40 dark:border-neutral-600 dark:bg-neutral-700"
		>
			<span className="grid gap-0.5">
				<span className="text-body-small font-medium text-neutral-700 dark:text-neutral-50">{label}</span>
				<span className="text-[11px] text-neutral-500 dark:text-neutral-300">{description}</span>
			</span>
			<span
				className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${
					checked
						? "border-primary bg-primary"
						: "border-neutral-300 bg-neutral-200 dark:border-neutral-500 dark:bg-neutral-600"
				}`}
			>
				<span
					className={`inline-block h-4.5 w-4.5 rounded-full bg-neutral-0 shadow transition ${checked ? "translate-x-5" : "translate-x-1"}`}
				/>
			</span>
		</button>
	);
}
