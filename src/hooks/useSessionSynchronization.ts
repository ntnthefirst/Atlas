import { useEffect } from "react";
import type { Session } from "../types";

interface UseSessionSynchronizationProps {
	selectedMapId: string;
	selectedSessionId: string;
	setActiveSession: (session: Session | null) => void;
	setCurrentAppName: (name: string) => void;
	setDashboard: (dashboard: Record<string, any>) => void;
	setActivityBlocks: (blocks: Array<Record<string, any>>) => void;
}

export const useSessionSynchronization = ({
	selectedMapId,
	selectedSessionId,
	setActiveSession,
	setCurrentAppName,
	setDashboard,
	setActivityBlocks,
}: UseSessionSynchronizationProps) => {
	useEffect(() => {
		const sessionSync = window.setInterval(async () => {
			const active = await window.atlas.getActiveSession();
			setActiveSession(active);
		}, 500);

		const dataSync = window.setInterval(async () => {
			if (selectedMapId) {
				setDashboard(await window.atlas.getDashboardOverview(selectedMapId));
			}
			const active = await window.atlas.getActiveSession();
			if (active && (active.map_id === selectedMapId || active.id === selectedSessionId)) {
				const blocks = await window.atlas.listActivityBySession(active.id);
				setActivityBlocks(blocks);
			}
		}, 2000);

		return () => {
			window.clearInterval(sessionSync);
			window.clearInterval(dataSync);
		};
	}, [selectedMapId, selectedSessionId, setActiveSession, setCurrentAppName, setDashboard, setActivityBlocks]);
};
