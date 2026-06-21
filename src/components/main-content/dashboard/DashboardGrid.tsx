import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	ArrowPathIcon,
	CheckIcon,
	MinusIcon,
	PencilSquareIcon,
	PlusIcon,
	Squares2X2Icon,
	TrashIcon,
} from "@heroicons/react/24/outline";
import type { DashboardWidgetId, DashboardWidgetPlacement } from "../../../types";
import {
	DASHBOARD_GAP_PX,
	DASHBOARD_MAX_COLS,
	DASHBOARD_MIN_COL_PX,
	DASHBOARD_ROW_PX,
	DASHBOARD_WIDGET_DEFAULT_SIZE,
	DASHBOARD_WIDGET_DESCRIPTIONS,
	DASHBOARD_WIDGET_IDS,
	DASHBOARD_WIDGET_LABELS,
	DASHBOARD_WIDGET_MAX_H,
	DASHBOARD_WIDGET_MIN_H,
	createDashboardPlacementId,
	createDefaultDashboardWidgets,
} from "./catalog";
import { DashboardWidget, type DashboardWidgetData } from "./DashboardWidget";

const DRAG_MIME = "application/x-atlas-dashboard-card";

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
	const [editing, setEditing] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	const [dragId, setDragId] = useState<string | null>(null);
	const gridRef = useRef<HTMLDivElement | null>(null);
	const cols = useColumnCount(gridRef);

	useEffect(() => {
		window.atlas
			.getDashboardLayout()
			.then((prefs) => setWidgets(prefs.widgets))
			.catch(() => setWidgets(createDefaultDashboardWidgets()));
		const unsubscribe = window.atlas.onDashboardLayoutChanged?.((prefs) => setWidgets(prefs.widgets));
		return () => unsubscribe?.();
	}, []);

	// Single write path: update local state and persist. The main process
	// re-broadcasts, but the local set keeps the UI snappy.
	const commit = (next: DashboardWidgetPlacement[]) => {
		setWidgets(next);
		void window.atlas.setDashboardLayout({ widgets: next });
	};

	const addWidget = (widget: DashboardWidgetId) => {
		const size = DASHBOARD_WIDGET_DEFAULT_SIZE[widget] ?? { w: 2, h: 1 };
		commit([...widgets, { id: createDashboardPlacementId(), widget, w: size.w, h: size.h }]);
		setAddOpen(false);
	};

	const removeWidget = (id: string) => commit(widgets.filter((placement) => placement.id !== id));

	const resizeWidget = (id: string, key: "w" | "h", delta: number) => {
		const max = key === "w" ? DASHBOARD_MAX_COLS : DASHBOARD_WIDGET_MAX_H;
		const min = key === "w" ? 1 : DASHBOARD_WIDGET_MIN_H;
		commit(
			widgets.map((placement) =>
				placement.id === id
					? { ...placement, [key]: Math.min(max, Math.max(min, placement[key] + delta)) }
					: placement,
			),
		);
	};

	// Move the dragged card to just before the target card (or to the end when
	// dropped on the trailing zone), then persist the new order.
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

	const placedWidgets = new Set(widgets.map((placement) => placement.widget));

	return (
		<div className="grid gap-3">
			<div className="flex items-center justify-end gap-2">
				{editing && (
					<>
						<div className="relative">
							<button
								type="button"
								onClick={() => setAddOpen((open) => !open)}
								className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-700/60"
							>
								<PlusIcon className="h-4 w-4" />
								Add card
							</button>
							{addOpen && (
								<>
									<div className="fixed inset-0 z-40" onClick={() => setAddOpen(false)} />
									<div className="absolute right-0 top-full z-50 mt-1 grid max-h-80 w-72 gap-0.5 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-0 p-1.5 shadow-lg dark:border-neutral-600 dark:bg-neutral-800">
										{DASHBOARD_WIDGET_IDS.map((widgetId) => (
											<button
												key={widgetId}
												type="button"
												onClick={() => addWidget(widgetId)}
												className="grid gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700/60"
											>
												<span className="flex items-center gap-1.5 text-sm text-neutral-800 dark:text-neutral-100">
													{DASHBOARD_WIDGET_LABELS[widgetId]}
													{placedWidgets.has(widgetId) && (
														<span className="rounded bg-neutral-200 px-1 text-[9px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-700 dark:text-neutral-300">
															added
														</span>
													)}
												</span>
												<span className="text-[11px] text-neutral-500 dark:text-neutral-300">
													{DASHBOARD_WIDGET_DESCRIPTIONS[widgetId]}
												</span>
											</button>
										))}
									</div>
								</>
							)}
						</div>
						<button
							type="button"
							onClick={() => commit(createDefaultDashboardWidgets())}
							title="Reset to default layout"
							className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-700/60"
						>
							<ArrowPathIcon className="h-4 w-4" />
							Reset
						</button>
					</>
				)}
				<button
					type="button"
					onClick={() => {
						setEditing((open) => !open);
						setAddOpen(false);
					}}
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
							editing ? "cursor-grab ring-1 ring-primary/30 active:cursor-grabbing" : ""
						} ${dragId === placement.id ? "opacity-50" : ""}`}
						style={{
							gridColumn: `span ${Math.min(placement.w, cols)}`,
							gridRow: `span ${placement.h}`,
						}}
					>
						<div className="h-full overflow-auto">
							<DashboardWidget widget={placement.widget} data={data} />
						</div>

						{editing && (
							<div className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-0/95 p-0.5 shadow-sm backdrop-blur dark:border-neutral-600 dark:bg-neutral-800/95">
								<SizeControl
									label="W"
									value={placement.w}
									onDecrease={() => resizeWidget(placement.id, "w", -1)}
									onIncrease={() => resizeWidget(placement.id, "w", 1)}
								/>
								<SizeControl
									label="H"
									value={placement.h}
									onDecrease={() => resizeWidget(placement.id, "h", -1)}
									onIncrease={() => resizeWidget(placement.id, "h", 1)}
								/>
								<button
									type="button"
									onClick={() => removeWidget(placement.id)}
									title="Remove card"
									aria-label="Remove card"
									className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-neutral-300 dark:hover:bg-red-950/40 dark:hover:text-red-400"
								>
									<TrashIcon className="h-3.5 w-3.5" />
								</button>
							</div>
						)}
					</div>
				))}

				{widgets.length === 0 && (
					<div className="col-span-full flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-neutral-300 py-12 text-neutral-500 dark:border-neutral-600 dark:text-neutral-300">
						<Squares2X2Icon className="h-8 w-8" />
						<p className="m-0 text-sm">Your dashboard is empty.</p>
						{!editing && (
							<button
								type="button"
								onClick={() => setEditing(true)}
								className="text-sm font-medium text-primary"
							>
								Edit layout to add cards
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function SizeControl({
	label,
	value,
	onDecrease,
	onIncrease,
}: {
	label: string;
	value: number;
	onDecrease: () => void;
	onIncrease: () => void;
}) {
	return (
		<div className="flex items-center">
			<button
				type="button"
				onClick={onDecrease}
				title={`Decrease ${label}`}
				aria-label={`Decrease ${label}`}
				className="flex h-6 w-6 items-center justify-center text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-300 dark:hover:text-neutral-0"
			>
				<MinusIcon className="h-3 w-3" />
			</button>
			<span className="w-7 text-center font-data text-[11px] text-neutral-600 dark:text-neutral-200">
				{label}
				{value}
			</span>
			<button
				type="button"
				onClick={onIncrease}
				title={`Increase ${label}`}
				aria-label={`Increase ${label}`}
				className="flex h-6 w-6 items-center justify-center text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-300 dark:hover:text-neutral-0"
			>
				<PlusIcon className="h-3 w-3" />
			</button>
		</div>
	);
}
