export const readStorage = <T>(key: string, fallback: T): T => {
	try {
		const value = localStorage.getItem(key);
		if (!value) {
			return fallback;
		}
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
};
