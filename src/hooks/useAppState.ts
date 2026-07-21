import { useState } from "react";

export const useEnvironmentMenuManagement = () => {
	const [showEnvironmentMenu, setShowEnvironmentMenu] = useState(false);
	const [renameEnvironmentName, setRenameEnvironmentName] = useState("");
	const [newEnvironmentName, setNewEnvironmentName] = useState("");
	const [showFirstLaunch, setShowFirstLaunch] = useState(false);

	return {
		showEnvironmentMenu,
		setShowEnvironmentMenu,
		renameEnvironmentName,
		setRenameEnvironmentName,
		newEnvironmentName,
		setNewEnvironmentName,
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
