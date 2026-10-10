import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	addLog,
	addReminder,
	cancelReminder,
	failedReminders,
	getConfig,
	LOG_KINDS,
	pendingReminders,
	recentLog,
} from "./db";
import {
	createMemory,
	ensureStores,
	findMemory,
	listAll,
	MemoryApiError,
	updateMemory,
	type StoreIds,
} from "./memory";
import { pushTopic } from "./reminders";
import { STATE_PATH, summarizeState } from "./state";
import { formatLocal, localDate, parseDueAt } from "./time";
import { slugify } from "./util";

export const SERVER_VERSION = "0.1.0";

export const TOOL_NAMES = [
	"dexter_status",
	"dexter_log",
	"dexter_remind",
	"dexter_cancel_reminder",
	"dexter_memory_list",
	"dexter_memory_read",
	"dexter_memory_propose",
	"dexter_state_write",
] as const;

const INSTRUCTIONS = `DEXTER is King Godfrey's personal AI operating system. These tools are DEXTER's memory and actions, shared by every assistant connected to it.
- Start with dexter_status to see the handoff note, upcoming reminders and recent log.
- Times are in the operator's timezone unless an offset says otherwise. Convert phrases like "Thursday at 5" into ISO 8601 with an offset before calling dexter_remind.
- Memory you write from here lands in /inbox/ for review. Only dexter_state_write changes /state/STATE.md, and it needs the sha256 from a fresh dexter_memory_read.
- Never store financial figures the operator didn't give you.`;

