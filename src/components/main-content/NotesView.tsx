import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent } from "react";
import { PhotoIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import type { NotebookDocument, NotebookNode } from "../../types";
import type { MainContentViewsProps } from "./types";

const EMPTY_NOTEBOOK: NotebookDocument = {
	version: 1,
	viewport: { x: 0, y: 0, zoom: 1 },
	nodes: [],
};

const DEFAULT_TEXT_COLOR = "#1f2937";
const DEFAULT_BOX_COLOR = "#f8fafc";
const DEFAULT_POSTIT_BOX_COLOR = "#fff2b2";
const DEFAULT_TEXT_SIZE = 18;
const DEFAULT_POSTIT_TEXT_SIZE = 16;
const LONG_PRESS_MS = 220;
const NOTEBOOK_CLIPBOARD_MIME = "application/x-atlas-notebook-node";
const TEXT_NODE_PADDING_X = 12;
const TEXT_NODE_PADDING_Y = 12;
const TEXT_SIZE_OPTIONS = [12, 14, 16, 18, 22, 26, 32, 40, 52, 64];

type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const sanitizeHex = (value: string, fallback: string) => {
	const cleaned = value.trim();
	if (!cleaned) {
		return fallback;
	}
	if (/^#([0-9a-fA-F]{6})$/.test(cleaned)) {
		return cleaned;
	}
	return fallback;
};

const defaultFontSizeForType = (type: NotebookNode["type"]) =>
	type === "postit" ? DEFAULT_POSTIT_TEXT_SIZE : DEFAULT_TEXT_SIZE;

const normalizeFontSize = (node: NotebookNode) => {
	if (typeof node.fontSize === "number") {
		return clamp(node.fontSize, 12, 64);
	}
	return defaultFontSizeForType(node.type);
};

const toDataUrl = (blob: Blob) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
		reader.onerror = () => reject(new Error("Could not read media file."));
		reader.readAsDataURL(blob);
	});

const measureTextNodeSize = (text: string, fontSize: number) => {
	const lines = (text || " ").replace(/\r\n/g, "\n").split("\n");
	const canvas = document.createElement("canvas");
	const context = canvas.getContext("2d");
	if (!context) {
		return {
			w: 160,
			h: Math.max(44, Math.ceil(fontSize * 1.45 + TEXT_NODE_PADDING_Y * 2)),
		};
	}

	context.font = `${fontSize}px Poppins, sans-serif`;
	const longestLine = lines.reduce((acc, line) => Math.max(acc, context.measureText(line || " ").width), 0);
	const lineHeight = fontSize * 1.45;
	return {
		w: clamp(Math.ceil(longestLine + TEXT_NODE_PADDING_X * 2), 80, 1400),
		h: clamp(Math.ceil(lines.length * lineHeight + TEXT_NODE_PADDING_Y * 2), 40, 1400),
	};
};

const clampIndex = (index: number, length: number) => clamp(index, 0, Math.max(0, length - 1));

const percentile = (values: number[], p: number) => {
	if (!values.length) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (p / 100) * (sorted.length - 1);
	const low = Math.floor(rank);
	const high = Math.ceil(rank);
	if (low === high) {
		return sorted[low];
	}
	const weight = rank - low;
	return sorted[low] * (1 - weight) + sorted[high] * weight;
};

const cloneNodeForPaste = (source: NotebookNode, z: number): NotebookNode => ({
	...source,
	id: crypto.randomUUID(),
	x: source.x + 34,
	y: source.y + 34,
	z,
});

const parseNotebook = (content: string): NotebookDocument => {
	if (!content) {
		return EMPTY_NOTEBOOK;
	}

	try {
		const parsed = JSON.parse(content) as Partial<NotebookDocument>;
		if (parsed?.version !== 1 || !Array.isArray(parsed.nodes) || !parsed.viewport) {
			return EMPTY_NOTEBOOK;
		}

		const zoom = typeof parsed.viewport.zoom === "number" ? parsed.viewport.zoom : 1;
		const x = typeof parsed.viewport.x === "number" ? parsed.viewport.x : 0;
		const y = typeof parsed.viewport.y === "number" ? parsed.viewport.y : 0;

		const nodes: NotebookNode[] = parsed.nodes
			.filter((node): node is NotebookNode => Boolean(node && typeof node.id === "string"))
			.map(
				(node, index): NotebookNode => ({
					...node,
					type: node.type === "media" ? "media" : node.type === "postit" ? "postit" : "text",
					x: typeof node.x === "number" ? node.x : 80,
					y: typeof node.y === "number" ? node.y : 80,
					w:
						typeof node.w === "number"
							? node.w
							: node.type === "media"
								? 340
								: node.type === "postit"
									? 260
									: 300,
					h:
						typeof node.h === "number"
							? node.h
							: node.type === "media"
								? 220
								: node.type === "postit"
									? 220
									: 180,
					z: typeof node.z === "number" ? node.z : index + 1,
					text: typeof node.text === "string" ? node.text : "",
					dataUrl: typeof node.dataUrl === "string" ? node.dataUrl : "",
					mimeType: typeof node.mimeType === "string" ? node.mimeType : "",
					name: typeof node.name === "string" ? node.name : "",
					textColor: sanitizeHex(node.textColor || "", DEFAULT_TEXT_COLOR),
					boxColor: sanitizeHex(
						node.boxColor || "",
						node.type === "postit" ? DEFAULT_POSTIT_BOX_COLOR : DEFAULT_BOX_COLOR,
					),
					fontSize:
						typeof node.fontSize === "number"
							? clamp(node.fontSize, 12, 64)
							: defaultFontSizeForType(node.type === "postit" ? "postit" : "text"),
				}),
			);

		return {
			version: 1,
			viewport: { x, y, zoom: clamp(zoom, 0.3, 2.5) },
			nodes,
		};
	} catch {
		return EMPTY_NOTEBOOK;
	}
};

