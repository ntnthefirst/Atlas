import { useEffect, useMemo, useState } from "react";
import type { ActivityBlock } from "../../types";
import type { MainContentViewsProps } from "./types";

type QueryPrimitive = string | number | boolean | null;
type QueryRow = Record<string, QueryPrimitive>;
type QueryTable = "sessions" | "activity" | "analytics";
type OutputMode = "list" | "table" | "raw" | "agenda" | "chart";

type FilterClause = {
	column: string;
	operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "like";
	value: QueryPrimitive;
};

type QuerySpec = {
	table: QueryTable;
	columns: string[];
	where: FilterClause[];
	orderBy: { column: string; direction: "asc" | "desc" } | null;
	limit: number;
};

type QueryResult = {
	rows: QueryRow[];
	columns: string[];
	message: string;
};

type PresetQuery = {
	id: string;
	title: string;
	description: string;
	sql: string;
};

type AggregatedAnalytics = {
	day: string;
	app_name: string;
	total_duration_ms: number;
	opens: number;
	session_count: number;
};

const READ_ONLY_ERROR = "Alleen read-only SELECT queries zijn toegestaan. INSERT/UPDATE/DELETE/DDL zijn geblokkeerd.";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const TABLE_COLUMNS: Record<QueryTable, string[]> = {
	sessions: [
		"session_id",
		"map_id",
		"started_at",
		"ended_at",
		"session_day",
		"is_active",
		"clock_duration_ms",
		"paused_duration_ms",
		"focus_duration_ms",
	],
	activity: [
		"block_id",
		"session_id",
		"map_id",
		"app_name",
		"started_at",
		"ended_at",
		"session_day",
		"block_duration_ms",
		"is_active",
	],
	analytics: ["day", "app_name", "total_duration_ms", "opens", "session_count"],
};

const PRESET_QUERIES: PresetQuery[] = [
	{
		id: "top-apps",
		title: "Top apps",
		description: "Meest gebruikte apps op basis van totale blokduur.",
		sql: "SELECT app_name, total_duration_ms, opens, session_count FROM analytics ORDER BY total_duration_ms DESC LIMIT 20",
	},
	{
		id: "longest-blocks",
		title: "Langste blokken",
		description: "Langste activity blokken in dalende volgorde.",
		sql: "SELECT session_day, app_name, block_duration_ms, started_at FROM activity WHERE block_duration_ms >= 600000 ORDER BY block_duration_ms DESC LIMIT 30",
	},
	{
		id: "session-focus",
		title: "Sessie focus vs pauze",
		description: "Toont per sessie focus-, clock- en pauzeduur.",
		sql: "SELECT session_day, session_id, focus_duration_ms, clock_duration_ms, paused_duration_ms FROM sessions ORDER BY started_at DESC LIMIT 25",
	},
	{
		id: "daily-usage",
		title: "Dagelijks app-gebruik",
		description: "Dagtotalen per app voor agenda/grafiekweergave.",
		sql: "SELECT day, app_name, total_duration_ms FROM analytics ORDER BY day DESC LIMIT 120",
	},
	{
		id: "most-opens",
		title: "Meeste opens",
		description: "Apps met de meeste open-events.",
		sql: "SELECT app_name, opens, session_count FROM analytics ORDER BY opens DESC LIMIT 20",
	},
	{
		id: "active-sessions",
		title: "Actieve sessies",
		description: "Alle nog actieve sessies.",
		sql: "SELECT session_id, started_at, is_active, focus_duration_ms FROM sessions WHERE is_active = 1 ORDER BY started_at DESC LIMIT 20",
	},
];

const toInputDate = (value: Date) => {
	const year = value.getFullYear();
	const month = `${value.getMonth() + 1}`.padStart(2, "0");
	const day = `${value.getDate()}`.padStart(2, "0");
	return `${year}-${month}-${day}`;
};

const cleanAppLabel = (value: string) => {
	const cleaned = value
		.replace(/\s*\[[^\]]*\]\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return cleaned || "Unknown";
};