export interface Caller {
	email: string;
	source: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function describeError(error: unknown): string {
	if (error instanceof MemoryApiError) {
		if (error.status === 0) return error.message;
		return `Memory API error (${error.status}): ${error.message}`;
	}
	return error instanceof Error ? error.message : String(error);
}

const storeSchema = z.enum(["memory", "reference"]).default("memory");

function storeId(ids: StoreIds, store: "memory" | "reference"): string {
	return store === "memory" ? ids.memory : ids.reference;
}

function normalizePrefix(prefix: string | undefined): string {
	let value = (prefix ?? "/").trim() || "/";
	if (!value.startsWith("/")) value = `/${value}`;
	if (!value.endsWith("/")) value = `${value}/`;
	return value;
}

export function buildServer(env: Env, caller: Caller): McpServer {
	const tz = env.DEXTER_TZ;
	const server = new McpServer(
		{ name: "dexter", title: "DEXTER", version: SERVER_VERSION },
		{ instructions: INSTRUCTIONS },
	);

	server.registerTool(
		"dexter_status",
		{
			title: "DEXTER status",
			description:
				"Where things stand: the STATE.md handoff note, reminders due in the next 7 days, failed reminders and the 5 latest log entries.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async () => {
			const now = new Date();
			const lines: string[] = [`DEXTER status · ${formatLocal(now, tz)} (${tz})`];

			try {
				const ids = await ensureStores(env);
				const state = await findMemory(env, ids.memory, STATE_PATH);
				if (state?.content) {
					const summary = summarizeState(state.content);
					lines.push(`STATE.md last updated: ${summary.lastUpdated ?? "unknown"}`);
					lines.push(`Handoff: ${summary.handoff ?? "(no handoff note)"}`);
				} else {
					lines.push("STATE.md: not saved yet. Save one with dexter_state_write.");
				}
			} catch (error) {
				lines.push(`Memory unavailable: ${describeError(error)}`);
			}

			const week = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
			const upcoming = await pendingReminders(env.DB, week);
			lines.push("", upcoming.length ? "Reminders, next 7 days:" : "Reminders, next 7 days: none");
			for (const r of upcoming) lines.push(`- ${r.id} · ${formatLocal(r.due_at, tz)} · ${r.text}`);

			const failed = await failedReminders(env.DB);
			if (failed.length) {
				lines.push("", "Reminders that failed to send:");
				for (const r of failed) lines.push(`- ${r.id} · ${formatLocal(r.due_at, tz)} · ${r.text}`);
			}

			const log = await recentLog(env.DB, 5);
			lines.push("", log.length ? "Recent log:" : "Recent log: empty");
			for (const entry of log) lines.push(`- ${formatLocal(entry.created_at, tz)} · ${entry.kind} · ${entry.text}`);

			if (!(await getConfig(env.DB, "push_confirmed"))) {
				lines.push(
					"",
					`Setup: reminder pushes go to the ntfy topic "${await pushTopic(env)}". Subscribe to it in the ntfy app. This line disappears after the first reminder is delivered.`,
				);
			}
			return ok(lines.join("\n"));
		},
	);

	server.registerTool(
		"dexter_log",
		{
			title: "Log to DEXTER",
			description:
				"Append an entry to DEXTER's log: daily proof, workouts, music sessions, content captures, admin, backlog or a plain note.",
			inputSchema: z.object({
				kind: z.enum(LOG_KINDS).describe("What kind of entry this is."),
				text: z.string().trim().min(1).max(2000).describe("The entry, in the operator's words."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async ({ kind, text }) => {
			const row = await addLog(env.DB, { kind, text, source: caller.source });
			return ok(`Logged ${row.id} (${kind}) at ${formatLocal(row.created_at, tz)}.`);
		},
	);

	server.registerTool(
		"dexter_remind",
		{
			title: "Set a DEXTER reminder",
			description: `Schedule a push reminder to the operator's phone. due_at must be ISO 8601 with a UTC offset; the operator's timezone is ${tz}. Read the returned local time back to the operator.`,
			inputSchema: z.object({
				text: z.string().trim().min(1).max(500).describe("What to remind the operator about."),
				due_at: z.string().describe("When, as ISO 8601 with an offset, e.g. 2026-10-15T17:00:00-04:00."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async ({ text, due_at }) => {
			const parsed = parseDueAt(due_at);
			if (!parsed.ok) return fail(parsed.error);
			const row = await addReminder(env.DB, { text, dueAt: parsed.date, source: caller.source });
			return ok(`Reminder ${row.id} set for ${formatLocal(row.due_at, tz)}: ${text}`);
		},
	);

	server.registerTool(
		"dexter_cancel_reminder",
		{
			title: "Cancel a DEXTER reminder",
			description: "Cancel a pending reminder by its id (rem_...). dexter_status lists upcoming ids.",
			inputSchema: z.object({ id: z.string().trim().regex(/^rem_[0-9a-f]{8}$/, "Expected an id like rem_1a2b3c4d") }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async ({ id }) => {
			const result = await cancelReminder(env.DB, id);
			if (result === "cancelled") return ok(`Cancelled ${id}.`);
			if (result === "not_pending") return fail(`${id} already went out or was cancelled.`);
			return fail(`No reminder with id ${id}.`);
		},
	);

	server.registerTool(
		"dexter_memory_list",
		{
			title: "List DEXTER memory",
			description:
				"List memory files. store 'memory' is DEXTER's working memory (STATE.md, notes, inbox); 'reference' holds read-only operating rules.",
			inputSchema: z.object({
				store: storeSchema,
				path_prefix: z.string().optional().describe("Directory to list, e.g. /notes/. Defaults to /."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ store, path_prefix }) => {
			try {
				const ids = await ensureStores(env);
				const prefix = normalizePrefix(path_prefix);
				const items = await listAll(env, storeId(ids, store), prefix);
				if (!items.length) return ok(`No memories under ${prefix} in ${store}.`);
				const lines = items.map(
					(item) => `${item.path} · ${item.content_size_bytes} bytes · updated ${formatLocal(item.updated_at, tz)}`,
				);
				return ok(lines.join("\n"));
			} catch (error) {
				return fail(describeError(error));
			}
		},
	);

	server.registerTool(
		"dexter_memory_read",
		{
			title: "Read DEXTER memory",
			description:
				"Read one memory file by path, e.g. /state/STATE.md. The reply ends with the file's sha256, which dexter_state_write needs.",
			inputSchema: z.object({
				store: storeSchema,
				path: z.string().trim().startsWith("/").describe("Full path, e.g. /state/STATE.md."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ store, path }) => {
			try {
				const ids = await ensureStores(env);
				const item = await findMemory(env, storeId(ids, store), path);
				if (!item) return fail(`No memory at ${path} in ${store}.`);
				return ok(
					`${item.content ?? ""}\n\n---\npath: ${item.path} · sha256: ${item.content_sha256} · updated ${formatLocal(item.updated_at, tz)}`,
				);
			} catch (error) {
				return fail(describeError(error));
			}
		},
	);

	server.registerTool(
		"dexter_memory_propose",
		{
			title: "Propose a DEXTER memory",
			description:
				"Save a note for DEXTER to review later. It lands in /inbox/ and never overwrites existing memory. Use it for facts, decisions or context worth keeping.",
			inputSchema: z.object({
				title: z.string().trim().min(1).max(120).describe("Short title; becomes part of the file name."),
				content: z.string().trim().min(1).max(20000).describe("The note, in Markdown."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async ({ title, content }) => {
			try {
				const ids = await ensureStores(env);
				const base = `/inbox/${slugify(caller.source, 24)}/${localDate(new Date(), tz)}-${slugify(title)}`;
				const body = `# ${title}\n\nFrom: ${caller.source}\n\n${content}\n`;
				for (let attempt = 1; attempt <= 5; attempt++) {
					const path = attempt === 1 ? `${base}.md` : `${base}-${attempt}.md`;
					try {
						const item = await createMemory(env, ids.memory, path, body);
						return ok(`Saved to ${item.path} for review.`);
					} catch (error) {
						if (error instanceof MemoryApiError && error.status === 409) continue;
						throw error;
					}
				}
				return fail("Too many notes with that title today. Pick a different title.");
			} catch (error) {
				return fail(describeError(error));
			}
		},
	);

	server.registerTool(
		"dexter_state_write",
		{
			title: "Write DEXTER STATE.md",
			description:
				"Replace /state/STATE.md with the full new content (the /dexter:save flow). If STATE.md exists, first read it with dexter_memory_read and pass its sha256 as base_sha256; the write is refused if it changed since. Every version is kept, so a bad write can be rolled back.",
			inputSchema: z.object({
				content: z.string().min(1).max(100_000).describe("The complete STATE.md, not a diff."),
				base_sha256: z
					.string()
					.regex(/^[0-9a-f]{64}$/)
					.optional()
					.describe("sha256 of the STATE.md you read. Omit only when no STATE.md exists yet."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async ({ content, base_sha256 }) => {
			try {
				const ids = await ensureStores(env);
				const existing = await findMemory(env, ids.memory, STATE_PATH);
				if (!existing) {
					await createMemory(env, ids.memory, STATE_PATH, content);
					return ok("STATE.md saved to DEXTER memory (first version).");
				}
				if (!base_sha256) {
					return fail(
						"STATE.md already exists. Read it with dexter_memory_read, then pass its sha256 as base_sha256.",
					);
				}
				if (existing.content_sha256 !== base_sha256) {
					return fail("STATE.md changed since you read it. Read it again and reapply your changes.");
				}
				await updateMemory(env, ids.memory, existing.id, content, base_sha256);
				return ok("STATE.md updated. The previous version is kept in DEXTER's memory history.");
			} catch (error) {
				return fail(describeError(error));
			}
		},
	);

	return server;
}
