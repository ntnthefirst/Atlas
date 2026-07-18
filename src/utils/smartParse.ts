import type { MapItem, TaskColumn, TaskPriority } from "../types";

// ---------------------------------------------------------------------------
// Atlas' local "understanding" engine.
//
// This is a fully offline, on-device parser: it reads one line of natural
// language the way a person would skim it and decides *what* the user meant and
// *where* it should go — task vs note, which environment, which column, its
// priority, due date and tags — so quick capture files itself instead of making
// the user click through fields. No network, no model download; it's a compact,
// deterministic heuristic layer designed so a heavier local model could later
// be slotted in behind the same `parseCapture` contract.
// ---------------------------------------------------------------------------

export type CaptureKind = "task" | "note";

export interface CaptureContext {
	now?: number;
	environments: MapItem[];
	currentEnvironmentId: string | null;
	// Columns for a given environment id, so routing can resolve a real column
	// on whichever environment the text targets (not just the current one).
	columnsFor: (environmentId: string) => TaskColumn[];
}

export interface ParsedCapture {
	kind: CaptureKind;
	title: string;
	raw: string;
	priority: TaskPriority;
	dueDate: string | null;
	dueLabel: string | null;
	tags: string[];
	columnStatus: string | null;
	columnLabel: string | null;
	environmentId: string | null;
	environmentName: string | null;
	// Short human explanations of every routing decision, surfaced live in the
	// capture bar so the automation stays legible rather than magic.
	reasons: string[];
}

const WEEKDAYS: Record<string, number> = {
	sun: 0, sunday: 0,
	mon: 1, monday: 1,
	tue: 2, tues: 2, tuesday: 2,
	wed: 3, weds: 3, wednesday: 3,
	thu: 4, thur: 4, thurs: 4, thursday: 4,
	fri: 5, friday: 5,
	sat: 6, saturday: 6,
};

