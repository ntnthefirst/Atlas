import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckIcon, DocumentTextIcon, SparklesIcon } from "@heroicons/react/24/outline";
import type { MapItem, TaskColumn } from "../types";
import { parseCapture, type ParsedCapture } from "../utils/smartParse";
import { PRIORITY_META } from "./main-content/taskMeta";

interface SmartCaptureProps {
	open: boolean;
	onClose: () => void;
	environments: MapItem[];
	currentEnvironmentId: string | null;
	columnsFor: (environmentId: string) => TaskColumn[];
	onSubmit: (result: ParsedCapture) => void | Promise<void>;
	accent: string;
}

const SYNTAX_HINTS = [
	{ token: "!high", meaning: "priority" },
	{ token: "tomorrow", meaning: "due date" },
	{ token: "@work", meaning: "environment" },
	{ token: "#tag", meaning: "label" },
	{ token: "note:", meaning: "make a note" },
];

// A single command-bar surface: type one line, Atlas reads it locally and shows
// exactly where it will land, then Enter files it — no fields, no menus.
export function SmartCapture({
	open,
	onClose,
	environments,
	currentEnvironmentId,
	columnsFor,
	onSubmit,
	accent,
}: SmartCaptureProps) {
	const [text, setText] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!open) return;
		setText("");
		const id = requestAnimationFrame(() => inputRef.current?.focus());
		return () => cancelAnimationFrame(id);
	}, [open]);

	const parsed = useMemo<ParsedCapture | null>(() => {
		const trimmed = text.trim();
		if (!trimmed) return null;
		return parseCapture(trimmed, { environments, currentEnvironmentId, columnsFor });
	}, [text, environments, currentEnvironmentId, columnsFor]);

	const submit = useCallback(async () => {
		if (!parsed || submitting) return;
		setSubmitting(true);
		try {
			await onSubmit(parsed);
		} finally {
			setSubmitting(false);
		}
	}, [parsed, submitting, onSubmit]);

	const isNote = parsed?.kind === "note";

	return (
		<AnimatePresence>
			{open && (
				<motion.div
					className="smart-capture-overlay"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.12 }}
					onMouseDown={onClose}
				>
					<motion.div
						className="smart-capture-panel"
						initial={{ opacity: 0, y: -12, scale: 0.985 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: -12, scale: 0.985 }}
						transition={{ duration: 0.16, ease: "easeOut" }}
						onMouseDown={(event) => event.stopPropagation()}
					>
						<div className="smart-capture-input-row">
							<SparklesIcon className="h-5 w-5 shrink-0" style={{ color: accent }} />
							<input
								ref={inputRef}
								value={text}
								onChange={(event) => setText(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										void submit();
									} else if (event.key === "Escape") {
										event.preventDefault();
										onClose();
									}
								}}
								placeholder="Capture anything — e.g. Fix login bug !high tomorrow @work #api"
								className="smart-capture-input"
								spellCheck={false}
								autoComplete="off"
							/>
							<kbd className="smart-capture-kbd">Enter</kbd>
						</div>

						{parsed ? (
							<div className="smart-capture-preview">
								<div className="smart-capture-title-row">
									<span className={`smart-capture-kind ${isNote ? "is-note" : "is-task"}`}>
										{isNote ? <DocumentTextIcon className="h-3.5 w-3.5" /> : <CheckIcon className="h-3.5 w-3.5" />}
										{isNote ? "Note" : "Task"}
									</span>
									<span className="smart-capture-title">{parsed.title}</span>
								</div>

								<div className="smart-capture-chips">
									{parsed.environmentName && (
										<span className="smart-chip">
											<span className="smart-chip-dot" style={{ backgroundColor: accent }} />
											{parsed.environmentName}
										</span>
									)}
									{parsed.columnLabel && <span className="smart-chip">→ {parsed.columnLabel}</span>}
									{parsed.priority !== "none" && (
										<span className="smart-chip">
											<span className={`smart-chip-dot ${PRIORITY_META[parsed.priority].dot}`} />
											{PRIORITY_META[parsed.priority].label}
										</span>
									)}
									{parsed.dueLabel && <span className="smart-chip is-due">{parsed.dueLabel}</span>}
									{parsed.tags.map((tag) => (
										<span key={tag} className="smart-chip is-tag">
											#{tag}
										</span>
									))}
								</div>
							</div>
						) : (
							<div className="smart-capture-hints">
								{SYNTAX_HINTS.map((hint) => (
									<span key={hint.token} className="smart-capture-hint">
										<code>{hint.token}</code>
										<span>{hint.meaning}</span>
									</span>
								))}
							</div>
						)}

						<div className="smart-capture-footer">
							<span>Atlas reads this on-device and files it automatically.</span>
							<span className="smart-capture-footer-keys">
								<kbd>Enter</kbd> add
								<kbd>Esc</kbd> dismiss
							</span>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