const blockDurationMs = (block: ActivityBlock, now: number) => {
	if (block.ended_at) {
		return Math.max(0, block.duration);
	}
	return Math.max(0, now - new Date(block.started_at).getTime());
};

const isForbiddenSql = (sql: string) => {
	return /\b(insert|update|delete|drop|alter|create|truncate|replace|attach|detach|pragma|vacuum)\b/i.test(sql);
};

const parseScalar = (raw: string): QueryPrimitive => {
	const value = raw.trim();
	if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
		return value.slice(1, -1);
	}
	if (/^true$/i.test(value)) {
		return true;
	}
	if (/^false$/i.test(value)) {
		return false;
	}
	if (/^null$/i.test(value)) {
		return null;
	}
	if (/^-?\d+(\.\d+)?$/.test(value)) {
		return Number(value);
	}
	return value;
};

const parseWhereClause = (rawWhere: string | undefined): FilterClause[] => {
	if (!rawWhere) {
		return [];
	}
	const parts = rawWhere
		.split(/\s+and\s+/i)
		.map((part) => part.trim())
		.filter(Boolean);

	return parts.map((part) => {
		const match = part.match(/^([a-zA-Z_][\w]*)\s*(=|!=|>=|<=|>|<|like)\s*(.+)$/i);
		if (!match) {
			throw new Error(`Ongeldige WHERE clause: ${part}`);
		}
		const [, column, operatorRaw, valueRaw] = match;
		return {
			column: column.toLowerCase(),
			operator: operatorRaw.toLowerCase() as FilterClause["operator"],
			value: parseScalar(valueRaw),
		};
	});
};

const parseQuery = (sqlInput: string): QuerySpec => {
	const sql = sqlInput.trim().replace(/;+$/, "");
	if (!sql) {
		throw new Error("Voer een query in.");
	}
	if (isForbiddenSql(sql)) {
		throw new Error(READ_ONLY_ERROR);
	}

	const match = sql.match(
		/^select\s+(.+?)\s+from\s+(sessions|activity|analytics)(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+([a-zA-Z_][\w]*)(?:\s+(asc|desc))?)?(?:\s+limit\s+(\d+))?$/i,
	);
	if (!match) {
		throw new Error(
			"Gebruik syntax: SELECT kolommen FROM sessions|activity|analytics [WHERE ...] [ORDER BY kolom ASC|DESC] [LIMIT n]",
		);
	}

	const [, columnsRaw, tableRaw, whereRaw, orderByColumnRaw, directionRaw, limitRaw] = match;
	const columns =
		columnsRaw.trim() === "*"
			? ["*"]
			: columnsRaw
					.split(",")
					.map((column) => column.trim().toLowerCase())
					.filter(Boolean);

	if (!columns.length) {
		throw new Error("Geen kolommen opgegeven in SELECT.");
	}

	const limit = limitRaw ? Math.max(1, Math.min(MAX_LIMIT, Number(limitRaw))) : DEFAULT_LIMIT;

	return {
		table: tableRaw.toLowerCase() as QueryTable,
		columns,
		where: parseWhereClause(whereRaw),
		orderBy: orderByColumnRaw
			? {
					column: orderByColumnRaw.toLowerCase(),
					direction: (directionRaw?.toLowerCase() ?? "asc") as "asc" | "desc",
				}
			: null,
		limit,
	};
};

const toComparable = (value: QueryPrimitive) => {
	if (value === null) {
		return null;
	}
	if (typeof value === "boolean") {
		return value ? 1 : 0;
	}
	if (typeof value === "number") {
		return value;
	}
	const asDate = Date.parse(value);
	if (!Number.isNaN(asDate) && /\d{4}-\d{2}-\d{2}|T/.test(value)) {
		return asDate;
	}
	if (/^-?\d+(\.\d+)?$/.test(value)) {
		return Number(value);
	}
	return value.toLowerCase();
};

