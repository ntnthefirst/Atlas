import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
	ArrowLeftIcon,
	ArrowUturnLeftIcon,
	CheckIcon,
	Cog6ToothIcon,
	FolderOpenIcon,
	PencilSquareIcon,
	PlusIcon,
	Squares2X2Icon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import type { DashboardWidgetId, DashboardWidgetPlacement } from "../../../types";
import {
	DASHBOARD_CONFIG_WIDGETS,
	DASHBOARD_GAP_PX,
	DASHBOARD_MAX_COLS,
	DASHBOARD_MIN_COL_PX,
	DASHBOARD_ROW_PX,
	DASHBOARD_WIDGET_CATEGORIES,
	DASHBOARD_WIDGET_DESCRIPTIONS,
	DASHBOARD_WIDGET_LABELS,
	DASHBOARD_WIDGET_SIZES,
	type DashboardWidgetSize,
	createDashboardPlacementId,
} from "./catalog";
import { DashboardWidget, type DashboardWidgetData } from "./DashboardWidget";

const DRAG_MIME = "application/x-atlas-dashboard-card";

// Nominal cell size used only to render faithful, scaled-down previews in the
// gallery — independent of the live grid's responsive column width. Kept small
// enough that even a 4-wide preview stays well under the content width.
const PREVIEW_SCALE = 0.44;
const PREVIEW_COL_PX = 160;
const PREVIEW_ROW_PX = 84;

// Tracks the live (responsive) column count from the grid's own width, so a
// card whose width-span exceeds what currently fits collapses to full width
// instead of overflowing — the "auto align on small screens" behavior.
function useColumnCount(ref: React.RefObject<HTMLElement | null>) {
	const [cols, setCols] = useState(DASHBOARD_MAX_COLS);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const measure = () => {
			const width = node.clientWidth;
			const fit = Math.floor((width + DASHBOARD_GAP_PX) / (DASHBOARD_MIN_COL_PX + DASHBOARD_GAP_PX));
			setCols(Math.min(DASHBOARD_MAX_COLS, Math.max(1, fit || 1)));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [ref]);
	return cols;
}

