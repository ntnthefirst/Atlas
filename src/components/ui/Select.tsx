import { ChevronDownIcon, CheckIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";

type SelectOption = {
	value: string;
	label: string;
	description?: string;
};

type SelectProps = {
	label: string;
	value: string;
	options: SelectOption[];
	onChange: (nextValue: string) => void;
};

export function Select({ label, value, options, onChange }: SelectProps) {
	const [isOpen, setIsOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	const selectedOption = useMemo(() => options.find((option) => option.value === value) ?? null, [options, value]);

	useEffect(() => {
		const onPointerDown = (event: MouseEvent) => {
			if (!rootRef.current) {
				return;
			}
			if (!rootRef.current.contains(event.target as Node)) {
				setIsOpen(false);
			}
		};

		const onEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setIsOpen(false);
			}
		};

		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onEscape);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onEscape);
		};
	}, []);

	return (
		<div
			className="relative grid gap-2"
			ref={rootRef}
		>
			<span className="text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
				{label}
			</span>
			<button
				type="button"
				onClick={() => setIsOpen((current) => !current)}
				className="inline-flex w-full items-center justify-between rounded-xl border border-neutral-200 bg-neutral-0 px-3 py-2 text-left text-body-small text-neutral-700 shadow-[0_8px_18px_-14px_rgba(15,23,42,0.35)] transition hover:border-primary/40 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-50"
			>
				<span>{selectedOption?.label ?? "Select option"}</span>
				<ChevronDownIcon className={`h-4 w-4 transition ${isOpen ? "rotate-180" : ""}`} />
			</button>

			{isOpen && (
				<div className="absolute left-0 top-[calc(100%+8px)] z-20 grid w-full gap-1 rounded-xl border border-neutral-200 bg-neutral-0 p-1.5 shadow-[0_18px_32px_-16px_rgba(15,23,42,0.45)] dark:border-neutral-600 dark:bg-neutral-800">
					{options.map((option) => {
						const isSelected = option.value === value;
						return (
							<button
								key={option.value}
								type="button"
								onClick={() => {
									onChange(option.value);
									setIsOpen(false);
								}}
								className={`grid w-full grid-cols-[1fr_auto] items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${
									isSelected
										? "bg-primary/10 text-primary"
										: "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-50 dark:hover:bg-neutral-700"
								}`}
							>
								<span className="grid gap-0.5">
									<span className="text-body-small font-medium">{option.label}</span>
									{option.description ? (
										<span className="text-[11px] text-neutral-500 dark:text-neutral-300">
											{option.description}
										</span>
									) : null}
								</span>
								{isSelected ? <CheckIcon className="h-4 w-4" /> : <span className="h-4 w-4" />}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