const likeToRegex = (pattern: string) => {
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const wildcard = escaped.replace(/%/g, ".*").replace(/_/g, ".");
	return new RegExp(`^${wildcard}$`, "i");
};

const compareWithOperator = (left: QueryPrimitive, operator: FilterClause["operator"], right: QueryPrimitive) => {
	if (operator === "like") {
		const text = left === null ? "" : String(left);
		const pattern = String(right ?? "");
		return likeToRegex(pattern).test(text);
	}

	const leftComparable = toComparable(left);
	const rightComparable = toComparable(right);

	if (operator === "=") {
		return leftComparable === rightComparable;
	}
	if (operator === "!=") {
		return leftComparable !== rightComparable;
	}
	if (leftComparable === null || rightComparable === null) {
		return false;
	}
	if (operator === ">") {
		return leftComparable > rightComparable;
	}
	if (operator === "<") {
		return leftComparable < rightComparable;
	}
	if (operator === ">=") {
		return leftComparable >= rightComparable;
	}
	return leftComparable <= rightComparable;
};

const executeQuery = (spec: QuerySpec, tables: Record<QueryTable, QueryRow[]>): QueryResult => {
	const sourceRows = tables[spec.table];
	const availableColumns = Array.from(
		sourceRows.reduce((set, row) => {
			for (const key of Object.keys(row)) {
				set.add(key.toLowerCase());
			}
			return set;
		}, new Set<string>(TABLE_COLUMNS[spec.table])),
	).sort((a, b) => a.localeCompare(b));

	for (const clause of spec.where) {
		if (!availableColumns.includes(clause.column)) {
			throw new Error(`Onbekende kolom in WHERE: ${clause.column}`);
		}
	}
	if (spec.orderBy && !availableColumns.includes(spec.orderBy.column)) {
		throw new Error(`Onbekende kolom in ORDER BY: ${spec.orderBy.column}`);
	}

	if (spec.columns[0] !== "*") {
		for (const column of spec.columns) {
			if (!availableColumns.includes(column)) {
				throw new Error(`Onbekende kolom in SELECT: ${column}`);
			}
		}
	}

	let rows = sourceRows.filter((row) =>
		spec.where.every((clause) => compareWithOperator(row[clause.column] ?? null, clause.operator, clause.value)),
	);

	if (spec.orderBy) {
		const { column, direction } = spec.orderBy;
		rows = [...rows].sort((a, b) => {
			const left = toComparable(a[column] ?? null);
			const right = toComparable(b[column] ?? null);
			if (left === right) {
				return 0;
			}
			if (left === null) {
				return direction === "asc" ? -1 : 1;
			}
			if (right === null) {
				return direction === "asc" ? 1 : -1;
			}
			if (left > right) {
				return direction === "asc" ? 1 : -1;
			}
			return direction === "asc" ? -1 : 1;
		});
	}

	const limitedRows = rows.slice(0, spec.limit);
	const selectedColumns = spec.columns[0] === "*" ? availableColumns : spec.columns;
	const projectedRows =
		spec.columns[0] === "*"
			? limitedRows
			: limitedRows.map((row) => {
					const projected: QueryRow = {};
					for (const column of selectedColumns) {
						projected[column] = row[column] ?? null;
					}
					return projected;
				});

	return {
		rows: projectedRows,
		columns: selectedColumns,
		message: `${projectedRows.length} rijen (van ${rows.length} matches) uit tabel ${spec.table}`,
	};
};

const findDateColumn = (rows: QueryRow[]) => {
	if (!rows.length) {
		return null;
	}
	const candidates = ["day", "session_day", "started_at", "ended_at"];
	for (const candidate of candidates) {
		if (rows.some((row) => typeof row[candidate] === "string")) {
			return candidate;
		}
	}
	for (const key of Object.keys(rows[0])) {
		if (rows.some((row) => typeof row[key] === "string" && !Number.isNaN(Date.parse(String(row[key]))))) {
			return key;
		}
	}
	return null;
};