const stringifyNotebook = (doc: NotebookDocument) => JSON.stringify(doc);

export function NotesView({ notebook, onUpdateNotebookByMap }: MainContentViewsProps) {
	const [doc, setDoc] = useState<NotebookDocument>(() => parseNotebook(notebook?.content ?? ""));
	const [selectedNodeId, setSelectedNodeId] = useState("");
	const [editingNodeId, setEditingNodeId] = useState("");
	const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
	const [isDirty, setIsDirty] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const sceneRef = useRef<HTMLDivElement | null>(null);
	const dragTimerRef = useRef<number | null>(null);
	const localClipboardNodeRef = useRef<NotebookNode | null>(null);
	const pointerRef = useRef({ x: 0, y: 0 });
	const touchGestureRef = useRef<
		| {
				kind: "pan";
				startTouchX: number;
				startTouchY: number;
				originX: number;
				originY: number;
		  }
		| {
				kind: "multi";
				startDistance: number;
				startZoom: number;
				startMidX: number;
				startMidY: number;
				originX: number;
				originY: number;
		  }
		| null
	>(null);
	const interactionRef = useRef<
		| {
				kind: "pending-drag";
				nodeId: string;
				startMouseX: number;
				startMouseY: number;
				startNodeX: number;
				startNodeY: number;
				timerId: number;
		  }
		| {
				kind: "pan";
				originX: number;
				originY: number;
				startX: number;
				startY: number;
		  }
		| {
				kind: "drag";
				nodeId: string;
				startMouseX: number;
				startMouseY: number;
				startNodeX: number;
				startNodeY: number;
		  }
		| {
				kind: "resize";
				nodeId: string;
				edge: ResizeEdge;
				startMouseX: number;
				startMouseY: number;
				startNodeX: number;
				startNodeY: number;
				startW: number;
				startH: number;
		  }
		| null
	>(null);

	const selectedNode = useMemo(
		() => doc.nodes.find((node) => node.id === selectedNodeId) ?? null,
		[doc.nodes, selectedNodeId],
	);
	const nextZ = () => Math.max(0, ...doc.nodes.map((node) => node.z)) + 1;
	const toWorldDelta = (delta: number) => delta / doc.viewport.zoom;
	const stepByArrow = (isFast: boolean) => (isFast ? 42 : 18);
	const selectedTextSize =
		selectedNode && (selectedNode.type === "text" || selectedNode.type === "postit")
			? normalizeFontSize(selectedNode)
			: DEFAULT_TEXT_SIZE;

	const zoomByFactorAtCenter = (factor: number) => {
		const rect = sceneRef.current?.getBoundingClientRect();
		if (!rect) {
			return;
		}
		const oldZoom = doc.viewport.zoom;
		const newZoom = clamp(oldZoom * factor, 0.3, 2.5);
		if (newZoom === oldZoom) {
			return;
		}
		const centerX = rect.width / 2;
		const centerY = rect.height / 2;
		const worldX = centerX / oldZoom - doc.viewport.x;
		const worldY = centerY / oldZoom - doc.viewport.y;
		touchDoc({
			...doc,
			viewport: {
				x: centerX / newZoom - worldX,
				y: centerY / newZoom - worldY,
				zoom: newZoom,
			},
		});
	};

	useEffect(() => {
		setDoc(parseNotebook(notebook?.content ?? ""));
		setSelectedNodeId("");
		setEditingNodeId("");
		setSaveState("saved");
		setIsDirty(false);
	}, [notebook?.id]);

	const touchDoc = (nextDoc: NotebookDocument) => {
		setDoc(nextDoc);
		setIsDirty(true);
		setSaveState("saving");
	};

	const clearPendingDragTimer = () => {
		if (dragTimerRef.current !== null) {
			window.clearTimeout(dragTimerRef.current);
			dragTimerRef.current = null;
		}
	};

	useEffect(() => () => clearPendingDragTimer(), []);

	useEffect(() => {
		if (!isDirty || !notebook) {
			return;
		}
		const timeout = window.setTimeout(() => {
			onUpdateNotebookByMap(stringifyNotebook(doc))
				.then(() => {
					setSaveState("saved");
					setIsDirty(false);
				})
				.catch(() => setSaveState("error"));
		}, 450);
		return () => window.clearTimeout(timeout);
	}, [doc, isDirty, notebook, onUpdateNotebookByMap]);

	const updateNode = (id: string, updater: (node: NotebookNode) => NotebookNode) => {
		touchDoc({ ...doc, nodes: doc.nodes.map((node) => (node.id === id ? updater(node) : node)) });
	};

	const addTextNode = () => {
		const size = measureTextNodeSize("", DEFAULT_TEXT_SIZE);
		const node: NotebookNode = {
			id: crypto.randomUUID(),
			type: "text",
			x: 100 - doc.viewport.x,
			y: 100 - doc.viewport.y,
			w: size.w,
			h: size.h,
			z: nextZ(),
			text: "",
			textColor: DEFAULT_TEXT_COLOR,
			boxColor: "transparent",
			fontSize: DEFAULT_TEXT_SIZE,
		};
		touchDoc({ ...doc, nodes: [...doc.nodes, node] });
		setSelectedNodeId(node.id);
		setEditingNodeId(node.id);
	};

	const addPostitNode = () => {
		const node: NotebookNode = {
			id: crypto.randomUUID(),
			type: "postit",
			x: 100 - doc.viewport.x,
			y: 100 - doc.viewport.y,
			w: 250,
			h: 220,
			z: nextZ(),
			text: "",
			textColor: DEFAULT_TEXT_COLOR,
			boxColor: DEFAULT_POSTIT_BOX_COLOR,
			fontSize: DEFAULT_POSTIT_TEXT_SIZE,
		};
		touchDoc({ ...doc, nodes: [...doc.nodes, node] });
		setSelectedNodeId(node.id);
		setEditingNodeId(node.id);
	};

	const addMediaNode = (dataUrl: string, mimeType: string, name: string) => {
		const mediaNode: NotebookNode = {
			id: crypto.randomUUID(),
			type: "media",
			x: 130 - doc.viewport.x,
			y: 130 - doc.viewport.y,
			w: 380,
			h: 260,
			z: nextZ(),
			dataUrl,
			mimeType,
			name,
		};
		touchDoc({ ...doc, nodes: [...doc.nodes, mediaNode] });
		setSelectedNodeId(mediaNode.id);
		setEditingNodeId("");
	};

	const addPastedNode = (source: NotebookNode) => {
		const clone = cloneNodeForPaste(source, nextZ());
		if (clone.type === "text") {
			const size = measureTextNodeSize(clone.text ?? "", normalizeFontSize(clone));
			clone.w = size.w;
			clone.h = size.h;
		}
		touchDoc({ ...doc, nodes: [...doc.nodes, clone] });
		setSelectedNodeId(clone.id);
		setEditingNodeId(clone.type === "text" || clone.type === "postit" ? clone.id : "");
	};

	const addPastedText = (rawText: string) => {
		const text = rawText.replace(/\r\n/g, "\n").trimEnd();
		if (!text) {
			return;
		}
		const size = measureTextNodeSize(text, DEFAULT_TEXT_SIZE);

		const node: NotebookNode = {
			id: crypto.randomUUID(),
			type: "text",
			x: 130 - doc.viewport.x,
			y: 130 - doc.viewport.y,
			w: size.w,
			h: size.h,
			z: nextZ(),
			text,
			textColor: DEFAULT_TEXT_COLOR,
			boxColor: "transparent",
			fontSize: DEFAULT_TEXT_SIZE,
		};
		touchDoc({ ...doc, nodes: [...doc.nodes, node] });
		setSelectedNodeId(node.id);
		setEditingNodeId(node.id);
	};

	const resetViewport = () => {
		const rect = sceneRef.current?.getBoundingClientRect();
		if (!rect || !doc.nodes.length) {
			touchDoc({
				...doc,
				viewport: { x: 0, y: 0, zoom: 1 },
			});
			return;
		}

		const nodeCenterX = doc.nodes.map((node) => node.x + node.w / 2);
		const nodeCenterY = doc.nodes.map((node) => node.y + node.h / 2);
		const centerX = (percentile(nodeCenterX, 20) + percentile(nodeCenterX, 80)) / 2;
		const centerY = (percentile(nodeCenterY, 20) + percentile(nodeCenterY, 80)) / 2;

		touchDoc({
			...doc,
			viewport: {
				x: rect.width / 2 - centerX,
				y: rect.height / 2 - centerY,
				zoom: 1,
			},
		});
	};

	const startPan = (event: MouseEvent<HTMLDivElement>) => {
		if (event.button !== 0) {
			return;
		}
		const target = event.target as HTMLElement;
		if (target.closest(".notebook-node")) {
			return;
		}
		if (editingNodeId) {
			setEditingNodeId("");
		}
		interactionRef.current = {
			kind: "pan",
			originX: doc.viewport.x,
			originY: doc.viewport.y,
			startX: event.clientX,
			startY: event.clientY,
		};
	};

	const onCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		if (target.closest(".notebook-node, .notebook-item-style-popover, .notebook-top-notch")) {
			return;
		}
		setSelectedNodeId("");
		setEditingNodeId("");
	};

	const onMouseMove = (event: MouseEvent<HTMLDivElement>) => {
		pointerRef.current = { x: event.clientX, y: event.clientY };
		const interaction = interactionRef.current;
		if (!interaction || interaction.kind === "pending-drag") {
			return;
		}
		if (interaction.kind === "pan") {
			const deltaX = toWorldDelta(event.clientX - interaction.startX);
			const deltaY = toWorldDelta(event.clientY - interaction.startY);
			touchDoc({
				...doc,
				viewport: { ...doc.viewport, x: interaction.originX + deltaX, y: interaction.originY + deltaY },
			});
			return;
		}
		if (interaction.kind === "drag") {
			const dx = toWorldDelta(event.clientX - interaction.startMouseX);
			const dy = toWorldDelta(event.clientY - interaction.startMouseY);
			updateNode(interaction.nodeId, (node) => ({
				...node,
				x: interaction.startNodeX + dx,
				y: interaction.startNodeY + dy,
			}));
			return;
		}

		const resizeDx = toWorldDelta(event.clientX - interaction.startMouseX);
		const resizeDy = toWorldDelta(event.clientY - interaction.startMouseY);
		updateNode(interaction.nodeId, (node) => ({
			...node,
			...(interaction.edge.includes("e")
				? { w: clamp(interaction.startW + resizeDx, 120, 1200) }
				: interaction.edge.includes("w")
					? {
							w: clamp(interaction.startW - resizeDx, 120, 1200),
							x:
								interaction.startNodeX +
								(interaction.startW - clamp(interaction.startW - resizeDx, 120, 1200)),
						}
					: {}),
			...(interaction.edge.includes("s")
				? { h: clamp(interaction.startH + resizeDy, 90, 1000) }
				: interaction.edge.includes("n")
					? {
							h: clamp(interaction.startH - resizeDy, 90, 1000),
							y:
								interaction.startNodeY +
								(interaction.startH - clamp(interaction.startH - resizeDy, 90, 1000)),
						}
					: {}),
		}));
	};

	const endInteraction = () => {
		clearPendingDragTimer();
		interactionRef.current = null;
	};

	const startNodePress = (event: MouseEvent<HTMLDivElement>, node: NotebookNode) => {
		if (event.detail > 1) {
			return;
		}
		const target = event.target as HTMLElement;
		if (target.closest("input, textarea, button, video, audio")) {
			return;
		}
		event.stopPropagation();
		setSelectedNodeId(node.id);
		pointerRef.current = { x: event.clientX, y: event.clientY };

		const timerId = window.setTimeout(() => {
			dragTimerRef.current = null;
			interactionRef.current = {
				kind: "drag",
				nodeId: node.id,
				startMouseX: pointerRef.current.x,
				startMouseY: pointerRef.current.y,
				startNodeX: node.x,
				startNodeY: node.y,
			};
			updateNode(node.id, (currentNode) => ({ ...currentNode, z: nextZ() }));
		}, LONG_PRESS_MS);

		dragTimerRef.current = timerId;
		interactionRef.current = {
			kind: "pending-drag",
			nodeId: node.id,
			startMouseX: event.clientX,
			startMouseY: event.clientY,
			startNodeX: node.x,
			startNodeY: node.y,
			timerId,
		};
	};

	const startResize = (event: MouseEvent<HTMLButtonElement>, node: NotebookNode, edge: ResizeEdge) => {
		if (node.type === "text") {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		clearPendingDragTimer();
		interactionRef.current = {
			kind: "resize",
			nodeId: node.id,
			edge,
			startMouseX: event.clientX,
			startMouseY: event.clientY,
			startNodeX: node.x,
			startNodeY: node.y,
			startW: node.w,
			startH: node.h,
		};
	};

	const onCanvasWheel = (event: React.WheelEvent<HTMLDivElement>) => {
		event.preventDefault();
		const sceneRect = sceneRef.current?.getBoundingClientRect();
		if (!sceneRect) {
			return;
		}
		const zoomFactor = event.deltaY < 0 ? 1.035 : 0.965;
		const oldZoom = doc.viewport.zoom;
		const newZoom = clamp(oldZoom * zoomFactor, 0.3, 2.5);
		if (newZoom === oldZoom) {
			return;
		}
		const mouseX = event.clientX - sceneRect.left;
		const mouseY = event.clientY - sceneRect.top;
		const worldX = mouseX / oldZoom - doc.viewport.x;
		const worldY = mouseY / oldZoom - doc.viewport.y;
		touchDoc({ ...doc, viewport: { x: mouseX / newZoom - worldX, y: mouseY / newZoom - worldY, zoom: newZoom } });
	};

	const onCanvasTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
		if (!sceneRef.current) {
			return;
		}
		const target = event.target as HTMLElement;
		if (target.closest(".notebook-node") && event.touches.length === 1) {
			return;
		}
		if (event.touches.length === 2) {
			const a = event.touches[0];
			const b = event.touches[1];
			const dx = b.clientX - a.clientX;
			const dy = b.clientY - a.clientY;
			touchGestureRef.current = {
				kind: "multi",
				startDistance: Math.hypot(dx, dy),
				startZoom: doc.viewport.zoom,
				startMidX: (a.clientX + b.clientX) / 2,
				startMidY: (a.clientY + b.clientY) / 2,
				originX: doc.viewport.x,
				originY: doc.viewport.y,
			};
			event.preventDefault();
			return;
		}
		if (event.touches.length === 1) {
			const touch = event.touches[0];
			touchGestureRef.current = {
				kind: "pan",
				startTouchX: touch.clientX,
				startTouchY: touch.clientY,
				originX: doc.viewport.x,
				originY: doc.viewport.y,
			};
			event.preventDefault();
		}
	};

	const onCanvasTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
		const gesture = touchGestureRef.current;
		if (!gesture || !sceneRef.current) {
			return;
		}
		if (gesture.kind === "multi" && event.touches.length >= 2) {
			const a = event.touches[0];
			const b = event.touches[1];
			const dx = b.clientX - a.clientX;
			const dy = b.clientY - a.clientY;
			const distance = Math.max(1, Math.hypot(dx, dy));
			const rect = sceneRef.current.getBoundingClientRect();
			const midX = (a.clientX + b.clientX) / 2 - rect.left;
			const midY = (a.clientY + b.clientY) / 2 - rect.top;
			const startMidX = gesture.startMidX - rect.left;
			const startMidY = gesture.startMidY - rect.top;
			const distanceDelta = Math.abs(distance - gesture.startDistance);
			const midDelta = Math.hypot(midX - startMidX, midY - startMidY);

			if (midDelta > distanceDelta * 1.25) {
				const dxPan = (midX - startMidX) / doc.viewport.zoom;
				const dyPan = (midY - startMidY) / doc.viewport.zoom;
				touchDoc({
					...doc,
					viewport: {
						...doc.viewport,
						x: gesture.originX + dxPan,
						y: gesture.originY + dyPan,
					},
				});
				event.preventDefault();
				return;
			}

			const nextZoom = clamp((distance / gesture.startDistance) * gesture.startZoom, 0.3, 2.5);
			const worldX = startMidX / gesture.startZoom - gesture.originX;
			const worldY = startMidY / gesture.startZoom - gesture.originY;
			touchDoc({
				...doc,
				viewport: { x: midX / nextZoom - worldX, y: midY / nextZoom - worldY, zoom: nextZoom },
			});
			event.preventDefault();
			return;
		}
		if (gesture.kind === "pan" && event.touches.length === 1) {
			const touch = event.touches[0];
			const dx = (touch.clientX - gesture.startTouchX) / doc.viewport.zoom;
			const dy = (touch.clientY - gesture.startTouchY) / doc.viewport.zoom;
			touchDoc({ ...doc, viewport: { ...doc.viewport, x: gesture.originX + dx, y: gesture.originY + dy } });
			event.preventDefault();
		}
	};

	const onCanvasTouchEnd = () => {
		touchGestureRef.current = null;
	};

	const onPickMedia = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file) {
			return;
		}
		const dataUrl = await toDataUrl(file);
		addMediaNode(dataUrl, file.type, file.name);
		event.target.value = "";
	};

	const setSelectedTextColor = (nextColor: string) => {
		if (!selectedNode) {
			return;
		}
		updateNode(selectedNode.id, (node) => ({
			...node,
			textColor: sanitizeHex(nextColor, node.textColor || DEFAULT_TEXT_COLOR),
		}));
	};

	const setSelectedBoxColor = (nextColor: string) => {
		if (!selectedNode || selectedNode.type !== "postit") {
			return;
		}
		updateNode(selectedNode.id, (node) => ({
			...node,
			boxColor: sanitizeHex(nextColor, node.boxColor || DEFAULT_POSTIT_BOX_COLOR),
		}));
	};

	const setSelectedTextSize = (nextSize: number) => {
		if (!selectedNode || (selectedNode.type !== "text" && selectedNode.type !== "postit")) {
			return;
		}
		updateNode(selectedNode.id, (node) => {
			const fontSize = clamp(nextSize, 12, 64);
			if (node.type === "text") {
				const size = measureTextNodeSize(node.text ?? "", fontSize);
				return { ...node, fontSize, w: size.w, h: size.h };
			}
			return { ...node, fontSize };
		});
	};

	const selectedStyleAnchor = useMemo(() => {
		if (!selectedNode || (selectedNode.type !== "text" && selectedNode.type !== "postit")) {
			return null;
		}
		return { left: selectedNode.x + selectedNode.w / 2, top: selectedNode.y - 52 };
	}, [selectedNode]);

	const finishTextEditing = (node: NotebookNode) => {
		if (node.type !== "text") {
			setEditingNodeId("");
			return;
		}

		const rawText = node.text ?? "";
		if (!rawText.trim()) {
			touchDoc({ ...doc, nodes: doc.nodes.filter((item) => item.id !== node.id) });
			setSelectedNodeId((currentId) => (currentId === node.id ? "" : currentId));
		}
		setEditingNodeId("");
	};

	const updateTextNodeContent = (node: NotebookNode, nextText: string) => {
		if (node.type === "text") {
			const size = measureTextNodeSize(nextText, normalizeFontSize(node));
			updateNode(node.id, (current) => ({
				...current,
				text: nextText,
				w: size.w,
				h: size.h,
			}));
			return;
		}

		updateNode(node.id, (current) => ({
			...current,
			text: nextText,
		}));
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, [contenteditable='true']")) {
				return;
			}

			const isModifier = event.ctrlKey || event.metaKey;
			if (isModifier && event.key.toLowerCase() === "d" && selectedNode) {
				event.preventDefault();
				addPastedNode(selectedNode);
				return;
			}

			if (isModifier && event.key === "0") {
				event.preventDefault();
				resetViewport();
				return;
			}

			if (isModifier && (event.key === "+" || event.key === "=")) {
				event.preventDefault();
				zoomByFactorAtCenter(1.08);
				return;
			}

			if (isModifier && event.key === "-") {
				event.preventDefault();
				zoomByFactorAtCenter(0.92);
				return;
			}

			if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
				event.preventDefault();
				const step = stepByArrow(event.shiftKey);
				if (selectedNode) {
					const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
					const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
					updateNode(selectedNode.id, (node) => ({ ...node, x: node.x + dx, y: node.y + dy }));
					return;
				}

				const cameraDx = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
				const cameraDy = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
				touchDoc({
					...doc,
					viewport: {
						...doc.viewport,
						x: doc.viewport.x + cameraDx,
						y: doc.viewport.y + cameraDy,
					},
				});
				return;
			}

			if (event.key === "Delete" && selectedNodeId) {
				event.preventDefault();
				touchDoc({ ...doc, nodes: doc.nodes.filter((node) => node.id !== selectedNodeId) });
				setSelectedNodeId("");
				setEditingNodeId("");
				return;
			}

			if (event.key === "Escape") {
				setEditingNodeId("");
				setSelectedNodeId("");
			}
		};

		const onCopy = (event: ClipboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, [contenteditable='true']") || !selectedNode) {
				return;
			}

			localClipboardNodeRef.current = { ...selectedNode };
			event.preventDefault();
			event.clipboardData?.setData(NOTEBOOK_CLIPBOARD_MIME, JSON.stringify(selectedNode));
			event.clipboardData?.setData(
				"text/plain",
				selectedNode.type === "text" || selectedNode.type === "postit"
					? (selectedNode.text ?? "")
					: selectedNode.name || "Notebook media",
			);
		};

		const onPaste = async (event: ClipboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, [contenteditable='true']")) {
				return;
			}

			const clipboard = event.clipboardData;
			if (!clipboard) {
				if (localClipboardNodeRef.current) {
					event.preventDefault();
					addPastedNode(localClipboardNodeRef.current);
				}
				return;
			}

			const nodeData = clipboard.getData(NOTEBOOK_CLIPBOARD_MIME);
			if (nodeData) {
				try {
					addPastedNode(JSON.parse(nodeData) as NotebookNode);
					event.preventDefault();
					return;
				} catch {
					// Fall through to text/media handling.
				}
			}

			for (const item of clipboard.items) {
				if (item.kind !== "file") {
					continue;
				}
				const file = item.getAsFile();
				if (!file) {
					continue;
				}
				if (
					file.type.startsWith("image/") ||
					file.type.startsWith("video/") ||
					file.type.startsWith("audio/")
				) {
					event.preventDefault();
					const dataUrl = await toDataUrl(file);
					addMediaNode(dataUrl, file.type, "Pasted media");
					return;
				}
			}

			const rawText = clipboard.getData("text/plain");
			if (!rawText) {
				return;
			}

			addPastedText(rawText);
			event.preventDefault();
		};

		const onPasteEvent = (event: ClipboardEvent) => {
			void onPaste(event);
		};

		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("copy", onCopy);
		window.addEventListener("paste", onPasteEvent);

		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("copy", onCopy);
			window.removeEventListener("paste", onPasteEvent);
		};
	}, [doc, selectedNode, selectedNodeId]);

	return (
		<div className="notebook-layout">
			<section
				className="atlas-card notebook-canvas-wrap"
				onMouseMove={onMouseMove}
				onMouseUp={endInteraction}
				onMouseLeave={endInteraction}
			>
				<div className="notebook-top-notch">
					<button
						className="notebook-icon-btn"
						title="Text"
						aria-label="Add text item"
						onClick={addTextNode}
					>
						<span className="notebook-t-glyph">T</span>
					</button>
					<button
						className="notebook-icon-btn"
						title="Image"
						aria-label="Add image or media item"
						onClick={() => fileInputRef.current?.click()}
					>
						<PhotoIcon className="h-4 w-4" />
					</button>
					<button
						className="notebook-icon-btn"
						title="Post-it"
						aria-label="Add post-it item"
						onClick={addPostitNode}
					>
						<RectangleStackIcon className="h-4 w-4" />
					</button>
				</div>

				<input
					ref={fileInputRef}
					type="file"
					accept="image/*,video/*,audio/*"
					onChange={onPickMedia}
					className="hidden"
					title="Choose media file"
				/>

				<div
					ref={sceneRef}
					className="notebook-canvas"
					onMouseDown={startPan}
					onClick={onCanvasClick}
					onWheel={onCanvasWheel}
					onTouchStart={onCanvasTouchStart}
					onTouchMove={onCanvasTouchMove}
					onTouchEnd={onCanvasTouchEnd}
					onTouchCancel={onCanvasTouchEnd}
				>
					<div
						className="notebook-scene"
						style={{ transform: `scale(${doc.viewport.zoom})`, transformOrigin: "0 0" }}
					>
						<div
							className="notebook-layer"
							style={{ transform: `translate(${doc.viewport.x}px, ${doc.viewport.y}px)` }}
						>
							<div className="notebook-moving-background" />

							{selectedStyleAnchor && (
								<div
									className="notebook-item-style-popover"
									style={{ left: selectedStyleAnchor.left, top: selectedStyleAnchor.top }}
									onMouseDown={(event) => event.stopPropagation()}
								>
									<div className="notebook-color-field">
										<input
											type="color"
											title="Text color"
											value={sanitizeHex(
												selectedNode?.textColor || DEFAULT_TEXT_COLOR,
												DEFAULT_TEXT_COLOR,
											)}
											onChange={(event) => setSelectedTextColor(event.target.value)}
										/>
										<input
											type="text"
											className="notebook-hex-input"
											value={sanitizeHex(
												selectedNode?.textColor || DEFAULT_TEXT_COLOR,
												DEFAULT_TEXT_COLOR,
											)}
											onChange={(event) => setSelectedTextColor(event.target.value)}
											placeholder="#000000"
										/>
									</div>
									<div className="notebook-color-field">
										<select
											className="notebook-size-select"
											value={
												TEXT_SIZE_OPTIONS[
													clampIndex(
														TEXT_SIZE_OPTIONS.findIndex(
															(value) => value >= selectedTextSize,
														),
														TEXT_SIZE_OPTIONS.length,
													)
												]
											}
											onChange={(event) => setSelectedTextSize(Number(event.target.value))}
											title="Text size"
										>
											{TEXT_SIZE_OPTIONS.map((size) => (
												<option
													key={size}
													value={size}
												>
													{size}px
												</option>
											))}
										</select>
									</div>
									{selectedNode?.type === "postit" && (
										<div className="notebook-color-field">
											<input
												type="color"
												title="Box color"
												value={sanitizeHex(
													selectedNode.boxColor || DEFAULT_POSTIT_BOX_COLOR,
													DEFAULT_POSTIT_BOX_COLOR,
												)}
												onChange={(event) => setSelectedBoxColor(event.target.value)}
											/>
											<input
												type="text"
												className="notebook-hex-input"
												value={sanitizeHex(
													selectedNode.boxColor || DEFAULT_POSTIT_BOX_COLOR,
													DEFAULT_POSTIT_BOX_COLOR,
												)}
												onChange={(event) => setSelectedBoxColor(event.target.value)}
												placeholder="#fff2b2"
											/>
										</div>
									)}
								</div>
							)}

							{doc.nodes
								.slice()
								.sort((a, b) => a.z - b.z)
								.map((node) => (
									<div
										key={node.id}
										className={`notebook-node notebook-node-${node.type} ${selectedNodeId === node.id ? "active" : ""}`}
										style={{
											left: node.x,
											top: node.y,
											width: node.w,
											height: node.h,
											zIndex: node.z,
											color: sanitizeHex(
												node.textColor || DEFAULT_TEXT_COLOR,
												DEFAULT_TEXT_COLOR,
											),
											background:
												node.type === "media" || node.type === "text"
													? "transparent"
													: sanitizeHex(
															node.boxColor || DEFAULT_POSTIT_BOX_COLOR,
															DEFAULT_POSTIT_BOX_COLOR,
														),
											fontSize: `${normalizeFontSize(node)}px`,
										}}
										onMouseDown={(event) => startNodePress(event, node)}
										onClick={(event) => {
											event.stopPropagation();
											setSelectedNodeId(node.id);
										}}
										onDoubleClick={(event) => {
											event.stopPropagation();
											if (node.type === "text" || node.type === "postit") {
												setEditingNodeId(node.id);
											}
										}}
									>
										{node.type === "text" || node.type === "postit" ? (
											node.id === editingNodeId ? (
												<div
													className="notebook-text notebook-editor-div"
													contentEditable
													suppressContentEditableWarning
													spellCheck
													onMouseDown={(event) => event.stopPropagation()}
													onBlur={() => finishTextEditing(node)}
													onInput={(event) =>
														updateTextNodeContent(
															node,
															event.currentTarget.textContent ?? "",
														)
													}
													onPaste={(event) => {
														event.preventDefault();
														const text = event.clipboardData.getData("text/plain");
														document.execCommand("insertText", false, text);
													}}
													ref={(element) => {
														if (!element) {
															return;
														}
														if (element.textContent !== (node.text ?? "")) {
															element.textContent = node.text ?? "";
														}
														if (document.activeElement !== element) {
															element.focus();
															const selection = window.getSelection();
															if (selection) {
																const range = document.createRange();
																range.selectNodeContents(element);
																range.collapse(false);
																selection.removeAllRanges();
																selection.addRange(range);
															}
														}
													}}
												/>
											) : (
												<div className="notebook-text notebook-readonly-text">
													{node.text || " "}
												</div>
											)
										) : (
											<div className="notebook-media">
												{node.mimeType?.startsWith("image/") ? (
													<img
														src={node.dataUrl}
														alt={node.name || "Notebook media"}
														draggable={false}
													/>
												) : node.mimeType?.startsWith("video/") ? (
													<video
														src={node.dataUrl}
														controls
														onMouseDown={(event) => event.stopPropagation()}
													/>
												) : (
													<audio
														src={node.dataUrl}
														controls
														onMouseDown={(event) => event.stopPropagation()}
													/>
												)}
											</div>
										)}

										{node.type !== "text" && (
											<>
												<button
													type="button"
													className="notebook-resize-handle edge-n"
													onMouseDown={(event) => startResize(event, node, "n")}
													aria-label="Resize top edge"
												/>
												<button
													type="button"
													className="notebook-resize-handle edge-s"
													onMouseDown={(event) => startResize(event, node, "s")}
													aria-label="Resize bottom edge"
												/>
												<button
													type="button"
													className="notebook-resize-handle edge-e"
													onMouseDown={(event) => startResize(event, node, "e")}
													aria-label="Resize right edge"
												/>
												<button
													type="button"
													className="notebook-resize-handle edge-w"
													onMouseDown={(event) => startResize(event, node, "w")}
													aria-label="Resize left edge"
												/>
												<button
													type="button"
													className="notebook-resize-handle corner-ne"
													onMouseDown={(event) => startResize(event, node, "ne")}
													aria-label="Resize top-right corner"
												/>
												<button
													type="button"
													className="notebook-resize-handle corner-nw"
													onMouseDown={(event) => startResize(event, node, "nw")}
													aria-label="Resize top-left corner"
												/>
												<button
													type="button"
													className="notebook-resize-handle corner-se"
													onMouseDown={(event) => startResize(event, node, "se")}
													aria-label="Resize bottom-right corner"
												/>
												<button
													type="button"
													className="notebook-resize-handle corner-sw"
													onMouseDown={(event) => startResize(event, node, "sw")}
													aria-label="Resize bottom-left corner"
												/>
											</>
										)}
									</div>
								))}
						</div>
					</div>
				</div>

				<p className="notebook-meta notebook-meta-overlay">
					{saveState === "saving"
						? "Saving changes..."
						: saveState === "saved"
							? "All changes saved."
							: "Save failed. Try again."}{" "}
					Zoom{" "}
					<button
						type="button"
						className="notebook-zoom-reset"
						onClick={resetViewport}
					>
						{Math.round(doc.viewport.zoom * 100)}%
					</button>
				</p>
			</section>
		</div>
	);
}
