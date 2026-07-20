// Electron wraps anything thrown in a main-process IPC handler before the
// renderer sees it, producing messages shaped like:
//
//   Error invoking remote method 'ai:setConfig': Error: <the real message>
//
// Showing that verbatim leaks plumbing at the user. Unwrapping it matters when
// the main process raised something the user can actually act on — the secret
// vault refusing to store a key because the OS keychain is unavailable, for
// instance, which is useless to the user as a generic "Could not save."
export const describeIpcError = (error: unknown, fallback: string): string => {
	const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (!raw.trim()) {
		return fallback;
	}

	// Strip the IPC wrapper, then any leading "Error:"/"TypeError:" prefix left
	// behind by the serialization.
	const unwrapped = raw.replace(/^Error invoking remote method\s+'[^']*':\s*/, "");
	const message = unwrapped.replace(/^[A-Za-z]*Error:\s*/, "").trim();

	return message || fallback;
};