const findChartColumns = (rows: QueryRow[], columns: string[]) => {
	const numericColumn = columns.find((column) => rows.some((row) => typeof row[column] === "number"));
	const labelColumn = columns.find((column) => rows.some((row) => typeof row[column] === "string"));
	if (!numericColumn || !labelColumn) {
		return null;
	}
	return { numericColumn, labelColumn };
};

export function AnalysisView({
	sessions,
	selectedSession,
	activityBlocks,
	now,
	sessionElapsedMs,
}: MainContentViewsProps) {
	const [blocksBySessionId, setBlocksBySessionId] = useState<Record<string, ActivityBlock[]>>({});
	const [isLoadingBlocks, setIsLoadingBlocks] = useState(false);
	const [activityError, setActivityError] = useState("");
	const [queryText, setQueryText] = useState(PRESET_QUERIES[0].sql);
	const [selectedPresetId, setSelectedPresetId] = useState(PRESET_QUERIES[0].id);
	const [outputMode, setOutputMode] = useState<OutputMode>("table");
	const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
	const [queryError, setQueryError] = useState("");
	const [hasExecuted, setHasExecuted] = useState(false);

	useEffect(() => {
		if (!selectedSession) {
			return;
		}
		setBlocksBySessionId((current) => {
			const existing = current[selectedSession.id];
			if (existing && existing.length === activityBlocks.length) {
				return current;
			}
			return {
				...current,
				[selectedSession.id]: activityBlocks,
			};
		});
	}, [selectedSession, activityBlocks]);

	useEffect(() => {
		const missingSessionIds = sessions
			.map((session) => session.id)
			.filter((sessionId) => blocksBySessionId[sessionId] === undefined);

		if (!missingSessionIds.length) {
			setIsLoadingBlocks(false);
			return;
		}

		let cancelled = false;
		setIsLoadingBlocks(true);
		setActivityError("");

		void Promise.all(
			missingSessionIds.map(async (sessionId) => ({
				sessionId,
				blocks: await window.atlas.listActivityBySession(sessionId),
			})),
		)
			.then((results) => {
				if (cancelled) {
					return;
				}
				setBlocksBySessionId((current) => {
					const next = { ...current };
					for (const result of results) {
						next[result.sessionId] = result.blocks;
					}
					return next;
				});
			})
			.catch(() => {
				if (!cancelled) {
					setActivityError(
						"Kon activity-data niet volledig laden. Sommige resultaten kunnen onvolledig zijn.",
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingBlocks(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [sessions, blocksBySessionId]);

	const dataTables = useMemo(() => {
		const sessionRows: QueryRow[] = [];
		const activityRows: QueryRow[] = [];
		const analyticsMap = new Map<string, AggregatedAnalytics>();

		for (const session of sessions) {
			const startedAt = new Date(session.started_at);
			const dayKey = toInputDate(startedAt);
			const clockDurationMs = session.is_active ? sessionElapsedMs(session, now) : session.total_duration;
			const focusDurationMs = Math.max(0, clockDurationMs - session.paused_duration);

			sessionRows.push({
				session_id: session.id,
				map_id: session.map_id,
				started_at: session.started_at,
				ended_at: session.ended_at,
				session_day: dayKey,
				is_active: session.is_active,
				clock_duration_ms: Math.max(0, clockDurationMs),
				paused_duration_ms: Math.max(0, session.paused_duration),
				focus_duration_ms: focusDurationMs,
			});

			const blocks = blocksBySessionId[session.id] ?? [];
			for (const block of blocks) {
				const durationMs = blockDurationMs(block, now);
				const appName = cleanAppLabel(block.app_name);
				activityRows.push({
					block_id: block.id,
					session_id: session.id,
					map_id: session.map_id,
					app_name: appName,
					started_at: block.started_at,
					ended_at: block.ended_at,
					session_day: dayKey,
					block_duration_ms: durationMs,
					is_active: session.is_active,
				});

				const aggregateKey = `${dayKey}::${appName}`;
				const existing = analyticsMap.get(aggregateKey);
				if (existing) {
					existing.total_duration_ms += durationMs;
					existing.opens += 1;
					continue;
				}
				analyticsMap.set(aggregateKey, {
					day: dayKey,
					app_name: appName,
					total_duration_ms: durationMs,
					opens: 1,
					session_count: 1,
				});
			}
		}

		for (const aggregate of analyticsMap.values()) {
			const matchingSessionIds = new Set(
				activityRows
					.filter((row) => row.session_day === aggregate.day && row.app_name === aggregate.app_name)
					.map((row) => String(row.session_id)),
			);
			aggregate.session_count = matchingSessionIds.size;
		}

		const analyticsRows: QueryRow[] = Array.from(analyticsMap.values()).map((row) => ({ ...row }));

		return {
			sessions: sessionRows,
			activity: activityRows,
			analytics: analyticsRows,
		} satisfies Record<QueryTable, QueryRow[]>;
	}, [sessions, blocksBySessionId, now, sessionElapsedMs]);

	const runQuery = () => {
		try {
			setQueryError("");
			const query = parseQuery(queryText);
			const result = executeQuery(query, dataTables);
			setQueryResult(result);
			setHasExecuted(true);
		} catch (error) {
			setQueryResult(null);
			setHasExecuted(true);
			setQueryError(error instanceof Error ? error.message : "Onbekende queryfout.");
		}
	};

	useEffect(() => {
		runQuery();
		// Run once at mount with default preset.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const chartData = useMemo(() => {
		if (!queryResult || !queryResult.rows.length) {
			return null;
		}
		const chartColumns = findChartColumns(queryResult.rows, queryResult.columns);
		if (!chartColumns) {
			return null;
		}
		const { labelColumn, numericColumn } = chartColumns;
		const rows = queryResult.rows
			.map((row) => ({
				label: String(row[labelColumn] ?? "(leeg)"),
				value: typeof row[numericColumn] === "number" ? Number(row[numericColumn]) : 0,
			}))
			.filter((row) => row.value > 0)
			.sort((a, b) => b.value - a.value)
			.slice(0, 20);

		const maxValue = rows.reduce((max, row) => Math.max(max, row.value), 0);
		return {
			labelColumn,
			numericColumn,
			rows,
			maxValue,
		};
	}, [queryResult]);

	const agendaGroups = useMemo(() => {
		if (!queryResult || !queryResult.rows.length) {
			return [] as Array<{ day: string; rows: QueryRow[] }>;
		}
		const dateColumn = findDateColumn(queryResult.rows);
		if (!dateColumn) {
			return [] as Array<{ day: string; rows: QueryRow[] }>;
		}
		const groups = new Map<string, QueryRow[]>();
		for (const row of queryResult.rows) {
			const raw = row[dateColumn];
			const asString = raw === null ? "Onbekend" : String(raw);
			const day = /^\d{4}-\d{2}-\d{2}/.test(asString)
				? asString.slice(0, 10)
				: !Number.isNaN(Date.parse(asString))
					? toInputDate(new Date(asString))
					: asString;
			const existing = groups.get(day);
			if (existing) {
				existing.push(row);
			} else {
				groups.set(day, [row]);
			}
		}

		return Array.from(groups.entries())
			.map(([day, rows]) => ({ day, rows }))
			.sort((a, b) => b.day.localeCompare(a.day));
	}, [queryResult]);

	return (
		<div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)] gap-3">
			<aside className="atlas-card grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
				<header className="card-head">
					<h3 className="text-subtitle-small">Vaste queries</h3>
					<span className="text-data-small">Klik om direct te laden</span>
				</header>
				<div className="stack-list min-h-0 overflow-auto pr-1">
					{PRESET_QUERIES.map((preset) => {
						const isActive = selectedPresetId === preset.id;
						return (
							<button
								key={preset.id}
								type="button"
								onClick={() => {
									setSelectedPresetId(preset.id);
									setQueryText(preset.sql);
									setQueryError("");
								}}
								className={`grid gap-1 rounded-xl border p-2.5 text-left transition ${
									isActive
										? "border-primary/60 bg-primary/10"
										: "border-neutral-200 bg-neutral-50 hover:border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700"
								}`}
							>
								<span className="text-body-small font-semibold">{preset.title}</span>
								<span className="text-[11px] text-neutral-500 dark:text-neutral-300">
									{preset.description}
								</span>
							</button>
						);
					})}
				</div>
			</aside>

			<section className="atlas-card grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden">
				<header className="card-head">
					<div className="grid gap-0.5">
						<h3 className="text-subtitle-small">Read-only SQL query</h3>
						<span className="text-data-small">SELECT-only op datasets: sessions, activity, analytics.</span>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							className="action-btn"
							onClick={runQuery}
						>
							Run query
						</button>
						<button
							type="button"
							className="action-btn"
							onClick={() => {
								setSelectedPresetId(PRESET_QUERIES[0].id);
								setQueryText(PRESET_QUERIES[0].sql);
								setQueryError("");
							}}
						>
							Reset
						</button>
					</div>
				</header>

				<div className="grid gap-2 border-b border-neutral-200 pb-2 dark:border-neutral-600">
					<textarea
						value={queryText}
						onChange={(event) => {
							setSelectedPresetId("");
							setQueryText(event.target.value);
						}}
						className="min-h-28 w-full rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 font-mono text-[12px] leading-relaxed outline-none focus:border-primary dark:border-neutral-600 dark:bg-neutral-700"
						spellCheck={false}
					/>
					<div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-300">
						<span>Syntax: SELECT ... FROM sessions|activity|analytics</span>
						<span>WHERE met AND + operators: = != &gt; &lt; &gt;= &lt;= LIKE</span>
						<span>ORDER BY + LIMIT ondersteund</span>
					</div>
					{activityError ? <p className="text-[12px] text-amber-600">{activityError}</p> : null}
					{isLoadingBlocks ? <p className="text-[12px] text-neutral-500">Activity-data laden...</p> : null}
					{queryError ? <p className="text-[12px] text-red-600">{queryError}</p> : null}
				</div>

				<div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2 pt-2">
					<div className="flex flex-wrap items-center gap-1">
						{(["list", "table", "raw", "agenda", "chart"] as OutputMode[]).map((mode) => (
							<button
								key={mode}
								type="button"
								onClick={() => setOutputMode(mode)}
								className={`rounded-lg border px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] ${
									outputMode === mode
										? "border-primary/70 bg-primary/10 text-primary"
										: "border-neutral-200 text-neutral-500 dark:border-neutral-600 dark:text-neutral-300"
								}`}
							>
								{mode}
							</button>
						))}
						{queryResult ? (
							<span className="ml-auto text-[11px] text-neutral-500">{queryResult.message}</span>
						) : null}
					</div>

					<div className="min-h-0 overflow-auto pr-1">
						{!hasExecuted ? <p className="empty">Voer een query uit om resultaten te zien.</p> : null}

						{hasExecuted && queryResult && !queryResult.rows.length ? (
							<p className="empty">Geen resultaten voor deze query.</p>
						) : null}

						{hasExecuted && queryResult && outputMode === "list" ? (
							<div className="stack-list">
								{queryResult.rows.map((row, index) => (
									<div
										key={`list-${index}`}
										className="grid gap-1 rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-600 dark:bg-neutral-700"
									>
										{queryResult.columns.map((column) => (
											<div
												key={`${index}-${column}`}
												className="flex items-start justify-between gap-2 text-[12px]"
											>
												<span className="text-neutral-500 dark:text-neutral-300">{column}</span>
												<strong className="font-mono text-[11px] text-neutral-700 dark:text-neutral-100">
													{String(row[column] ?? "null")}
												</strong>
											</div>
										))}
									</div>
								))}
							</div>
						) : null}

						{hasExecuted && queryResult && outputMode === "table" ? (
							<div className="overflow-auto rounded-xl border border-neutral-200 dark:border-neutral-600">
								<table className="min-w-full border-collapse text-left text-[12px]">
									<thead className="bg-neutral-100 dark:bg-neutral-700">
										<tr>
											{queryResult.columns.map((column) => (
												<th
													key={column}
													className="border-b border-neutral-200 px-2 py-1.5 font-semibold uppercase tracking-[0.06em] dark:border-neutral-600"
												>
													{column}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{queryResult.rows.map((row, rowIndex) => (
											<tr
												key={`row-${rowIndex}`}
												className="odd:bg-white even:bg-neutral-50 dark:odd:bg-neutral-800 dark:even:bg-neutral-700"
											>
												{queryResult.columns.map((column) => (
													<td
														key={`${rowIndex}-${column}`}
														className="border-b border-neutral-200 px-2 py-1.5 font-mono text-[11px] dark:border-neutral-600"
													>
														{String(row[column] ?? "null")}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						) : null}

						{hasExecuted && queryResult && outputMode === "raw" ? (
							<pre className="rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 font-mono text-[11px] leading-relaxed dark:border-neutral-600 dark:bg-neutral-700">
								{JSON.stringify(queryResult.rows, null, 2)}
							</pre>
						) : null}

						{hasExecuted && queryResult && outputMode === "agenda" ? (
							agendaGroups.length ? (
								<div className="stack-list">
									{agendaGroups.map((group) => (
										<div
											key={group.day}
											className="grid gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-600 dark:bg-neutral-700"
										>
											<div className="stack-row">
												<strong className="text-body-small">{group.day}</strong>
												<span className="text-data-small">{group.rows.length} items</span>
											</div>
											<div className="grid gap-1">
												{group.rows.slice(0, 8).map((row, index) => (
													<div
														key={`${group.day}-${index}`}
														className="rounded-lg border border-neutral-200 px-2 py-1 text-[11px] dark:border-neutral-600"
													>
														{queryResult.columns
															.filter(
																(column) =>
																	column !== "day" && column !== "session_day",
															)
															.slice(0, 3)
															.map(
																(column) =>
																	`${column}: ${String(row[column] ?? "null")}`,
															)
															.join(" | ")}
													</div>
												))}
											</div>
										</div>
									))}
								</div>
							) : (
								<p className="empty">Geen datumkolom gevonden voor agendaweergave.</p>
							)
						) : null}

						{hasExecuted && queryResult && outputMode === "chart" ? (
							chartData && chartData.rows.length ? (
								<div className="grid gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-600 dark:bg-neutral-700">
									<div className="text-[11px] text-neutral-500 dark:text-neutral-300">
										Diagram op {chartData.labelColumn} vs {chartData.numericColumn}
									</div>
									<div className="grid gap-1.5">
										{chartData.rows.map((row) => {
											const percent =
												chartData.maxValue > 0 ? (row.value / chartData.maxValue) * 100 : 0;
											return (
												<div
													key={`${row.label}-${row.value}`}
													className="grid grid-cols-[minmax(120px,220px)_1fr_auto] items-center gap-2"
												>
													<span className="truncate text-[11px]">{row.label}</span>
													<div className="h-2 rounded-full bg-neutral-200 dark:bg-neutral-600">
														<div
															className="h-full rounded-full bg-[linear-gradient(90deg,#f97316,#dc2626,#7c3aed)]"
															style={{ width: `${Math.max(2, percent)}%` }}
														/>
													</div>
													<strong className="font-mono text-[11px]">
														{row.value.toLocaleString("nl-NL")}
													</strong>
												</div>
											);
										})}
									</div>
								</div>
							) : (
								<p className="empty">
									Geen geschikte label- en numerieke kolom gevonden voor grafiekweergave.
								</p>
							)
						) : null}
					</div>
				</div>
			</section>
		</div>
	);
}
