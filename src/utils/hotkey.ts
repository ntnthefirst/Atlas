// ---------------------------------------------------------------------------
// Turns a captured keydown into an Electron `globalShortcut` accelerator
// string (WP-1.4), for the "record a new shortcut" control in Settings ->
// Keybindings. Windows only (D10) -- no "Cmd"/"Option" handling, since there
// is no macOS build of Atlas to press them on.
//
// Requires at least one modifier (Control/Alt/Shift): a bare letter would
// otherwise swallow normal typing the instant the recorder is focused, and
// every accelerator Electron's globalShortcut.register() actually expects
// for a system-wide hotkey has one anyway.
// ---------------------------------------------------------------------------

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

const NAMED_KEYS: Record<string, string> = {
	" ": "Space",
	Escape: "Esc",
	ArrowUp: "Up",
	ArrowDown: "Down",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	Tab: "Tab",
	Backspace: "Backspace",
	Delete: "Delete",
	Home: "Home",
	End: "End",
	PageUp: "PageUp",
	PageDown: "PageDown",
};

const FUNCTION_KEY_PATTERN = /^F([1-9]|1[0-9]|2[0-4])$/;

// Returns a valid accelerator string once a non-modifier key is pressed
// alongside at least one modifier, or `null` while still waiting (a bare
// modifier press, or a key this recorder doesn't support -- IME composition,
// dead keys, etc.). Callers should keep listening on `null`, not treat it as
// a failure.
export function acceleratorFromKeyboardEvent(event: Pick<
	KeyboardEvent,
	"key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
>): string | null {
	if (MODIFIER_KEYS.has(event.key)) {
		return null;
	}

	const modifiers: string[] = [];
	if (event.ctrlKey) modifiers.push("Control");
	if (event.altKey) modifiers.push("Alt");
	if (event.shiftKey) modifiers.push("Shift");
	if (event.metaKey) modifiers.push("Super");

	if (modifiers.length === 0) {
		return null;
	}

	let key: string;
	if (NAMED_KEYS[event.key]) {
		key = NAMED_KEYS[event.key];
	} else if (/^[a-zA-Z]$/.test(event.key)) {
		key = event.key.toUpperCase();
	} else if (/^[0-9]$/.test(event.key)) {
		key = event.key;
	} else if (FUNCTION_KEY_PATTERN.test(event.key)) {
		key = event.key;
	} else {
		return null;
	}

	return [...modifiers, key].join("+");
}

// A short, human-readable rendering of an accelerator string for display
// (Settings shows this instead of the raw "Control+Alt+E" storage format).
export function formatAccelerator(accelerator: string): string {
	return accelerator.split("+").join(" + ");
}
