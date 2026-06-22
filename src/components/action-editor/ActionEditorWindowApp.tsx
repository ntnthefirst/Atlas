import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { MinusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { NotchTabsEditor } from "../settings-window/NotchTabsEditor";
import logo from "../../assets/logosmall.png";

// A standalone window for editing the notch's action-button tabs, reachable
// either from Settings or directly from a button on the notch itself —
// reuses the exact same NotchTabsEditor (and its own IPC-backed state), just
// without the rest of Settings around it.
export function ActionEditorWindowApp() {
	const [platform, setPlatform] = useState("win32");

	useEffect(() => {
		window.atlas
			.getPlatform()
			.then((value) => setPlatform(value || "win32"))
			.catch(() => setPlatform("win32"));
	}, []);

	const isMacPlatform = platform === "darwin";
	const hasNativeControls = platform === "darwin" || platform === "win32";

	return (
		<div className="atlas-settings-root text-neutral-900 dark:text-neutral-50">
			<motion.div
				className="atlas-settings-shell"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ duration: 0.2, ease: "easeOut" }}
			>
				<header
					className={`titlebar sticky top-0 z-40 flex h-12.5 items-center border-b border-neutral-200 bg-neutral-50 px-2.5 text-neutral-700 backdrop-blur-md [-webkit-app-region:drag] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 ${
						isMacPlatform ? "pl-21" : hasNativeControls ? "pr-36.5" : "pr-22"
					}`}
				>
					<div className="titlebar-left no-drag flex min-w-0 items-center gap-2 text-base">
						<img src={logo} alt="Atlas" className="h-7 w-7 shrink-0" />
						<span className="truncate text-body-small font-medium text-neutral-800 dark:text-neutral-50">
							Edit Action Buttons
						</span>
					</div>
					{!hasNativeControls && (
						<div className="titlebar-right no-drag absolute right-2 top-2.25 inline-flex gap-1">
							<button
								type="button"
								className="atlas-window-control"
								onClick={() => {
									void window.atlas.windowMinimize();
								}}
								aria-label="Minimize"
							>
								<MinusIcon className="h-4 w-4" />
							</button>
							<button
								type="button"
								className="atlas-window-control atlas-window-control-close"
								onClick={() => {
									void window.atlas.windowClose();
								}}
								aria-label="Close"
							>
								<XMarkIcon className="h-4 w-4" />
							</button>
						</div>
					)}
				</header>

				<main className="atlas-settings-content p-3">
					<section className="atlas-card atlas-settings-panel">
						<div className="mx-auto grid w-full max-w-3xl gap-4">
							<NotchTabsEditor centered />
						</div>
					</section>
				</main>
			</motion.div>
		</div>
	);
}
