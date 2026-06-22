import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { CheckIcon, ListBulletIcon, NewspaperIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { NotchInputPayload, NotchTabIcon } from "../../types";
import { TASK_PRIORITIES } from "../../types";
import { PRIORITY_META } from "../main-content/taskMeta";

// Defaults mirrored from NotesView so a note captured here drops onto the
// canvas looking like one made there.
const POSTIT_DEFAULTS = {
	w: 250,
	h: 220,
	text: "",
	textColor: "#1f2937",
	boxColor: "#fff2b2",
	fontSize: 16,
};

// Standalone capture popup the notch opens (its own always-on-top window) so
// adding a task or note happens in a focused field instead of being crammed
// into the notch bar.
export function NotchInputWindowApp() {
	const [payload, setPayload] = useState<NotchInputPayload>({ kind: "task" });
	const [value, setValue] = useState("");
	const [priority, setPriority] = useState<NotchTabIcon | string>("none");
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		window.atlas
			.getNotchInputPayload()
			.then((next) => next && setPayload(next))
			.catch(() => undefined);
		const unsubscribe = window.atlas.onNotchInputPayload?.((next) => {
			setPayload(next);
			setValue("");
		});
		const theme = (() => {
			try {
				return JSON.parse(localStorage.getItem("atlas.theme") || '"dark"');
			} catch {
				return "dark";
			}
		})();
		document.documentElement.classList.toggle("dark", theme === "dark");
		window.requestAnimationFrame(() => inputRef.current?.focus());
		return () => unsubscribe?.();
	}, []);

	const isTask = payload.kind !== "note";
	const close = () => void window.atlas.windowClose();

	const submit = async () => {
		const text = value.trim();
		if (!text || busy || !payload.environmentId) {
			if (!text) close();
			return;
		}
		setBusy(true);
		try {
			if (isTask) {
				await window.atlas.createTask(payload.environmentId, text, "", {
					status: payload.status,
					priority: priority as never,
				});
			} else {
				// Append a post-it node carrying the captured text to the notebook.
				const notebook = await window.atlas.getNotebookByMap(payload.environmentId);
				let doc: { version: number; viewport: { x: number; y: number; zoom: number }; nodes: unknown[] };
				try {
					doc = JSON.parse(notebook?.content || "");
				} catch {
					doc = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] };
				}
				if (!doc || typeof doc !== "object" || !Array.isArray(doc.nodes)) {
					doc = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] };
				}
				const maxZ = doc.nodes.reduce(
					(max: number, node) =>
						Math.max(max, typeof (node as { z?: number }).z === "number" ? (node as { z: number }).z : 0),
					0,
				);
				doc.nodes.push({
					id: crypto.randomUUID(),
					type: "postit",
					x: 120 + Math.round(Math.random() * 80),
					y: 120 + Math.round(Math.random() * 80),
					z: maxZ + 1,
					...POSTIT_DEFAULTS,
					text,
				});
				await window.atlas.updateNotebookByMap(payload.environmentId, JSON.stringify(doc));
			}
			close();
		} catch {
			setBusy(false);
		}
	};

	const Icon = isTask ? ListBulletIcon : NewspaperIcon;
	const title = isTask
		? `Add task${payload.columnLabel ? ` · ${payload.columnLabel}` : ""}`
		: "Quick note";

	return (
		<div className="flex h-screen w-screen items-center justify-center bg-transparent p-2 text-neutral-700 dark:text-neutral-50">
			<motion.div
				initial={{ opacity: 0, scale: 0.96, y: -6 }}
				animate={{ opacity: 1, scale: 1, y: 0 }}
				transition={{ type: "spring", stiffness: 520, damping: 40 }}
				className="flex w-full flex-col gap-3 rounded-2xl border border-neutral-200 bg-neutral-0 p-4 shadow-2xl dark:border-neutral-600 dark:bg-neutral-800"
			>
				<div className="flex items-center justify-between">
					<span className="flex items-center gap-2 text-sm font-semibold">
						<Icon className="h-4.5 w-4.5 text-primary" />
						{title}
					</span>
					<button
						type="button"
						onClick={close}
						aria-label="Close"
						className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700/60"
					>
						<XMarkIcon className="h-4 w-4" />
					</button>
				</div>

				<textarea
					ref={inputRef}
					value={value}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void submit();
						}
						if (event.key === "Escape") close();
					}}
					rows={isTask ? 2 : 4}
					placeholder={
						isTask
							? `What needs doing${payload.environmentName ? ` in ${payload.environmentName}` : ""}?`
							: "Jot something down…"
					}
					className="w-full resize-none rounded-xl border border-neutral-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-primary dark:border-neutral-600"
				/>

				<div className="flex items-center justify-between gap-2">
					{isTask ? (
						<div className="flex items-center gap-1">
							{TASK_PRIORITIES.map((option) => (
								<button
									key={option}
									type="button"
									onClick={() => setPriority(option)}
									title={PRIORITY_META[option].label}
									aria-label={PRIORITY_META[option].label}
									className={`h-5 w-5 rounded-full border transition-transform ${PRIORITY_META[option].dot} ${
										priority === option
											? "scale-110 border-neutral-800 dark:border-neutral-0"
											: "border-transparent opacity-60 hover:opacity-100"
									}`}
								/>
							))}
						</div>
					) : (
						<span className="text-[11px] text-neutral-400">Saved to this environment's notebook</span>
					)}
					<button
						type="button"
						onClick={() => void submit()}
						disabled={!value.trim() || busy}
						className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-neutral-0 transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
					>
						<CheckIcon className="h-4 w-4" />
						{isTask ? "Add task" : "Save note"}
					</button>
				</div>
			</motion.div>
		</div>
	);
}
