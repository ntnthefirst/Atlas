import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";
import type { AtlasView } from "../types";

type AtlasMainContentProps = {
	view: AtlasView;
	errorMessage: string;
	children: ReactNode;
};

export function AtlasMainContent({ view, errorMessage, children }: AtlasMainContentProps) {
	const isActivityView = view === "activity";
	const isNotesView = view === "notes";
	const isFullBleed = isActivityView || isNotesView;

	return (
		<main
			className={`grid h-full min-h-0 w-full ${isNotesView ? "" : "gap-3.5 p-3.5"} ${isFullBleed ? "overflow-hidden" : "overflow-auto"}`}
		>
			<AnimatePresence mode="wait">
				<motion.section
					key={view}
					className={`min-h-0 ${isFullBleed ? "h-full" : ""}`}
					initial={{ opacity: 0, y: 10 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: -10 }}
					transition={{ duration: 0.18 }}
				>
					{children}
				</motion.section>
			</AnimatePresence>

			{errorMessage && <p className="error-banner">{errorMessage}</p>}
		</main>
	);
}
