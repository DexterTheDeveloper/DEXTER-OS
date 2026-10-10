import { ensureSchema, getConfig, setConfig } from "./db";

// Claude Managed Agents memory stores, reached directly over the REST API.
// Docs: https://platform.claude.com/docs/en/managed-agents/memory
const API = "https://api.anthropic.com/v1";
const MEMORY_BETA = "agent-memory-2026-07-22";

export class MemoryApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "MemoryApiError";
	}
}

export interface MemoryItem {
	type: "memory";
	id: string;
	path: string;
	content_sha256: string;
	content_size_bytes: number;
	updated_at: string;
	content?: string | null;
}

export interface MemoryPrefix {
	type: "memory_prefix";
	path: string;
}

interface MemoryPage {
	data?: (MemoryItem | MemoryPrefix)[];
	next_page?: string | null;
}

interface MemoryStore {
	id: string;
	name: string;
	archived_at: string | null;
	metadata?: Record<string, string>;
}

interface StorePage {
	data?: MemoryStore[];
	next_page?: string | null;
}

async function call<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
	if (!env.ANTHROPIC_API_KEY) {
		throw new MemoryApiError(0, "ANTHROPIC_API_KEY is not set on the dexter-mcp Worker.");
	}
	const headers: Record<string, string> = {
		"x-api-key": env.ANTHROPIC_API_KEY,
		"anthropic-version": "2023-06-01",
		"anthropic-beta": MEMORY_BETA,
	};
	if (body !== undefined) headers["content-type"] = "application/json";

	const response = await fetch(`${API}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let data: unknown;
	try {
		data = text ? JSON.parse(text) : undefined;
	} catch {
		data = undefined;
	}
	if (!response.ok) {
		const message =
			(data as { error?: { message?: string } } | undefined)?.error?.message ??
			(text.slice(0, 300) || response.statusText);
		throw new MemoryApiError(response.status, message);
	}
	return data as T;
}

export async function listMemories(
	env: Env,
	storeId: string,
	options: { pathPrefix?: string; depth?: 0 | 1; full?: boolean; page?: string; limit?: number } = {},
): Promise<MemoryPage> {
	const params = new URLSearchParams();
	if (options.pathPrefix) params.set("path_prefix", options.pathPrefix);
	if (options.depth) params.set("depth", String(options.depth));
	if (options.full) params.set("view", "full");
	if (options.page) params.set("page", options.page);
	if (options.limit) params.set("limit", String(options.limit));
	const query = params.toString();
	return call<MemoryPage>(env, "GET", `/memory_stores/${storeId}/memories${query ? `?${query}` : ""}`);
}

/** Lists every memory under a prefix (up to `maxPages` pages). */
export async function listAll(env: Env, storeId: string, pathPrefix: string, maxPages = 5): Promise<MemoryItem[]> {
	const items: MemoryItem[] = [];
	let page: string | undefined;
	for (let i = 0; i < maxPages; i++) {
		const result = await listMemories(env, storeId, { pathPrefix, limit: 100, page });
		for (const item of result.data ?? []) if (item.type === "memory") items.push(item);
		if (!result.next_page) break;
		page = result.next_page;
	}
	return items;
}

/** Finds one memory by exact path, with its content. */
export async function findMemory(env: Env, storeId: string, path: string): Promise<MemoryItem | null> {
	const directory = path.slice(0, path.lastIndexOf("/") + 1) || "/";
	let page: string | undefined;
	for (let i = 0; i < 10; i++) {
		const result = await listMemories(env, storeId, {
			pathPrefix: directory,
			depth: 1,
			full: true,
			limit: 20,
			page,
		});
		const hit = result.data?.find((item): item is MemoryItem => item.type === "memory" && item.path === path);
		if (hit) return hit;
		if (!result.next_page) return null;
		page = result.next_page;
	}
	return null;
}

export async function createMemory(env: Env, storeId: string, path: string, content: string): Promise<MemoryItem> {
	return call<MemoryItem>(env, "POST", `/memory_stores/${storeId}/memories`, { path, content });
}

export async function updateMemory(
	env: Env,
	storeId: string,
	memoryId: string,
	content: string,
	baseSha256?: string,
): Promise<MemoryItem> {
	const body: Record<string, unknown> = { content };
	if (baseSha256) body.precondition = { type: "content_sha256", content_sha256: baseSha256 };
	return call<MemoryItem>(env, "POST", `/memory_stores/${storeId}/memories/${memoryId}`, body);
}

export interface StoreIds {
	memory: string;
	reference: string;
}

const STORE_SPECS = {
	memory: {
		name: "DEXTER Memory",
		description:
			"DEXTER's working memory for its operator, King Godfrey. /state/STATE.md is the current operating state " +
			"(open items, decisions log, handoff note). /inbox/ holds notes other assistants proposed; treat them as " +
			"unreviewed. Curated notes live under /notes/.",
	},
	reference: {
		name: "DEXTER Reference",
		description:
			"Read-only reference for DEXTER: operating rules, standing orders and Godfrey OS protocols. " +
			"Follow these when acting for the operator.",
	},
} as const;

async function findTaggedStores(env: Env): Promise<Partial<StoreIds>> {
	const found: Partial<StoreIds> = {};
	let page: string | undefined;
	for (let i = 0; i < 5; i++) {
		const query = page ? `?page=${encodeURIComponent(page)}` : "";
		const result = await call<StorePage>(env, "GET", `/memory_stores${query}`);
		for (const store of result.data ?? []) {
			if (store.archived_at || store.metadata?.app !== "dexter") continue;
			const role = store.metadata?.dexter_role;
			if ((role === "memory" || role === "reference") && !found[role]) found[role] = store.id;
		}
		if ((found.memory && found.reference) || !result.next_page) break;
		page = result.next_page;
	}
	return found;
}

async function createStore(env: Env, role: keyof StoreIds): Promise<string> {
	const spec = STORE_SPECS[role];
	const store = await call<MemoryStore>(env, "POST", `/memory_stores`, {
		name: spec.name,
		description: spec.description,
		metadata: { app: "dexter", dexter_role: role },
	});
	return store.id;
}

/** Returns the two store IDs, creating and remembering them on first use. */
export async function ensureStores(env: Env): Promise<StoreIds> {
	if (env.MEMORY_STORE_ID && env.REFERENCE_STORE_ID) {
		return { memory: env.MEMORY_STORE_ID, reference: env.REFERENCE_STORE_ID };
	}
	await ensureSchema(env.DB);
	let memory = env.MEMORY_STORE_ID ?? (await getConfig(env.DB, "memory_store_id")) ?? undefined;
	let reference = env.REFERENCE_STORE_ID ?? (await getConfig(env.DB, "reference_store_id")) ?? undefined;

	if (!memory || !reference) {
		const tagged = await findTaggedStores(env);
		memory ??= tagged.memory ?? (await createStore(env, "memory"));
		reference ??= tagged.reference ?? (await createStore(env, "reference"));
		await setConfig(env.DB, "memory_store_id", memory);
		await setConfig(env.DB, "reference_store_id", reference);
	}
	return { memory, reference };
}