const MONTHS: Record<string, number> = {
	jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
	may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
	september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const NOTE_LEAD_WORDS = ["idea", "thought", "remember", "note", "til", "reminder to self"];

const toISODate = (date: Date): string => {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
};

const startOfDay = (ms: number): Date => {
	const date = new Date(ms);
	date.setHours(0, 0, 0, 0);
	return date;
};

const addDays = (base: Date, days: number): Date => {
	const date = new Date(base);
	date.setDate(date.getDate() + days);
	return date;
};

// Next strictly-future date that lands on the target weekday (today → +7).
const nextWeekday = (base: Date, targetDow: number): Date => {
	const diff = (targetDow - base.getDay() + 7) % 7 || 7;
	return addDays(base, diff);
};

// A friendly label for a resolved due date relative to now.
const dueLabelFor = (iso: string, now: number): string => {
	const today = startOfDay(now);
	const target = startOfDay(new Date(`${iso}T00:00:00`).getTime());
	const dayMs = 86_400_000;
	const delta = Math.round((target.getTime() - today.getTime()) / dayMs);
	if (delta === 0) return "Today";
	if (delta === 1) return "Tomorrow";
	if (delta === -1) return "Yesterday";
	if (delta > 1 && delta < 7) return target.toLocaleDateString([], { weekday: "long" });
	return target.toLocaleDateString([], { day: "numeric", month: "short" });
};

const normalizeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

// Resolve an `@token` against the known environments: exact-ish first, then a
// leading-substring match, then any word that starts with the token.
const matchEnvironment = (token: string, environments: MapItem[]): MapItem | null => {
	const needle = normalizeName(token);
	if (!needle) return null;
	let starts: MapItem | null = null;
	let word: MapItem | null = null;
	for (const env of environments) {
		const name = normalizeName(env.name);
		if (name === needle) return env;
		if (!starts && name.startsWith(needle)) starts = env;
		if (!word && env.name.toLowerCase().split(/\s+/).some((part) => part.startsWith(token.toLowerCase()))) {
			word = env;
		}
	}
	return starts ?? word;
};

const matchColumn = (token: string, columns: TaskColumn[]): TaskColumn | null => {
	const needle = normalizeName(token);
	if (!needle) return null;
	return (
		columns.find((column) => normalizeName(column.label) === needle || normalizeName(column.status) === needle) ??
		columns.find((column) => normalizeName(column.label).startsWith(needle)) ??
		null
	);
};

export function parseCapture(raw: string, context: CaptureContext): ParsedCapture {
	const now = context.now ?? Date.now();
	const today = startOfDay(now);
	const reasons: string[] = [];

	let working = ` ${raw} `;

	// --- Environment (@name) --------------------------------------------------
	let environment: MapItem | null = null;
	working = working.replace(/(^|\s)@([a-z0-9_-]+)/gi, (_match, pre: string, token: string) => {
		const found = matchEnvironment(token, context.environments);
		if (found && !environment) {
			environment = found;
			return pre;
		}
		return `${pre}@${token}`;
	});
	if (environment) reasons.push(`Environment · ${(environment as MapItem).name}`);

	const targetEnvId = (environment as MapItem | null)?.id ?? context.currentEnvironmentId;
	const columns = targetEnvId ? context.columnsFor(targetEnvId) : [];

	// --- Tags (#tag) ----------------------------------------------------------
	const tags: string[] = [];
	working = working.replace(/(^|\s)#([a-z0-9_-]+)/gi, (_match, _pre: string, token: string) => {
		if (!tags.includes(token.toLowerCase())) tags.push(token.toLowerCase());
		return " ";
	});
	if (tags.length) reasons.push(`Tags · ${tags.map((tag) => `#${tag}`).join(" ")}`);

	// --- Explicit column hint (>column) --------------------------------------
	let column: TaskColumn | null = null;
	working = working.replace(/(^|\s)>([a-z0-9_ -]+?)(?=$|\s{2,}|\s#|\s@)/i, (match, _pre: string, token: string) => {
		const found = matchColumn(token.trim(), columns);
		if (found) {
			column = found;
			return " ";
		}
		return match;
	});

	// --- Due date -------------------------------------------------------------
	let dueDate: string | null = null;
	const setDue = (date: Date) => {
		if (!dueDate) dueDate = toISODate(date);
	};

	// ISO date first (most explicit).
	working = working.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/, (_match, y: string, m: string, d: string) => {
		setDue(new Date(Number(y), Number(m) - 1, Number(d)));
		return " ";
	});
	// Day/month (European order): 5/6 or 5-6 → 5 June.
	working = working.replace(/\b(\d{1,2})[/](\d{1,2})(?:[/](\d{2,4}))?\b/, (match, d: string, m: string, y?: string) => {
		const day = Number(d);
		const month = Number(m) - 1;
		if (day < 1 || day > 31 || month < 0 || month > 11) return match;
		const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : today.getFullYear();
		const candidate = new Date(year, month, day);
		if (!y && candidate.getTime() < today.getTime()) candidate.setFullYear(year + 1);
		setDue(candidate);
		return " ";
	});
	// "today" / "tonight".
	working = working.replace(/\b(today|tonight)\b/i, () => {
		setDue(today);
		return " ";
	});
	// "tomorrow" / "tmr" / "tmrw".
	working = working.replace(/\b(tomorrow|tmrw?|tmw)\b/i, () => {
		setDue(addDays(today, 1));
		return " ";
	});
	// "next week".
	working = working.replace(/\bnext week\b/i, () => {
		setDue(addDays(today, 7));
		return " ";
	});
	// "in N days/weeks".
	working = working.replace(/\bin (\d{1,3}) (day|days|week|weeks)\b/i, (_match, count: string, unit: string) => {
		const n = Number(count);
		setDue(addDays(today, unit.startsWith("week") ? n * 7 : n));
		return " ";
	});
	// Weekday, optionally "next <weekday>".
	working = working.replace(
		/\b(?:next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/i,
		(match, name: string) => {
			const dow = WEEKDAYS[name.toLowerCase()];
			if (dow === undefined) return match;
			setDue(nextWeekday(today, dow));
			return " ";
		},
	);
	// "5 jun" / "jun 5".
	working = working.replace(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i, (match, d: string, mon: string) => {
		const month = MONTHS[mon.toLowerCase()];
		if (month === undefined) return match;
		const candidate = new Date(today.getFullYear(), month, Number(d));
		if (candidate.getTime() < today.getTime()) candidate.setFullYear(today.getFullYear() + 1);
		setDue(candidate);
		return " ";
	});
	working = working.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i, (match, mon: string, d: string) => {
		const month = MONTHS[mon.toLowerCase()];
		if (month === undefined) return match;
		const candidate = new Date(today.getFullYear(), month, Number(d));
		if (candidate.getTime() < today.getTime()) candidate.setFullYear(today.getFullYear() + 1);
		setDue(candidate);
		return " ";
	});
	const dueLabel = dueDate ? dueLabelFor(dueDate, now) : null;
	if (dueDate) reasons.push(`Due · ${dueLabel}`);

	// --- Priority -------------------------------------------------------------
	let priority: TaskPriority = "none";
	const setPriority = (value: TaskPriority) => {
		if (priority === "none") priority = value;
	};
	// Explicit `!high` style flags (and single-letter shorthands).
	working = working.replace(/(^|\s)!(urgent|high|medium|med|low|u|h|m|l)\b/gi, (_match, pre: string, flag: string) => {
		const map: Record<string, TaskPriority> = {
			urgent: "urgent", u: "urgent",
			high: "high", h: "high",
			medium: "medium", med: "medium", m: "medium",
			low: "low", l: "low",
		};
		setPriority(map[flag.toLowerCase()] ?? "none");
		return pre;
	});
	// Unambiguous urgency words on their own.
	working = working.replace(/\b(urgent|asap|critical)\b/i, () => {
		setPriority("urgent");
		return " ";
	});
	// Bang runs: ! medium, !! high, !!! urgent (as a standalone token).
	working = working.replace(/(^|\s)(!{1,3})(?=\s|$)/g, (_match, pre: string, bangs: string) => {
		setPriority(bangs.length >= 3 ? "urgent" : bangs.length === 2 ? "high" : "medium");
		return pre;
	});
	if (priority !== "none") reasons.push(`Priority · ${priority}`);

	// --- Kind (task vs note) --------------------------------------------------
	let kind: CaptureKind = "task";
	let forcedKind = false;
	working = working.replace(/^\s*(note|n):\s*/i, () => {
		kind = "note";
		forcedKind = true;
		return " ";
	});
	working = working.replace(/^\s*(task|todo|t):\s*/i, () => {
		if (!forcedKind) {
			kind = "task";
			forcedKind = true;
		}
		return " ";
	});
	if (!forcedKind) {
		const lead = working.trim().toLowerCase();
		if (NOTE_LEAD_WORDS.some((word) => lead.startsWith(word))) {
			kind = "note";
		}
	}

	// --- Column routing (tasks only) -----------------------------------------
	if (kind === "task" && !column && columns.length) {
		const lower = working.toLowerCase();
		const wip = columns.find((c) => /progress|doing|wip|active/.test(normalizeName(c.status) + normalizeName(c.label)));
		const done = columns[columns.length - 1];
		if (/\b(doing|in progress|wip|started|working on)\b/.test(lower) && wip) {
			column = wip;
			reasons.push("Detected work-in-progress");
		} else if (/\b(done|finished|completed|shipped)\b/.test(lower) && done) {
			column = done;
			reasons.push("Detected completed");
		} else {
			column = columns[0];
		}
	}

	// --- Title cleanup --------------------------------------------------------
	let title = working
		.replace(/^\s*[-*•]\s+/, "")
		.replace(/^\s*\[[ x]\]\s*/i, "")
		.replace(/\s{2,}/g, " ")
		.trim()
		// Drop any stray leading punctuation left behind after a keyword like
		// "urgent:" was lifted out (so "urgent: patch CVE" → "patch CVE").
		.replace(/^[\s:;,.\-–—]+/, "")
		.trim();
	if (!title) title = raw.trim();

	reasons.unshift(
		kind === "note"
			? "Filed as a note"
			: column
				? `Task → ${column.label}`
				: "Task",
	);

	return {
		kind,
		title,
		raw,
		priority,
		dueDate,
		dueLabel,
		tags,
		columnStatus: kind === "task" ? (column?.status ?? null) : null,
		columnLabel: kind === "task" ? (column?.label ?? null) : null,
		environmentId: targetEnvId ?? null,
		environmentName: (environment as MapItem | null)?.name ?? null,
		reasons,
	};
}