export function DashboardGrid({ data }: { data: DashboardWidgetData }) {
	const [widgets, setWidgets] = useState<DashboardWidgetPlacement[]>([]);
	const [history, setHistory] = useState<DashboardWidgetPlacement[][]>([]);
	const [editing, setEditing] = useState(false);
	const [galleryOpen, setGalleryOpen] = useState(false);
	const [configuringId, setConfiguringId] = useState<string | null>(null);
	const [dragId, setDragId] = useState<string | null>(null);
	// The order at the moment the drag began, so the whole drag collapses into
	// a single undo step (and we can tell if anything actually moved).
	const dragStartOrderRef = useRef<DashboardWidgetPlacement[] | null>(null);
	const gridRef = useRef<HTMLDivElement | null>(null);
	const cols = useColumnCount(gridRef);
	const reduceMotion = useReducedMotion();

	useEffect(() => {
		window.atlas
			.getDashboardLayout()
			.then((prefs) => setWidgets(prefs.widgets))
			.catch(() => undefined);
		const unsubscribe = window.atlas.onDashboardLayoutChanged?.((prefs) => setWidgets(prefs.widgets));
		return () => unsubscribe?.();
	}, []);

	// Single write path: snapshot the current layout for undo, then update
	// local state and persist (the main process re-broadcasts).
	const commit = (next: DashboardWidgetPlacement[]) => {
		setHistory((stack) => [...stack, widgets].slice(-50));
		setWidgets(next);
		void window.atlas.setDashboardLayout({ widgets: next });
	};

	const undo = () => {
		if (history.length === 0) return;
		const previous = history[history.length - 1];
		setHistory(history.slice(0, -1));
		setWidgets(previous);
		void window.atlas.setDashboardLayout({ widgets: previous });
	};

	const addWidget = (widget: DashboardWidgetId, size: DashboardWidgetSize) => {
		const id = createDashboardPlacementId();
		commit([...widgets, { id, widget, w: size.w, h: size.h }]);
		setGalleryOpen(false);
		// Drop straight into setup for cards that need a target (app/URL).
		if (DASHBOARD_CONFIG_WIDGETS.has(widget)) setConfiguringId(id);
	};

	const removeWidget = (id: string) => commit(widgets.filter((placement) => placement.id !== id));

	const setConfigValue = (id: string, config: string) =>
		commit(widgets.map((placement) => (placement.id === id ? { ...placement, config } : placement)));

	const startDrag = (id: string) => {
		dragStartOrderRef.current = widgets;
		setDragId(id);
	};

	// Live reorder while dragging: as the pointer crosses another card, move the
	// dragged card into that slot in local state immediately. Framer Motion's
	// layout animation then slides every card to its new place, so the grid
	// reflows under the cursor (iOS-style) instead of only snapping on drop.
	const dragOverCard = (targetId: string) => {
		if (!dragId || dragId === targetId) return;
		const from = widgets.findIndex((placement) => placement.id === dragId);
		const to = widgets.findIndex((placement) => placement.id === targetId);
		if (from < 0 || to < 0 || from === to) return;
		const next = widgets.slice();
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		setWidgets(next); // local only — persisted once the drop lands
	};

	// On drop: if the order actually changed, persist it and record a single
	// undo entry for the whole gesture.
	const endDrag = () => {
		const start = dragStartOrderRef.current;
		dragStartOrderRef.current = null;
		setDragId(null);
		if (!start) return;
		const changed = start.map((w) => w.id).join() !== widgets.map((w) => w.id).join();
		if (!changed) return;
		setHistory((stack) => [...stack, start].slice(-50));
		void window.atlas.setDashboardLayout({ widgets });
	};

	const configuring = widgets.find((placement) => placement.id === configuringId) ?? null;

	// The gallery takes over the whole view (rather than a cramped modal) so
	// there's room to browse every widget at a comfortable size.
	if (galleryOpen) {
		return <WidgetGallery data={data} onAdd={addWidget} onClose={() => setGalleryOpen(false)} />;
	}

	return (
		<div className="grid gap-3">
			<div className="flex items-center justify-end gap-2">
				{editing && (
					<>
						<button
							type="button"
							onClick={() => setGalleryOpen(true)}
							className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-700/60"
						>
							<PlusIcon className="h-4 w-4" />
							Add widget
						</button>
						<button
							type="button"
							onClick={undo}
							disabled={history.length === 0}
							title="Undo last change"
							className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-700/60"
						>
							<ArrowUturnLeftIcon className="h-4 w-4" />
							Undo
						</button>
					</>
				)}
				<button
					type="button"
					onClick={() => setEditing((open) => !open)}
					className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
						editing
							? "border-primary bg-primary text-neutral-0"
							: "border-neutral-200 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-700/60"
					}`}
				>
					{editing ? <CheckIcon className="h-4 w-4" /> : <PencilSquareIcon className="h-4 w-4" />}
					{editing ? "Done" : "Edit layout"}
				</button>
			</div>

			<div
				ref={gridRef}
				className="grid"
				style={{
					gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
					gridAutoRows: `${DASHBOARD_ROW_PX}px`,
					gridAutoFlow: "row dense",
					gap: `${DASHBOARD_GAP_PX}px`,
				}}
				onDragOver={(event) => {
					if (editing && dragId) event.preventDefault();
				}}
				onDrop={() => {
					if (editing && dragId) endDrag();
				}}
			>
				<AnimatePresence initial={false}>
					{widgets.map((placement) => {
						const isDragged = dragId === placement.id;
						const isConfigurable = DASHBOARD_CONFIG_WIDGETS.has(placement.widget);
						return (
							<motion.div
								key={placement.id}
								layout
								initial={{ opacity: 0, scale: 0.85 }}
								animate={{ opacity: isDragged ? 0.4 : 1, scale: isDragged ? 0.97 : 1 }}
								exit={{ opacity: 0, scale: 0.85 }}
								transition={
									reduceMotion
										? { duration: 0 }
										: { type: "spring", stiffness: 600, damping: 42, mass: 0.7 }
								}
								className={`atlas-card relative min-h-0 overflow-hidden ${
									isDragged ? "border-dashed border-primary ring-2 ring-primary/40" : ""
								}`}
								style={{
									gridColumn: `span ${Math.min(placement.w, cols)}`,
									gridRow: `span ${placement.h}`,
								}}
							>
								<div className={`h-full overflow-auto ${editing ? "pointer-events-none" : ""}`}>
									<DashboardWidget widget={placement.widget} data={data} config={placement.config} />
								</div>

								{/* Native HTML5 drag lives on a transparent overlay rather than the
								    motion.div, whose own onDragStart/onDragEnd props are reserved by
								    Framer Motion's gesture system and would never fire. */}
								{editing && (
									<>
										<div
											className="absolute inset-0 cursor-grab active:cursor-grabbing"
											draggable
											onDragStart={(event) => {
												event.dataTransfer.setData(DRAG_MIME, placement.id);
												event.dataTransfer.effectAllowed = "move";
												const card = event.currentTarget.parentElement;
												if (card) event.dataTransfer.setDragImage(card, 24, 24);
												startDrag(placement.id);
											}}
											onDragEnd={endDrag}
											onDragOver={(event) => {
												if (dragId && dragId !== placement.id) {
													event.preventDefault();
													dragOverCard(placement.id);
												}
											}}
											onDrop={(event) => {
												event.stopPropagation();
												if (dragId) endDrag();
											}}
										/>
										<div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1">
											{isConfigurable && (
												<button
													type="button"
													onClick={() => setConfiguringId(placement.id)}
													title="Configure"
													aria-label="Configure card"
													className="flex h-6 w-6 items-center justify-center rounded-full border border-neutral-300 bg-neutral-0 text-neutral-700 shadow-sm transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700/60"
												>
													<Cog6ToothIcon className="h-3.5 w-3.5" />
												</button>
											)}
											<button
												type="button"
												onClick={() => removeWidget(placement.id)}
												title="Remove card"
												aria-label="Remove card"
												className="flex h-6 w-6 items-center justify-center rounded-full border border-neutral-300 bg-neutral-0 text-neutral-700 shadow-sm transition-colors hover:bg-red-50 hover:text-red-600 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-red-950/40 dark:hover:text-red-400"
											>
												<XMarkIcon className="h-3.5 w-3.5" />
											</button>
										</div>
									</>
								)}
							</motion.div>
						);
					})}
				</AnimatePresence>

				{widgets.length === 0 && (
					<div className="col-span-full flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-neutral-300 py-12 text-neutral-500 dark:border-neutral-600 dark:text-neutral-300">
						<Squares2X2Icon className="h-8 w-8" />
						<p className="m-0 text-sm">Your dashboard is empty.</p>
						<button
							type="button"
							onClick={() => {
								setEditing(true);
								setGalleryOpen(true);
							}}
							className="text-sm font-medium text-primary"
						>
							Add a widget
						</button>
					</div>
				)}
			</div>

			{configuring && (
				<CardConfigDialog
					widget={configuring.widget}
					initial={configuring.config ?? ""}
					onSave={(value) => {
						setConfigValue(configuring.id, value);
						setConfiguringId(null);
					}}
					onClose={() => setConfiguringId(null)}
				/>
			)}
		</div>
	);
}

// The full-view "Add widget" gallery: replaces the dashboard while open so
// every widget can be shown grouped by category, each with a live, scaled-down
// preview of the sizes it offers. Clicking a size tile drops that card on.
function WidgetGallery({
	data,
	onAdd,
	onClose,
}: {
	data: DashboardWidgetData;
	onAdd: (widget: DashboardWidgetId, size: DashboardWidgetSize) => void;
	onClose: () => void;
}) {
	return (
		<div className="grid gap-5">
			<header className="sticky top-0 z-10 -mx-3.5 -mt-3.5 flex items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-0/90 px-3.5 py-3 backdrop-blur dark:border-neutral-600 dark:bg-neutral-900/90">
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={onClose}
						aria-label="Back to dashboard"
						className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
					>
						<ArrowLeftIcon className="h-5 w-5" />
					</button>
					<div>
						<h2 className="m-0 text-subtitle-small">Add a widget</h2>
						<p className="m-0 text-[12px] text-neutral-500 dark:text-neutral-300">
							Pick a widget and a size — sizes are fixed once added.
						</p>
					</div>
				</div>
				<button
					type="button"
					onClick={onClose}
					className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-neutral-0"
				>
					Done
				</button>
			</header>

			{DASHBOARD_WIDGET_CATEGORIES.map((category) => (
				<section key={category.label} className="grid gap-3">
					<h3 className="m-0 text-[12px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
						{category.label}
					</h3>
					{/* flex-wrap (rather than a fixed-track grid) so a wide preview tile
					    simply wraps to the next line and can never force horizontal
					    overflow. */}
					<div className="flex flex-wrap gap-x-6 gap-y-4">
						{category.widgets.map((widgetId) => (
							<div key={widgetId} className="grid max-w-full content-start gap-2">
								<div>
									<h4 className="m-0 text-body-small font-semibold text-neutral-800 dark:text-neutral-100">
										{DASHBOARD_WIDGET_LABELS[widgetId]}
									</h4>
									<p className="m-0 max-w-[18rem] text-[11px] leading-tight text-neutral-500 dark:text-neutral-300">
										{DASHBOARD_WIDGET_DESCRIPTIONS[widgetId]}
									</p>
								</div>
								<div className="flex flex-wrap items-end gap-2.5">
									{DASHBOARD_WIDGET_SIZES[widgetId].map((size) => (
										<GalleryTile
											key={size.label}
											widget={widgetId}
											size={size}
											data={data}
											onClick={() => onAdd(widgetId, size)}
										/>
									))}
								</div>
							</div>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function GalleryTile({
	widget,
	size,
	data,
	onClick,
}: {
	widget: DashboardWidgetId;
	size: DashboardWidgetSize;
	data: DashboardWidgetData;
	onClick: () => void;
}) {
	const innerW = size.w * PREVIEW_COL_PX + (size.w - 1) * DASHBOARD_GAP_PX;
	const innerH = size.h * PREVIEW_ROW_PX + (size.h - 1) * DASHBOARD_GAP_PX;
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onClick}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onClick();
				}
			}}
			title={`Add ${size.label} (${size.w}×${size.h})`}
			className="group grid cursor-pointer justify-items-center gap-1.5 outline-none"
		>
			<div
				className="overflow-hidden rounded-xl border border-neutral-200 transition-colors group-hover:border-primary group-focus-visible:border-primary dark:border-neutral-600"
				style={{ width: innerW * PREVIEW_SCALE, height: innerH * PREVIEW_SCALE }}
			>
				<div
					className="atlas-card pointer-events-none overflow-hidden"
					style={{
						width: innerW,
						height: innerH,
						transform: `scale(${PREVIEW_SCALE})`,
						transformOrigin: "top left",
					}}
				>
					<div className="h-full overflow-hidden">
						<DashboardWidget widget={widget} data={data} />
					</div>
				</div>
			</div>
			<span className="text-center text-[11px] text-neutral-500 dark:text-neutral-300">
				{size.label} · {size.w}×{size.h}
			</span>
		</div>
	);
}

// Small focused dialog to point a launch/link card at its target. Kept compact
// (a single field plus pickers) rather than a full-view takeover.
function CardConfigDialog({
	widget,
	initial,
	onSave,
	onClose,
}: {
	widget: DashboardWidgetId;
	initial: string;
	onSave: (value: string) => void;
	onClose: () => void;
}) {
	const isApp = widget === "launchApp";
	const [value, setValue] = useState(initial);
	const [runningApps, setRunningApps] = useState<Array<{ name: string; path: string | null }> | null>(null);

	const loadApps = () => {
		if (runningApps) return;
		window.atlas
			.listOpenApps()
			.then(setRunningApps)
			.catch(() => setRunningApps([]));
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-6" onClick={onClose}>
			<div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm" />
			<div
				className="relative grid w-full max-w-md gap-3 rounded-2xl border border-neutral-200 bg-neutral-0 p-5 shadow-xl dark:border-neutral-600 dark:bg-neutral-800"
				onClick={(event) => event.stopPropagation()}
			>
				<h2 className="m-0 text-subtitle-small">{isApp ? "Choose a program" : "Enter a link"}</h2>

				<div className="flex items-center gap-2">
					<input
						type="text"
						autoFocus
						value={value}
						onChange={(event) => setValue(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") onSave(value.trim());
						}}
						placeholder={isApp ? "Program path or command" : "https://example.com"}
						className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-primary dark:border-neutral-600"
					/>
					{isApp && (
						<button
							type="button"
							onClick={async () => {
								const filePath = await window.atlas.pickAppFile();
								if (filePath) setValue(filePath.includes(" ") ? `"${filePath}"` : filePath);
							}}
							className="flex shrink-0 items-center gap-1 rounded-lg border border-neutral-200 px-2.5 py-2 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
						>
							<FolderOpenIcon className="h-4 w-4" />
							Browse
						</button>
					)}
				</div>

				{isApp && (
					<div className="grid gap-1">
						<button
							type="button"
							onClick={loadApps}
							className="justify-self-start text-xs font-medium text-primary"
						>
							{runningApps ? "Running apps" : "Pick from running apps…"}
						</button>
						{runningApps && (
							<div className="max-h-40 overflow-y-auto rounded-lg border border-neutral-200 p-1 dark:border-neutral-600">
								{runningApps.length === 0 && (
									<p className="m-0 px-2 py-1.5 text-xs text-neutral-400">No running apps found.</p>
								)}
								{runningApps.map((app) => (
									<button
										key={app.name}
										type="button"
										disabled={!app.path}
										onClick={() =>
											app.path && setValue(app.path.includes(" ") ? `"${app.path}"` : app.path)
										}
										className="flex w-full items-center truncate rounded-md px-2 py-1.5 text-left text-xs text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-100 dark:hover:bg-neutral-700/60"
									>
										{app.name}
									</button>
								))}
							</div>
						)}
					</div>
				)}

				<div className="mt-1 flex justify-end gap-2">
					<button
						type="button"
						onClick={onClose}
						className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-700/60"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => onSave(value.trim())}
						className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-neutral-0"
					>
						Save
					</button>
				</div>
			</div>
		</div>
	);
}
