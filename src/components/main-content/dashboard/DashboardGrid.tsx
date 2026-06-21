import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	ArrowUturnLeftIcon,
	CheckIcon,
	PencilSquareIcon,
	PlusIcon,
	Squares2X2Icon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import type { DashboardWidgetId, DashboardWidgetPlacement } from "../../../types";
import {
	DASHBOARD_GAP_PX,
	DASHBOARD_MAX_COLS,
	DASHBOARD_MIN_COL_PX,
	DASHBOARD_ROW_PX,
	DASHBOARD_WIDGET_DESCRIPTIONS,
	DASHBOARD_WIDGET_IDS,
	DASHBOARD_WIDGET_LABELS,
	DASHBOARD_WIDGET_SIZES,
	type DashboardWidgetSize,
	createDashboardPlacementId,
} from "./catalog";
import { DashboardWidget, type DashboardWidgetData } from "./DashboardWidget";

const DRAG_MIME = "application/x-atlas-dashboard-card";

// Nominal cell size used only to render faithful, scaled-down previews in the
// gallery — independent of the live grid's responsive column width.
const PREVIEW_SCALE = 0.42;
const PREVIEW_COL_PX = 220;
const PREVIEW_ROW_PX = 88;

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
	const [dragId, setDragId] = useState<string | null>(null);
	const gridRef = useRef<HTMLDivElement | null>(null);
	const cols = useColumnCount(gridRef);

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
		commit([...widgets, { id: createDashboardPlacementId(), widget, w: size.w, h: size.h }]);
		setGalleryOpen(false);
	};

	const removeWidget = (id: string) => commit(widgets.filter((placement) => placement.id !== id));

	// Move the dragged card to just before the target card (or to the end when
	// dropped on empty grid space), then persist the new order.
	const reorder = (draggedId: string, targetId: string | null) => {
		if (draggedId === targetId) return;
		const from = widgets.findIndex((placement) => placement.id === draggedId);
		if (from < 0) return;
		const next = widgets.slice();
		const [moved] = next.splice(from, 1);
		const targetIndex = targetId ? next.findIndex((placement) => placement.id === targetId) : next.length;
		next.splice(targetIndex < 0 ? next.length : targetIndex, 0, moved);
		commit(next);
	};

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
					if (editing && dragId) reorder(dragId, null);
					setDragId(null);
				}}
			>
				{widgets.map((placement) => (
					<div
						key={placement.id}
						draggable={editing}
						onDragStart={(event) => {
							event.dataTransfer.setData(DRAG_MIME, placement.id);
							setDragId(placement.id);
						}}
						onDragEnd={() => setDragId(null)}
						onDragOver={(event) => {
							if (editing && dragId && dragId !== placement.id) event.preventDefault();
						}}
						onDrop={(event) => {
							event.stopPropagation();
							if (editing && dragId) reorder(dragId, placement.id);
							setDragId(null);
						}}
						className={`atlas-card relative min-h-0 overflow-hidden ${
							editing ? "atlas-dashboard-jiggle cursor-grab ring-1 ring-primary/30 active:cursor-grabbing" : ""
						} ${dragId === placement.id ? "opacity-50" : ""}`}
						style={{
							gridColumn: `span ${Math.min(placement.w, cols)}`,
							gridRow: `span ${placement.h}`,
						}}
					>
						<div className={`h-full overflow-auto ${editing ? "pointer-events-none" : ""}`}>
							<DashboardWidget widget={placement.widget} data={data} />
						</div>

						{editing && (
							<button
								type="button"
								onClick={() => removeWidget(placement.id)}
								title="Remove card"
								aria-label="Remove card"
								className="absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-neutral-300 bg-neutral-0 text-neutral-700 shadow-sm transition-colors hover:bg-red-50 hover:text-red-600 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-red-950/40 dark:hover:text-red-400"
							>
								<XMarkIcon className="h-3.5 w-3.5" />
							</button>
						)}
					</div>
				))}

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

			{galleryOpen && (
				<WidgetGallery data={data} onAdd={addWidget} onClose={() => setGalleryOpen(false)} />
			)}
		</div>
	);
}

// The iOS-style "Add Widget" gallery: every widget shown with a live,
// scaled-down preview of each size it offers. Clicking a size tile drops that
// card onto the dashboard.
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
		<div className="fixed inset-0 z-50 flex items-center justify-center p-6" onClick={onClose}>
			<div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm" />
			<div
				className="relative flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-0 shadow-xl dark:border-neutral-600 dark:bg-neutral-800"
				onClick={(event) => event.stopPropagation()}
			>
				<header className="flex items-center justify-between border-b border-neutral-200 px-5 py-3.5 dark:border-neutral-600">
					<div>
						<h2 className="m-0 text-subtitle-small">Add widget</h2>
						<p className="m-0 text-[12px] text-neutral-500 dark:text-neutral-300">
							Pick a widget and a size. Sizes are fixed once added.
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
					>
						<XMarkIcon className="h-5 w-5" />
					</button>
				</header>

				<div className="grid gap-5 overflow-y-auto p-5">
					{DASHBOARD_WIDGET_IDS.map((widgetId) => (
						<section key={widgetId} className="grid gap-2">
							<div>
								<h3 className="m-0 text-body-regular font-semibold text-neutral-800 dark:text-neutral-100">
									{DASHBOARD_WIDGET_LABELS[widgetId]}
								</h3>
								<p className="m-0 text-[12px] text-neutral-500 dark:text-neutral-300">
									{DASHBOARD_WIDGET_DESCRIPTIONS[widgetId]}
								</p>
							</div>
							<div className="flex flex-wrap items-end gap-3">
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
						</section>
					))}
				</div>
			</div>
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
			className="group grid cursor-pointer gap-1.5 outline-none"
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
