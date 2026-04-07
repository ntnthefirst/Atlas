export const pad = (value: number) => value.toString().padStart(2, "0");

export const formatClock = (ms: number) => {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	return `${pad(h)}:${pad(m)}:${pad(s)}`;
};

export const formatDuration = (ms: number) => {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	return `${h}h ${pad(m)}m ${pad(s)}s`;
};

export const normalizeTrackedAppName = (value: string) => {
	const cleaned = value
		.replace(/\s*\[[^\]]*\]\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return cleaned || "Unknown";
};
