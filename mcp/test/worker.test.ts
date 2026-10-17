import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAuthRequest } from "../src/access";
import { resetSchemaCache } from "../src/db";
import worker, { mcpApiHandler } from "../src/index";
import { deliverDueReminders } from "../src/reminders";
import { TOOL_NAMES } from "../src/server";

const ORIGIN = "https://dexter-mcp.example.workers.dev";

type Json = Record<string, any>;

/** Calls the MCP endpoint the way an authenticated client would, past the OAuth layer. */
async function rpc(method: string, params: Json = {}, props: Json = {}, custom: Partial<Env> = {}): Promise<Json> {
	const ctx = createExecutionContext() as ExecutionContext & { props?: Json };
	ctx.props = { operator: true, email: "", name: "Operator", sub: "operator", client: "Claude", ...props };
	const request = new Request(`${ORIGIN}/mcp`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-11-25",
			Host: new URL(ORIGIN).host,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const response = await mcpApiHandler.fetch(request, { ...env, ...custom } as Env, ctx);
	await waitOnExecutionContext(ctx);
	const text = await response.text();
	if (response.headers.get("content-type")?.includes("text/event-stream")) {
		const data = text
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.pop();
		return JSON.parse(data ?? "{}");
	}
	return { status: response.status, ...(text ? JSON.parse(text) : {}) };
}

async function callTool(name: string, args: Json = {}, custom: Partial<Env> = {}): Promise<{ text: string; isError: boolean }> {
	const result = await rpc("tools/call", { name, arguments: args }, {}, custom);
	expect(result.error, JSON.stringify(result.error)).toBeUndefined();
	return {
		text: (result.result?.content ?? []).map((c: Json) => c.text).join("\n"),
		isError: Boolean(result.result?.isError),
	};
}

// A tiny in-memory stand-in for the Managed Agents memory store API.
function memoryApiStub() {
	const stores: Json[] = [];
	const memories: Json[] = [];
	const sha = async (text: string) =>
		Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");

	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.hostname === "ntfy.sh") return new Response("ok");
		if (url.hostname !== "api.anthropic.com") return new Response("unexpected host", { status: 599 });
		expect(request.headers.get("anthropic-beta")).toBe("agent-memory-2026-07-22");

		const path = url.pathname;
		if (path === "/v1/memory_stores" && request.method === "GET") return Response.json({ data: stores, next_page: null });
		if (path === "/v1/memory_stores" && request.method === "POST") {
			const body = (await request.json()) as Json;
			const store = { id: `memstore_${stores.length + 1}`, archived_at: null, ...body };
			stores.push(store);
			return Response.json(store);
		}
		const list = path.match(/^\/v1\/memory_stores\/([^/]+)\/memories$/);
		if (list && request.method === "GET") {
			const prefix = url.searchParams.get("path_prefix") ?? "/";
			const full = url.searchParams.get("view") === "full";
			const data = memories
				.filter((m) => m.memory_store_id === list[1] && m.path.startsWith(prefix))
				.map((m) => ({ ...m, content: full ? m.content : null }));
			return Response.json({ data, next_page: null });
		}
		if (list && request.method === "POST") {
			const body = (await request.json()) as Json;
			if (memories.some((m) => m.memory_store_id === list[1] && m.path === body.path)) {
				return Response.json({ error: { message: "path exists" } }, { status: 409 });
			}
			const memory = {
				type: "memory",
				id: `mem_${memories.length + 1}`,
				memory_store_id: list[1],
				path: body.path,
				content: body.content,
				content_sha256: await sha(body.content),
				content_size_bytes: body.content.length,
				updated_at: new Date().toISOString(),
			};
			memories.push(memory);
			return Response.json(memory);
		}
		const one = path.match(/^\/v1\/memory_stores\/([^/]+)\/memories\/([^/]+)$/);
		if (one && request.method === "POST") {
			const body = (await request.json()) as Json;
			const memory = memories.find((m) => m.id === one[2]);
			if (!memory) return Response.json({ error: { message: "not found" } }, { status: 404 });
			if (body.precondition && body.precondition.content_sha256 !== memory.content_sha256) {
				return Response.json({ error: { message: "precondition failed" } }, { status: 409 });
			}
			memory.content = body.content;
			memory.content_sha256 = await sha(body.content);
			return Response.json(memory);
		}
		return new Response("unhandled", { status: 598 });
	};
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	resetSchemaCache();
	fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(memoryApiStub());
});

