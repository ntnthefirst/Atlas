import { useEffect } from "react";
import { normalizeTrackedAppName } from "../utils";
import type { ActivityBlock, DashboardOverview, Session } from "../types";

interface UseSessionSynchronizationProps {
	selectedEnvironmentId: string;
	selectedSessionId: string;
	setActiveSession: (session: Session | null) => void;
	setCurrentAppName: (name: string) => void;
	setDashboard: (dashboard: DashboardOverview) => void;
	setActivityBlocks: (blocks: ActivityBlock[]) => void;
}

export const useSessionSynchronization = ({
	selectedEnvironmentId,
	selectedSessionId,
	setActiveSession,
	setCurrentAppName,
	setDashboard,
	setActivityBlocks,
}: UseSessionSynchronizationProps) => {
	useEffect(() => {
		const sessionSync = window.setInterval(async () => {
			const [active, appName] = await Promise.all([
				window.atlas.getActiveSession(),
				window.atlas.getCurrentApp(),
			]);
			setActiveSession(active);
			setCurrentAppName(normalizeTrackedAppName(appName));
		}, 500);

		const dataSync = window.setInterval(async () => {
			if (selectedEnvironmentId) {
				setDashboard(await window.atlas.getDashboardOverview(selectedEnvironmentId));
			}
			const active = await window.atlas.getActiveSession();
			if (active && (active.environment_id === selectedEnvironmentId || active.id === selectedSessionId)) {
				const blocks = await window.atlas.listActivityBySession(active.id);
				setActivityBlocks(blocks);
			}
		}, 2000);

		return () => {
			window.clearInterval(sessionSync);
			window.clearInterval(dataSync);
		};
	}, [selectedEnvironmentId, selectedSessionId, setActiveSession, setCurrentAppName, setDashboard, setActivityBlocks]);
};
