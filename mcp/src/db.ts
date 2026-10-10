import { shortId } from "./util";

// Tables are created on first use, so a fresh D1 database needs no migration step.
// schema.sql mirrors these statements for reference.
const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS log (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT, created_at TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, text TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, source TEXT, created_at TEXT NOT NULL, sent_at TEXT)`,
	`CREATE INDEX IF NOT EXISTS reminders_due ON reminders (status, due_at)`,
	`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
];

let schemaReady: Promise<void> | undefined;

export function ensureSchema(db: D1Database): Promise<void> {
	schemaReady ??= db
		.batch(SCHEMA.map((statement) => db.prepare(statement)))
		.then(() => undefined)
		.catch((error) => {
			schemaReady = undefined;
			throw error;
		});
	return schemaReady;
}

/** Tests get fresh storage per test, so they need to clear the cached promise. */
export function resetSchemaCache(): void {
	schemaReady = undefined;
}

export const LOG_KINDS = ["note", "proof", "workout", "music", "content", "admin", "backlog"] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export interface LogRow {
	id: string;
	kind: LogKind;
	text: string;
	source: string | null;
	created_at: string;
}

export type ReminderStatus = "pending" | "sending" | "sent" | "cancelled" | "failed";

export interface ReminderRow {
	id: string;
	text: string;
	due_at: string;
	status: ReminderStatus;
	attempts: number;
	source: string | null;
	created_at: string;
	sent_at: string | null;
}

export async function getConfig(db: D1Database, key: string): Promise<string | null> {
	await ensureSchema(db);
	const row = await db.prepare(`SELECT value FROM config WHERE key = ?`).bind(key).first<{ value: string }>();
	return row?.value ?? null;
}

export async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.bind(key, value, new Date().toISOString())
		.run();
}

export async function addLog(
	db: D1Database,
	entry: { kind: LogKind; text: string; source: string },
): Promise<LogRow> {
	await ensureSchema(db);
	const row: LogRow = {
		id: shortId("log"),
		kind: entry.kind,
		text: entry.text,
		source: entry.source,
		created_at: new Date().toISOString(),
	};
	await db
		.prepare(`INSERT INTO log (id, kind, text, source, created_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(row.id, row.kind, row.text, row.source, row.created_at)
		.run();
	return row;
}

export async function recentLog(db: D1Database, limit: number): Promise<LogRow[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT * FROM log ORDER BY created_at DESC LIMIT ?`)
		.bind(limit)
		.all<LogRow>();
	return results;
}

export async function addReminder(
	db: D1Database,
	entry: { text: string; dueAt: Date; source: string },
): Promise<ReminderRow> {
	await ensureSchema(db);
	const row: ReminderRow = {
		id: shortId("rem"),
		text: entry.text,
		due_at: entry.dueAt.toISOString(),
		status: "pending",
		attempts: 0,
		source: entry.source,
		created_at: new Date().toISOString(),
		sent_at: null,
	};
	await db
		.prepare(
			`INSERT INTO reminders (id, text, due_at, status, attempts, source, created_at)
			 VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
		)
		.bind(row.id, row.text, row.due_at, row.source, row.created_at)
		.run();
	return row;
}

export async function cancelReminder(
	db: D1Database,
	id: string,
): Promise<"cancelled" | "not_found" | "not_pending"> {
	await ensureSchema(db);
	const result = await db
		.prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
		.bind(id)
		.run();
	if (result.meta.changes === 1) return "cancelled";
	const exists = await db.prepare(`SELECT id FROM reminders WHERE id = ?`).bind(id).first();
	return exists ? "not_pending" : "not_found";
}

export async function pendingReminders(db: D1Database, untilIso: string): Promise<ReminderRow[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 50`)
		.bind(untilIso)
		.all<ReminderRow>();
	return results;
}

export async function failedReminders(db: D1Database): Promise<ReminderRow[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(`SELECT * FROM reminders WHERE status = 'failed' ORDER BY due_at DESC LIMIT 5`)
		.all<ReminderRow>();
	return results;
}