afterEach(() => {
	fetchSpy.mockRestore();
});

describe("OAuth surface", () => {
	it("refuses /mcp without a token and points at resource metadata", async () => {
		fetchSpy.mockRestore();
		const response = await SELF.fetch(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate") ?? "").toContain("resource_metadata");
	});

	it("publishes protected resource metadata for /mcp", async () => {
		fetchSpy.mockRestore();
		const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Json;
		expect(body.resource).toBe(`${ORIGIN}/mcp`);
	});

	it("shows which secrets are missing instead of failing silently", async () => {
		const ctx = createExecutionContext();
		const partial = { ...env, ANTHROPIC_API_KEY: undefined, DEXTER_PASSPHRASE: "short" } as Env;
		const response = await handleAuthRequest(new Request(`${ORIGIN}/`), partial, ctx);
		const html = await response.text();
		expect(html).toContain("ANTHROPIC_API_KEY");
		expect(html).toContain("DEXTER_PASSPHRASE (needs at least 12 characters)");
		expect(html).not.toContain("short");
	});

	it("asks for ALLOWED_EMAIL once Access sign-in is configured", async () => {
		const ctx = createExecutionContext();
		const access = {
			...env,
			ACCESS_CLIENT_ID: "test-client",
			ACCESS_CLIENT_SECRET: "test-secret",
			ACCESS_ISSUER: "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/test-client",
		} as Env;
		const html = await (await handleAuthRequest(new Request(`${ORIGIN}/`), access, ctx)).text();
		expect(html).toContain("ALLOWED_EMAIL");
		expect(html).not.toContain("test-secret");
	});

	it("turns dynamic client registration off when ALLOW_CLIENT_REGISTRATION is false", async () => {
		fetchSpy.mockRestore();
		const off = { ALLOW_CLIENT_REGISTRATION: "false" };
		const registration = await viaWorker(
			new Request(`${ORIGIN}/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Host: new URL(ORIGIN).host, "CF-Connecting-IP": ip },
				body: JSON.stringify({ client_name: "Late Comer", redirect_uris: ["https://late.example.com/cb"] }),
			}),
			off,
		);
		expect(registration.status).toBe(403);
		expect(((await registration.json()) as Json).error).toBe("access_denied");

		const metadata = (await (
			await viaWorker(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`, { headers: { Host: new URL(ORIGIN).host } }), off)
		).json()) as Json;
		expect(metadata.registration_endpoint).toBeUndefined();
		expect(metadata.token_endpoint).toBe(`${ORIGIN}/token`);

		// The default, and anything other than "false", keeps it on.
		const on = (await viaWorker(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`, { headers: { Host: new URL(ORIGIN).host } }), {
			ALLOW_CLIENT_REGISTRATION: "yes",
		}).then((r) => r.json())) as Json;
		expect(on.registration_endpoint).toBe(`${ORIGIN}/register`);
	});

	it("rejects tokens that weren't issued to the operator", async () => {
		expect((await rpc("tools/list", {}, { operator: false })).status).toBe(403);
	});

	it("rejects an Access identity that isn't ALLOWED_EMAIL", async () => {
		const ctx = createExecutionContext() as ExecutionContext & { props?: Json };
		ctx.props = { operator: true, email: "someone@else.com", sub: "x", client: "Claude" };
		const request = new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { Host: new URL(ORIGIN).host }, body: "{}" });
		const response = await mcpApiHandler.fetch(request, { ...env, ALLOWED_EMAIL: "operator@example.com" } as Env, ctx);
		expect(response.status).toBe(403);
	});
});

describe("tools", () => {
	it("lists every DEXTER tool, in a fixed order", async () => {
		const result = await rpc("tools/list");
		const names = (result.result?.tools ?? []).map((t: Json) => t.name);
		expect(names).toEqual([...TOOL_NAMES]);
	});

	it("logs entries and shows them in status", async () => {
		const logged = await callTool("dexter_log", { kind: "workout", text: "5AM run, 3 miles" });
		expect(logged.text).toMatch(/^Logged log_[0-9a-f]{8} \(workout\)/);

		const status = await callTool("dexter_status");
		expect(status.text).toContain("workout · 5AM run, 3 miles");
		expect(status.text).toContain("STATE.md: not saved yet");
		expect(status.text).toContain("push configured, not yet confirmed");
		expect(status.text).not.toContain("dexter-test-topic");
	});

	it("generates the ntfy topic on first status but never shows it to an assistant", async () => {
		const noPinnedTopic = { NTFY_TOPIC: undefined };
		const status = await callTool("dexter_status", {}, noPinnedTopic);
		const row = await env.DB.prepare(`SELECT value FROM config WHERE key = 'ntfy_topic'`).first<{ value: string }>();
		expect(row?.value).toMatch(/^dexter-[0-9a-f]{32}$/);
		expect(status.text).toContain("push configured");
		expect(status.text).not.toContain(row!.value);
		expect(status.text).not.toContain(row!.value.slice("dexter-".length));

		const listing = await rpc("tools/list", {}, {}, noPinnedTopic);
		expect(JSON.stringify(listing)).not.toContain(row!.value);
	});

	it("sets, lists and cancels reminders", async () => {
		const due = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace("Z", "+00:00");
		const set = await callTool("dexter_remind", { text: "Call Corinthian", due_at: due });
		const id = set.text.match(/rem_[0-9a-f]{8}/)?.[0];
		expect(id).toBeTruthy();

		expect((await callTool("dexter_status")).text).toContain(`${id} ·`);
		expect((await callTool("dexter_cancel_reminder", { id })).text).toBe(`Cancelled ${id}.`);
		expect((await callTool("dexter_cancel_reminder", { id })).isError).toBe(true);
	});

	it("refuses reminders without an offset", async () => {
		const result = await callTool("dexter_remind", { text: "x", due_at: "2026-12-01T09:00:00" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("UTC offset");
	});

	it("writes STATE.md with a hash guard, and status reads the handoff", async () => {
		const first = await callTool("dexter_state_write", {
			content: "Last updated: 2026-10-10\n\nHandoff note (where I left off)\n\nShip DEX-001.",
		});
		expect(first.text).toContain("first version");

		const status = await callTool("dexter_status");
		expect(status.text).toContain("Handoff: Ship DEX-001.");

		const noBase = await callTool("dexter_state_write", { content: "overwrite" });
		expect(noBase.isError).toBe(true);

		const read = await callTool("dexter_memory_read", { path: "/state/STATE.md" });
		const sha = read.text.match(/sha256: ([0-9a-f]{64})/)?.[1];
		expect(sha).toBeTruthy();

		const second = await callTool("dexter_state_write", { content: "Handoff note\n\nNext.", base_sha256: sha });
		expect(second.text).toContain("STATE.md updated");

		const stale = await callTool("dexter_state_write", { content: "again", base_sha256: sha });
		expect(stale.isError).toBe(true);
		expect(stale.text).toContain("changed since you read it");
	});

	it("puts proposed memory in the inbox and never overwrites", async () => {
		const a = await callTool("dexter_memory_propose", { title: "BBI2 tracklist idea", content: "Open with Wake Up." });
		const b = await callTool("dexter_memory_propose", { title: "BBI2 tracklist idea", content: "Second thought." });
		expect(a.text).toMatch(/Saved to \/inbox\/claude\/\d{4}-\d{2}-\d{2}-bbi2-tracklist-idea\.md/);
		expect(b.text).toMatch(/bbi2-tracklist-idea-2\.md/);

		const listing = await callTool("dexter_memory_list", { path_prefix: "inbox" });
		expect(listing.text.split("\n")).toHaveLength(2);
	});
});

describe("reminder delivery", () => {
	it("sends due reminders once", async () => {
		const due = new Date(Date.now() + 2 * 60 * 1000).toISOString();
		await callTool("dexter_remind", { text: "Stretch", due_at: due });

		const later = new Date(Date.now() + 3 * 60 * 1000);
		expect(await deliverDueReminders(env, later)).toEqual({ sent: 1, failed: 0 });
		expect(await deliverDueReminders(env, later)).toEqual({ sent: 0, failed: 0 });

		const pushes = fetchSpy.mock.calls.filter(([input]: unknown[]) => String(input).startsWith("https://ntfy.sh/"));
		expect(pushes).toHaveLength(1);
		expect(String(pushes[0][0])).toBe("https://ntfy.sh/dexter-test-topic");

		const status = await callTool("dexter_status");
		expect(status.text).not.toContain("push configured");
	});

	it("marks a reminder failed after three failed sends", async () => {
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
			if (String(input).startsWith("https://ntfy.sh/")) return new Response("down", { status: 503 });
			return memoryApiStub()(input);
		});
		const due = new Date(Date.now() + 2 * 60 * 1000).toISOString();
		await callTool("dexter_remind", { text: "Hydrate", due_at: due });

		const later = new Date(Date.now() + 3 * 60 * 1000);
		for (let i = 0; i < 3; i++) await deliverDueReminders(env, later);
		const status = await callTool("dexter_status");
		expect(status.text).toContain("Reminders that failed to send:");
		expect(status.text).toContain("Hydrate");
	});
});

describe("protocol eras", () => {
	it("serves 2026-07-28 clients as well as 2025-era clients", async () => {
		const ctx = createExecutionContext() as ExecutionContext & { props?: Json };
		ctx.props = { operator: true, email: "", name: "Operator", sub: "operator", client: "Claude" };
		const request = new Request(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Host: new URL(ORIGIN).host,
				"Mcp-Method": "tools/list",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 7,
				method: "tools/list",
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
						"io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
					},
				},
			}),
		});
		const response = await mcpApiHandler.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const text = await response.text();
		const payload = text.includes("data:")
			? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5))
			: JSON.parse(text);
		expect(payload.error, JSON.stringify(payload.error)).toBeUndefined();
		expect(payload.result.tools.map((t: Json) => t.name)).toEqual([...TOOL_NAMES]);
	});
});

/** A fresh client IP per test: the rate limiter and the lock-out counter are both keyed by it. */
let ip = "";
beforeEach(() => {
	const [a, b, c] = crypto.getRandomValues(new Uint8Array(3));
	ip = `10.${a}.${b}.${c}`;
});

/** Sends a request straight into the Worker's fetch handler with a modified environment. */
async function viaWorker(request: Request, custom: Partial<Env>): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], { ...env, ...custom } as Env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("end-to-end OAuth with the passphrase", () => {
	const REDIRECT = "https://client.example.com/callback";

	async function pkce() {
		const verifier = "v".repeat(10) + crypto.randomUUID() + crypto.randomUUID();
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		let binary = "";
		for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
		const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		return { verifier, challenge };
	}

	const cookieHeader = (response: Response) =>
		response.headers
			.getSetCookie()
			.map((cookie) => cookie.split(";")[0])
			.join("; ");

	async function registerClient(): Promise<string> {
		const registration = await SELF.fetch(`${ORIGIN}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
			body: JSON.stringify({
				client_name: "Test Client",
				redirect_uris: [REDIRECT],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
			}),
		});
		expect(registration.status).toBeLessThan(300);
		return ((await registration.json()) as Json).client_id;
	}

	async function startConsent(client_id?: string) {
		client_id ??= await registerClient();
		const { verifier, challenge } = await pkce();
		const authorizeUrl = new URL(`${ORIGIN}/authorize`);
		authorizeUrl.search = new URLSearchParams({
			response_type: "code",
			client_id,
			redirect_uri: REDIRECT,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: "state-123",
			resource: `${ORIGIN}/mcp`,
		}).toString();
		const consent = await SELF.fetch(authorizeUrl, { redirect: "manual" });
		expect(consent.status).toBe(200);
		const html = await consent.text();
		expect(html).toContain("Test Client");
		expect(html).toContain('type="password"');
		const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
		expect(handle).toBeTruthy();
		return { client_id, verifier, handle: handle!, cookies: cookieHeader(consent) };
	}

	function approveRequest(handle: string, cookies: string, passphrase: string) {
		return new Request(`${ORIGIN}/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Cookie: cookies,
				Host: new URL(ORIGIN).host,
				"CF-Connecting-IP": ip,
			},
			body: new URLSearchParams({ handle, decision: "approve", passphrase }).toString(),
		});
	}

	async function submit(handle: string, cookies: string, passphrase: string) {
		return SELF.fetch(approveRequest(handle, cookies, passphrase));
	}

	/** Same POST, but straight into the Worker with a modified environment. */
	function submitWith(custom: Partial<Env>, handle: string, cookies: string, passphrase: string) {
		return viaWorker(approveRequest(handle, cookies, passphrase), custom);
	}

	/** The real OAUTH_KV, except that the named methods throw for keys under `prefix`. */
	function kvFailingOn(prefix: string, methods: ("get" | "put")[]): KVNamespace {
		const real = env.OAUTH_KV as any;
		const wrap = (method: "get" | "put") => (key: string, ...rest: unknown[]) => {
			if (methods.includes(method) && key.startsWith(prefix)) return Promise.reject(new Error("KV unavailable"));
			return real[method](key, ...rest);
		};
		return {
			get: wrap("get"),
			put: wrap("put"),
			delete: (key: string) => real.delete(key),
			list: (options?: unknown) => real.list(options),
			getWithMetadata: (...args: unknown[]) => real.getWithMetadata(...args),
		} as unknown as KVNamespace;
	}

	it("refuses a wrong passphrase and offers a fresh consent form to retry on", async () => {
		const { handle, cookies } = await startConsent();
		const wrong = await submit(handle, cookies, "not the passphrase");
		expect(wrong.status).toBe(401);
		const html = await wrong.text();
		expect(html).toContain("That passphrase didn");
		const freshHandle = html.match(/name="handle" value="([^"]+)"/)?.[1];
		expect(freshHandle).toBeTruthy();
		expect(freshHandle).not.toBe(handle);

		// The first handle was consumed when it was checked, before the passphrase was compared.
		const reused = await submit(handle, cookies, "correct horse battery staple");
		expect(reused.status).toBe(400);

		const right = await submit(freshHandle!, cookieHeader(wrong), "correct horse battery staple");
		expect(right.status).toBe(302);
	});

	it("answers a POST with no consent context the same way for a right and a wrong passphrase", async () => {
		const bare = (passphrase: string) =>
			SELF.fetch(`${ORIGIN}/authorize`, {
				method: "POST",
				redirect: "manual",
				headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
				body: new URLSearchParams({ decision: "approve", passphrase }).toString(),
			});
		const right = await bare("correct horse battery staple");
		const wrong = await bare("not the passphrase");
		expect(right.status).toBe(400);
		expect(wrong.status).toBe(right.status);
		expect(await wrong.text()).toBe(await right.text());
		expect(right.headers.get("Location")).toBeNull();
	});

	it("issues no token while the lock-out counter can't be read, even with the right passphrase", async () => {
		const { handle, cookies } = await startConsent();
		const kv = kvFailingOn("dexter:pass-fail:", ["get"]);
		const response = await submitWith({ OAUTH_KV: kv }, handle, cookies, "correct horse battery staple");
		expect(response.status).toBe(500);
		expect(response.headers.get("Location")).toBeNull();
		// The handle was never consumed: the same consent form still works once KV is back.
		const retry = await submit(handle, cookies, "correct horse battery staple");
		expect(retry.status).toBe(302);
	});

	it("refuses instead of forgiving a wrong passphrase when the failure can't be recorded", async () => {
		const { handle, cookies } = await startConsent();
		const kv = kvFailingOn("dexter:pass-fail:", ["put"]);
		const response = await submitWith({ OAUTH_KV: kv }, handle, cookies, "not the passphrase");
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain('name="handle"');
	});

	it("locks an IP out after five wrong passphrases", async () => {
		const client_id = await registerClient();
		for (let i = 0; i < 5; i++) {
			const { handle, cookies } = await startConsent(client_id);
			expect((await submit(handle, cookies, `wrong ${i}`)).status).toBe(401);
		}
		const { handle, cookies } = await startConsent(client_id);
		const locked = await submit(handle, cookies, "correct horse battery staple");
		expect(locked.status).toBe(429);
		expect(locked.headers.get("Retry-After")).toBe("900");
	});

	describe("per-IP rate limit", () => {
		const denying = { limit: async () => ({ success: false }) } as unknown as RateLimit;
		const broken = { limit: async () => { throw new Error("binding down"); } } as unknown as RateLimit;

		function post(path: string, custom: Partial<Env>) {
			const request = new Request(`${ORIGIN}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, Host: new URL(ORIGIN).host },
				body: "{}",
			});
			return viaWorker(request, custom);
		}

		it("returns 429 with Retry-After on /authorize and /register once the limit is hit", async () => {
			for (const path of ["/authorize", "/register"]) {
				const response = await post(path, { AUTH_RL: denying });
				expect(response.status, path).toBe(429);
				expect(response.headers.get("Retry-After"), path).toBe("60");
			}
			expect((await post("/register", { AUTH_RL: denying })).headers.get("Content-Type")).toContain("application/json");
		});

		it("fails closed when the limiter itself fails", async () => {
			expect((await post("/register", { AUTH_RL: broken })).status).toBe(429);
			expect((await post("/authorize", { AUTH_RL: undefined })).status).toBe(429);
		});

		it("is wired to the real binding: the 11th registration in a minute is refused", async () => {
			const register = () =>
				SELF.fetch(`${ORIGIN}/register`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
					body: JSON.stringify({ client_name: "Burst", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
				});
			const statuses: number[] = [];
			for (let i = 0; i < 11; i++) statuses.push((await register()).status);
			expect(statuses.slice(0, 10).every((s) => s < 300), statuses.join(",")).toBe(true);
			expect(statuses[10], statuses.join(",")).toBe(429);
		});

		it("does not meter GET requests", async () => {
			const response = await viaWorker(new Request(`${ORIGIN}/`, { headers: { Host: new URL(ORIGIN).host } }), { AUTH_RL: denying });
			expect(response.status).toBe(200);
		});
	});

	it("issues a token that opens /mcp", async () => {
		const { client_id, verifier, handle, cookies } = await startConsent();
		const approved = await submit(handle, cookies, "correct horse battery staple");
		expect(approved.status).toBe(302);
		const location = new URL(approved.headers.get("Location")!);
		expect(location.origin + location.pathname).toBe(REDIRECT);
		expect(location.searchParams.get("state")).toBe("state-123");
		const code = location.searchParams.get("code");
		expect(code).toBeTruthy();

		const token = await SELF.fetch(`${ORIGIN}/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: code!,
				redirect_uri: REDIRECT,
				client_id,
				code_verifier: verifier,
				resource: `${ORIGIN}/mcp`,
			}).toString(),
		});
		expect(token.status).toBe(200);
		const { access_token } = (await token.json()) as Json;
		expect(access_token).toBeTruthy();

		const tools = await SELF.fetch(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${access_token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2025-11-25",
				Host: new URL(ORIGIN).host,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		expect(tools.status).toBe(200);
		const text = await tools.text();
		const payload = text.includes("data:")
			? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5))
			: JSON.parse(text);
		expect(payload.result.tools.map((t: Json) => t.name)).toEqual([...TOOL_NAMES]);
	});
});
