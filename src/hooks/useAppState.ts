import { useState } from "react";

export const useMapMenuManagement = () => {
	const [showMapMenu, setShowMapMenu] = useState(false);
	const [renameMapName, setRenameMapName] = useState("");
	const [newMapName, setNewMapName] = useState("");
	const [showFirstLaunch, setShowFirstLaunch] = useState(false);

	return {
		showMapMenu,
		setShowMapMenu,
		renameMapName,
		setRenameMapName,
		newMapName,
		setNewMapName,
		showFirstLaunch,
		setShowFirstLaunch,
	};
};

export const useErrorManagement = () => {
	const [errorMessage, setErrorMessage] = useState("");
	return { errorMessage, setErrorMessage };
};

export const useTimeManagement = () => {
	const [now, setNow] = useState(0);
	return { now, setNow };
};

export const usePlatformManagement = () => {
	const [platform, setPlatform] = useState("win32");
	return { platform, setPlatform };
};

export const useBootstrapState = () => {
	const [hasBootstrapped, setHasBootstrapped] = useState(false);
	return { hasBootstrapped, setHasBootstrapped };
};

export const useCurrentAppTracker = () => {
	const [currentAppName, setCurrentAppName] = useState("Unknown");
	return { currentAppName, setCurrentAppName };
};
