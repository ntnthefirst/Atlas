import { useEffect } from "react";
import type { Session } from "../types";

interface UseMiniWindowSetupProps {
	isMiniMode: boolean;
	miniControlsRef: React.MutableRefObject<HTMLDivElement | null>;
	activeSession: Session | null;
}

export const useMiniWindowSetup = ({ isMiniMode, miniControlsRef, activeSession }: UseMiniWindowSetupProps) => {
	useEffect(() => {
		if (!isMiniMode) {
			return;
		}

		const html = document.documentElement;
		const body = document.body;
		const root = document.getElementById("root");

		html.dataset.miniMode = "true";
		html.style.background = "transparent";
		body.style.background = "transparent";
		if (root) {
			root.style.background = "transparent";
		}

		return () => {
			delete html.dataset.miniMode;
			html.style.background = "";
			body.style.background = "";
			if (root) {
				root.style.background = "";
			}
		};
	}, [isMiniMode]);

	useEffect(() => {
		if (!isMiniMode) {
			return;
		}

		const controlNode = miniControlsRef.current;
		if (!controlNode) {
			return;
		}

		const resizeMiniToContent = () => {
			const bounds = controlNode.getBoundingClientRect();
			const nextWidth = Math.ceil(bounds.width + 8);
			const nextHeight = Math.ceil(bounds.height + 8);
			void window.atlas.resizeMiniWindow(nextWidth, nextHeight);
		};

		resizeMiniToContent();

		const observer = new ResizeObserver(() => resizeMiniToContent());
		observer.observe(controlNode);
		window.addEventListener("resize", resizeMiniToContent);

		return () => {
			observer.disconnect();
			window.removeEventListener("resize", resizeMiniToContent);
		};
	}, [isMiniMode, activeSession?.is_paused, miniControlsRef]);
};
