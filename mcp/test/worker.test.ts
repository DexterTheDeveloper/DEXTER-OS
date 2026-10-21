/// <reference types="@cloudflare/vitest-plugin/types" />
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAuthRequest } from "../src/access";
import { classifyClient } from "../src/clients";
import { mcpApiHandler, RESOURCE } from "../src/index";
import { AUTH_BUDGETS } from "../src/ratelimit";
import { TOOL_NAMES } from "../src/server";
import {
	awayFromWindowEdge,
	callTool,
	connectMac,
	ORIGIN,
	parseMcp,
	randomIp,
	resetBridge,
	rpc,
	serve,
	viaWorker,
	type Json,
} from "./helpers";

const host = new URL(ORIGIN).host;
const OPEN = { ALLOW_CLIENT_REGISTRATION: "true" };
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

/** A fresh client IP per test: the rate limiter and the lock-out counter are both keyed by it. */
let ip = "";
beforeEach(() => {
	ip = randomIp();
});

// The shared sign-in budget (60 a minute across all IPs) would trip over this suite's own traffic.
// Tests share the Worker's module instance, so it is raised here and lowered again by the one test
// that checks it.
const GLOBAL_AUTH = AUTH_BUDGETS.find((b) => !b.perIp)!;
const GLOBAL_AUTH_LIMIT = GLOBAL_AUTH.limit;
beforeAll(() => {
	GLOBAL_AUTH.limit = 100_000;
});

let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = undefined;
});

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

async function registerClient(redirect = CLAUDE_REDIRECT, name = "Claude"): Promise<string> {
	const registration = await viaWorker(
		new Request(`${ORIGIN}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
			body: JSON.stringify({
				client_name: name,
				redirect_uris: [redirect],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
			}),
		}),
		OPEN,
	);
	expect(registration.status).toBeLessThan(300);
	return ((await registration.json()) as Json).client_id;
}

function authorizeUrl(params: Record<string, string>): URL {
	const url = new URL(`${ORIGIN}/authorize`);
	url.search = new URLSearchParams({ response_type: "code", code_challenge_method: "S256", state: "state-123", resource: RESOURCE, ...params }).toString();
	return url;
}

async function startConsent(opts: { client_id?: string; redirect?: string; scope?: string; custom?: Partial<Env> } = {}) {
	const redirect = opts.redirect ?? CLAUDE_REDIRECT;
	const client_id = opts.client_id ?? (await registerClient(redirect));
	const { verifier, challenge } = await pkce();
	const url = authorizeUrl({ client_id, redirect_uri: redirect, code_challenge: challenge, ...(opts.scope ? { scope: opts.scope } : {}) });
	const consent = await viaWorker(new Request(url, { redirect: "manual", headers: { "CF-Connecting-IP": ip } }), opts.custom ?? {});
	const html = await consent.text();
	expect(consent.status, html.slice(0, 400)).toBe(200);
	const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
	expect(handle).toBeTruthy();
	return { client_id, verifier, redirect, handle: handle!, cookies: cookieHeader(consent), html };
}

function approveRequest(handle: string, cookies: string, passphrase: string, decision = "approve") {
	return new Request(`${ORIGIN}/authorize`, {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies, "CF-Connecting-IP": ip },
		body: new URLSearchParams({ handle, decision, passphrase }).toString(),
	});
}

const submit = (handle: string, cookies: string, passphrase: string, decision = "approve") =>
	SELF.fetch(approveRequest(handle, cookies, passphrase, decision));

function token(body: Record<string, string>, custom: Partial<Env> = {}) {
	return viaWorker(
		new Request(`${ORIGIN}/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
			body: new URLSearchParams(body).toString(),
		}),
		custom,
	);
}

/** Runs a full passphrase sign-in and returns the token response. */
async function signIn(opts: { client_id?: string; redirect?: string; scope?: string; custom?: Partial<Env> } = {}) {
	const consent = await startConsent(opts);
	const approved = await submit(consent.handle, consent.cookies, "correct horse battery staple");
	expect(approved.status).toBe(302);
	const location = new URL(approved.headers.get("Location")!);
	const code = location.searchParams.get("code")!;
	const response = await token(
		{ grant_type: "authorization_code", code, redirect_uri: consent.redirect, client_id: consent.client_id, code_verifier: consent.verifier, resource: RESOURCE },
		opts.custom,
	);
	expect(response.status).toBe(200);
	return { client_id: consent.client_id, location, tokens: (await response.json()) as Json };
}

function mcpWithToken(accessToken: string, method = "tools/list") {
	return SELF.fetch(`${ORIGIN}/mcp`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-11-25",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
	});
}

describe("one hostname", () => {
	it("refuses every other origin, workers.dev included", async () => {
		for (const url of ["https://dexter-mcp.example.workers.dev/", "https://dexter-mcp.example.workers.dev/mcp", "http://mcp.iiiglobe.com/authorize"]) {
			expect((await SELF.fetch(url)).status, url).toBe(421);
		}
	});
});

describe("OAuth surface", () => {
	it("refuses /mcp without a token and points at resource metadata", async () => {
		const response = await SELF.fetch(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate") ?? "").toContain("resource_metadata");
	});

	it("publishes protected resource metadata bound to exactly https://mcp.iiiglobe.com/mcp", async () => {
		const body = (await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json()) as Json;
		expect(body.resource).toBe("https://mcp.iiiglobe.com/mcp");
		expect(body.authorization_servers).toEqual(["https://mcp.iiiglobe.com"]);
	});

	it("publishes server metadata with iss support, revocation and S256", async () => {
		const body = (await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as Json;
		expect(body.issuer).toBe("https://mcp.iiiglobe.com");
		expect(body.authorization_response_iss_parameter_supported).toBe(true);
		expect(body.revocation_endpoint).toBe("https://mcp.iiiglobe.com/token");
		expect(body.code_challenge_methods_supported).toContain("S256");
		expect(body.scopes_supported).toEqual(["dexter.read", "offline_access"]);
	});

	it("shows which secrets are missing instead of failing silently, BRIDGE_SECRET included", async () => {
		const ctx = createExecutionContext();
		const partial = { ...env, BRIDGE_SECRET: undefined, DEXTER_PASSPHRASE: "short" } as Env;
		const html = await (await handleAuthRequest(new Request(`${ORIGIN}/`), partial, ctx)).text();
		expect(html).toContain("BRIDGE_SECRET");
		expect(html).not.toContain("ANTHROPIC_API_KEY");
		expect(html).toContain("DEXTER_PASSPHRASE (needs at least 12 characters)");
		expect(html).not.toContain("short");

		const badLength = { ...env, BRIDGE_SECRET: "c2hvcnQ=" } as Env;
		const html2 = await (await handleAuthRequest(new Request(`${ORIGIN}/`), badLength, ctx)).text();
		expect(html2).toContain("BRIDGE_SECRET (must be the 32-byte base64 value");
		expect(html2).not.toContain("c2hvcnQ=");
	});

	it("blocks sign-in while BRIDGE_SECRET is missing", async () => {
		const response = await viaWorker(new Request(`${ORIGIN}/authorize`, { headers: { "CF-Connecting-IP": ip } }), { BRIDGE_SECRET: undefined } as Partial<Env>);
		expect(response.status).toBe(503);
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

	it("rejects tokens that weren't issued to the operator, or carry no app label", async () => {
		expect((await rpc("tools/list", {}, { operator: false })).status).toBe(403);
		expect((await rpc("tools/list", {}, { app: undefined })).status).toBe(403);
		expect((await rpc("tools/list", {}, { app: "alexa" })).status).toBe(403);
		expect((await rpc("tools/list", {}, { clientId: undefined })).status).toBe(403);
	});

	it("rejects a token with no email once ALLOWED_EMAIL is set", async () => {
		const allowed = { ALLOWED_EMAIL: "operator@example.com" };
		expect((await rpc("tools/list", {}, { email: "" }, allowed)).status).toBe(403);
		expect((await rpc("tools/list", {}, { email: undefined }, allowed)).status).toBe(403);
		const matching = await rpc("tools/list", {}, { email: "Operator@Example.com" }, allowed);
		expect(matching.result?.tools?.map((t: Json) => t.name)).toEqual([...TOOL_NAMES]);
	});
});

describe("registration is closed by default and fails closed", () => {
	const registrationBody = JSON.stringify({ client_name: "Late Comer", redirect_uris: [CLAUDE_REDIRECT] });
	const register = (custom: Partial<Env>) =>
		viaWorker(
			new Request(`${ORIGIN}/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "CF-Connecting-IP": randomIp() },
				body: registrationBody,
			}),
			custom,
		);
	const metadata = async (custom: Partial<Env>) =>
		(await viaWorker(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), custom).then((r) => r.json())) as Json;

	const offValues: [string, string | undefined][] = [
		["unset", undefined],
		...["false", "FALSE", "no", "off", "0", "maybe", "yes", "1", "", " ", " true", "true ", "ttrue"].map((v): [string, string] => [JSON.stringify(v), v]),
	];
	it.each(offValues)("closes registration and CIMD for the value %s", async (_label, value) => {
		const off = { ALLOW_CLIENT_REGISTRATION: value } as Partial<Env>;
		const registration = await register(off);
		expect(registration.status).toBe(403);
		expect(((await registration.json()) as Json).error).toBe("access_denied");
		const advertised = await metadata(off);
		expect(advertised.registration_endpoint).toBeUndefined();
		expect(advertised.client_id_metadata_document_supported).toBe(false);
		expect(advertised.token_endpoint).toBe(`${ORIGIN}/token`);
	});

	it.each([["true"], ["TRUE"], ["True"]])("opens registration and CIMD only for %s", async (value) => {
		const on = { ALLOW_CLIENT_REGISTRATION: value };
		const registration = await register(on);
		expect(registration.status).toBeLessThan(300);
		expect(((await registration.json()) as Json).client_id).toBeTruthy();
		const advertised = await metadata(on);
		expect(advertised.registration_endpoint).toBe(`${ORIGIN}/register`);
		expect(advertised.client_id_metadata_document_supported).toBe(true);
	});

	it("does not throw on a JSON var: false closes it, true opens it", async () => {
		const asVar = (value: unknown) => ({ ALLOW_CLIENT_REGISTRATION: value }) as unknown as Partial<Env>;
		expect((await register(asVar(false))).status).toBe(403);
		expect((await register(asVar(true))).status).toBeLessThan(300);
	});

	it("an app registered while open keeps signing in after it closes", async () => {
		const client_id = await registerClient();
		const consent = await startConsent({ client_id }); // registration closed (unset) here
		expect(consent.html).toContain("Claude");
	});
});

describe("tools and per-app policy", () => {
	beforeEach(async () => {
		await resetBridge();
	});

	it("Claude and Claude Code see all four tools, ChatGPT sees three (no memory search)", async () => {
		const names = async (app: string) => ((await rpc("tools/list", {}, { app })).result?.tools ?? []).map((t: Json) => t.name);
		expect(await names("claude")).toEqual(["dexter_ask", "dexter_whats_live", "dexter_queue", "dexter_memory_search"]);
		expect(await names("claude_code")).toEqual(["dexter_ask", "dexter_whats_live", "dexter_queue", "dexter_memory_search"]);
		expect(await names("chatgpt")).toEqual(["dexter_ask", "dexter_whats_live", "dexter_queue"]);
	});

	it("every tool is marked read-only", async () => {
		const tools = (await rpc("tools/list")).result.tools as Json[];
		expect(tools).toHaveLength(4);
		for (const tool of tools) {
			expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
			expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
		}
	});

	it("ChatGPT can't call dexter_memory_search even by name, and nothing reaches the Mac", async () => {
		const mac = await connectMac();
		const seen = serve(mac.sock, () => ({ text: "should never be asked", is_error: false }));
		const result = await callTool("dexter_memory_search", { query: "anything" }, { app: "chatgpt" });
		expect(result.text).not.toContain("should never be asked");
		expect(result.isError || result.raw.error).toBeTruthy();
		expect(seen.requests).toHaveLength(0);
	});

	it("relays a tool call with the caller's app label and client id, and returns DEXTER's answer", async () => {
		const mac = await connectMac();
		const seen = serve(mac.sock, (req) => ({ text: `answer to ${JSON.parse(req.body).args.question}`, is_error: false }));
		const result = await callTool("dexter_ask", { question: "what's live?" }, { app: "chatgpt", clientId: "https://chatgpt.com/x" });
		expect(result).toMatchObject({ text: "answer to what's live?", isError: false });
		expect(seen.requests).toHaveLength(1);
		expect(seen.requests[0].tool).toBe("dexter_ask");
		expect(JSON.parse(seen.requests[0].body)).toEqual({ args: { question: "what's live?" }, app: "chatgpt", client_id: "https://chatgpt.com/x" });
	});

	it("validates arguments before anything is relayed", async () => {
		const mac = await connectMac();
		const seen = serve(mac.sock, () => ({ text: "x", is_error: false }));
		const empty = await callTool("dexter_ask", { question: "   " });
		const huge = await callTool("dexter_memory_search", { query: "q".repeat(501) });
		for (const r of [empty, huge]) expect(r.isError || r.raw.error).toBeTruthy();
		expect(seen.requests).toHaveLength(0);
	});
});

describe("client labels come from the client id / redirect URI, not the name", () => {
	it.each([
		["https://claude.ai/oauth/mcp-client", CLAUDE_REDIRECT, undefined, "claude"],
		["https://claude.ai/oauth/claude-code", "http://localhost:53682/callback", undefined, "claude_code"],
		["https://chatgpt.com/oauth/client.json", CHATGPT_REDIRECT, undefined, "chatgpt"],
		["dcr-client", CLAUDE_REDIRECT, "ChatGPT", "claude"],
		["dcr-client", CHATGPT_REDIRECT, "Claude", "chatgpt"],
		["dcr-client", "http://127.0.0.1:9000/cb", "Claude Code", "claude_code"],
		["dcr-client", "http://127.0.0.1:9000/cb", "Codex", "chatgpt"],
		["dcr-client", "https://evil.example/cb", "Claude", null],
		["https://evil.example/meta", CLAUDE_REDIRECT, "Claude", null],
		["https://claude.ai.evil.example/meta", CLAUDE_REDIRECT, undefined, null],
		["https://claude.ai:8443/meta", CLAUDE_REDIRECT, undefined, null],
		["https://claude.ai/meta", "https://evil.example/cb", undefined, null],
	])("%s + %s (%s) -> %s", (clientId, redirect, name, expected) => {
		expect(classifyClient(clientId, redirect, name)).toBe(expected);
	});

	it("an unrecognised app is refused at the consent page", async () => {
		const client_id = await registerClient("https://evil.example.com/cb", "Claude");
		const { verifier, challenge } = await pkce();
		void verifier;
		const response = await SELF.fetch(authorizeUrl({ client_id, redirect_uri: "https://evil.example.com/cb", code_challenge: challenge }), {
			redirect: "manual",
			headers: { "CF-Connecting-IP": ip },
		});
		expect(response.status).toBe(400);
		const html = await response.text();
		expect(html).toContain("isn");
		expect(html).not.toContain('name="handle"');
	});
});

describe("protocol eras", () => {
	it("a 2025-era client can initialize, then list tools, without Mcp-Method or Mcp-Name", async () => {
		const init = await rpc(
			"initialize",
			{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1.0.0" } },
			{},
			{},
			{ "MCP-Protocol-Version": undefined as unknown as string },
		);
		expect(init.error, JSON.stringify(init.error)).toBeUndefined();
		expect(init.result?.serverInfo?.name).toBe("dexter");
		expect(typeof init.result?.protocolVersion).toBe("string");
		const tools = await rpc("tools/list", {}, {}, {}, { "MCP-Protocol-Version": "2025-06-18" });
		expect(tools.result?.tools?.map((t: Json) => t.name)).toEqual([...TOOL_NAMES]);
	});

	it("serves 2026-07-28 clients too", async () => {
		const ctx = createExecutionContext() as ExecutionContext & { props?: Json };
		ctx.props = { operator: true, email: "", name: "Operator", sub: "operator", client: "Claude", app: "claude", clientId: "c" };
		const request = new Request(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Method": "tools/list" },
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
		const payload = await parseMcp(response);
		expect(payload.error, JSON.stringify(payload.error)).toBeUndefined();
		expect(payload.result.tools.map((t: Json) => t.name)).toEqual([...TOOL_NAMES]);
	});
});

describe("end-to-end OAuth with the passphrase", () => {
	it("the consent page names the app, its redirect host and that access is read-only", async () => {
		const { html } = await startConsent();
		expect(html).toContain("<strong>Claude</strong>");
		expect(html).toContain("<strong>claude.ai</strong>");
		expect(html).toContain("read-only");
		expect(html).toContain("search its memory");
		const chatgpt = await startConsent({ redirect: CHATGPT_REDIRECT });
		expect(chatgpt.html).toContain("<strong>chatgpt.com</strong>");
		expect(chatgpt.html).not.toContain("search its memory");
	});

	it("issues a token (iss on the redirect, 1 hour, refresh token) that opens /mcp with the right tools", async () => {
		const { location, tokens } = await signIn();
		expect(location.origin + location.pathname).toBe(CLAUDE_REDIRECT);
		expect(location.searchParams.get("state")).toBe("state-123");
		expect(location.searchParams.get("iss")).toBe("https://mcp.iiiglobe.com");
		expect(tokens.expires_in).toBeLessThanOrEqual(3600);
		expect(tokens.refresh_token).toBeTruthy();
		expect(tokens.scope).toBe("dexter.read");

		const response = await mcpWithToken(tokens.access_token);
		expect(response.status).toBe(200);
		const payload = await parseMcp(response);
		expect(payload.result.tools.map((t: Json) => t.name)).toEqual([...TOOL_NAMES]);
	});

	it("a ChatGPT sign-in gets offline_access when it asks, and its token lists three tools", async () => {
		const { tokens } = await signIn({ redirect: CHATGPT_REDIRECT, scope: "offline_access" });
		expect(tokens.scope.split(" ").sort()).toEqual(["dexter.read", "offline_access"]);
		const payload = await parseMcp(await mcpWithToken(tokens.access_token));
		expect(payload.result.tools.map((t: Json) => t.name)).toEqual(["dexter_ask", "dexter_whats_live", "dexter_queue"]);
	});

	it("a denied consent also carries iss", async () => {
		const consent = await startConsent();
		const denied = await submit(consent.handle, consent.cookies, "", "deny");
		expect(denied.status).toBe(302);
		const location = new URL(denied.headers.get("Location")!);
		expect(location.searchParams.get("error")).toBe("access_denied");
		expect(location.searchParams.get("iss")).toBe("https://mcp.iiiglobe.com");
	});

	it("refresh tokens rotate: each refresh returns a new one, and a superseded one stops working", async () => {
		const { client_id, tokens } = await signIn();
		const first = tokens.refresh_token as string;
		const r1 = await token({ grant_type: "refresh_token", refresh_token: first, client_id });
		expect(r1.status).toBe(200);
		const second = ((await r1.json()) as Json).refresh_token as string;
		expect(second).toBeTruthy();
		expect(second).not.toBe(first);
		const r2 = await token({ grant_type: "refresh_token", refresh_token: second, client_id });
		expect(r2.status).toBe(200);
		const third = ((await r2.json()) as Json).refresh_token as string;
		expect(third).not.toBe(second);
		// Two rotations later the first refresh token is dead.
		expect((await token({ grant_type: "refresh_token", refresh_token: first, client_id })).status).toBe(400);
	});

	it("revoking a token closes /mcp to it", async () => {
		const { client_id, tokens } = await signIn();
		expect((await mcpWithToken(tokens.access_token)).status).toBe(200);
		const revoked = await token({ token: tokens.access_token, token_type_hint: "access_token", client_id });
		expect(revoked.status).toBe(200);
		expect((await mcpWithToken(tokens.access_token)).status).toBe(401);
	});

	it("binds the audience: an authorization request for another resource gets no consent page", async () => {
		const client_id = await registerClient();
		const { challenge } = await pkce();
		for (const resource of ["https://evil.example/mcp", "https://mcp.iiiglobe.com/other", "https://mcp.iiiglobe.com/mcp/"]) {
			const response = await SELF.fetch(authorizeUrl({ client_id, redirect_uri: CLAUDE_REDIRECT, code_challenge: challenge, resource }), {
				redirect: "manual",
				headers: { "CF-Connecting-IP": randomIp() },
			});
			const body = await response.text();
			expect(body, resource).not.toContain('name="handle"');
			if (response.status === 302) expect(new URL(response.headers.get("Location")!).searchParams.get("error"), resource).toBe("invalid_target");
			else expect(response.status, resource).toBe(400);
		}
	});

	it("binds the audience: a code can't be exchanged for a token to another resource", async () => {
		const consent = await startConsent();
		const approved = await submit(consent.handle, consent.cookies, "correct horse battery staple");
		const code = new URL(approved.headers.get("Location")!).searchParams.get("code")!;
		const response = await token({
			grant_type: "authorization_code",
			code,
			redirect_uri: consent.redirect,
			client_id: consent.client_id,
			code_verifier: consent.verifier,
			resource: "https://evil.example/mcp",
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as Json).error).toBe("invalid_target");
	});

	it("redirect URIs must match exactly", async () => {
		const client_id = await registerClient();
		const { challenge } = await pkce();
		for (const redirect_uri of [`${CLAUDE_REDIRECT}/`, `${CLAUDE_REDIRECT}?x=1`, "https://claude.ai/api/mcp/other"]) {
			const response = await SELF.fetch(authorizeUrl({ client_id, redirect_uri, code_challenge: challenge }), {
				redirect: "manual",
				headers: { "CF-Connecting-IP": randomIp() },
			});
			expect(response.status, redirect_uri).toBe(400);
			expect(response.headers.get("Location"), redirect_uri).toBeNull();
		}
	});

	it("refuses a wrong passphrase and offers a fresh consent form to retry on", async () => {
		const { handle, cookies } = await startConsent();
		const wrong = await submit(handle, cookies, "not the passphrase");
		expect(wrong.status).toBe(401);
		const html = await wrong.text();
		expect(html).toContain("That passphrase didn");
		const freshHandle = html.match(/name="handle" value="([^"]+)"/)?.[1];
		expect(freshHandle).toBeTruthy();
		expect(freshHandle).not.toBe(handle);
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

	/** The real OAUTH_KV, except that the named methods throw for keys under `prefix`. */
	function kvFailingOn(prefix: string, methods: ("get" | "put")[]): KVNamespace {
		const real = env.OAUTH_KV as any;
		const wrap = (method: "get" | "put") => (k: string, ...rest: unknown[]) => {
			if (methods.includes(method) && k.startsWith(prefix)) return Promise.reject(new Error("KV unavailable"));
			return real[method](k, ...rest);
		};
		return {
			get: wrap("get"),
			put: wrap("put"),
			delete: (k: string) => real.delete(k),
			list: (options?: unknown) => real.list(options),
			getWithMetadata: (...args: unknown[]) => real.getWithMetadata(...args),
		} as unknown as KVNamespace;
	}

	it("issues no token while the lock-out counter can't be read, even with the right passphrase", async () => {
		const { handle, cookies } = await startConsent();
		const response = await viaWorker(approveRequest(handle, cookies, "correct horse battery staple"), { OAUTH_KV: kvFailingOn("dexter:pass-fail:", ["get"]) });
		expect(response.status).toBe(500);
		expect(response.headers.get("Location")).toBeNull();
		expect((await submit(handle, cookies, "correct horse battery staple")).status).toBe(302);
	});

	it("refuses instead of forgiving a wrong passphrase when the failure can't be recorded", async () => {
		const { handle, cookies } = await startConsent();
		const response = await viaWorker(approveRequest(handle, cookies, "not the passphrase"), { OAUTH_KV: kvFailingOn("dexter:pass-fail:", ["put"]) });
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain('name="handle"');
	});

	it("locks an IP out after five wrong passphrases", async () => {
		await awayFromWindowEdge();
		let { handle, cookies } = await startConsent();
		for (let i = 0; i < 5; i++) {
			const wrong = await submit(handle, cookies, `wrong ${i}`);
			expect(wrong.status, `wrong passphrase ${i + 1}`).toBe(401);
			handle = (await wrong.text()).match(/name="handle" value="([^"]+)"/)![1];
			cookies = cookieHeader(wrong);
		}
		const locked = await submit(handle, cookies, "correct horse battery staple");
		expect(locked.status).toBe(429);
		expect(locked.headers.get("Retry-After")).toBe("900");
	});
});

describe("Client ID Metadata Documents", () => {
	function cimdDoc(url: string, redirect = CLAUDE_REDIRECT, extra: Json = {}) {
		return {
			client_id: url,
			client_name: "Claude",
			redirect_uris: [redirect],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			...extra,
		};
	}

	function mockFetch(handler: (url: string) => Response | Promise<Response>) {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
			handler(new Request(input, init).url),
		);
		return fetchSpy;
	}

	const cimdUrl = (hostname = "claude.ai") => `https://${hostname}/oauth/test-${crypto.randomUUID()}.json`;

	async function authorizeWith(client_id: string, custom: Partial<Env>, redirect = CLAUDE_REDIRECT) {
		const { challenge } = await pkce();
		return viaWorker(
			new Request(authorizeUrl({ client_id, redirect_uri: redirect, code_challenge: challenge }), { redirect: "manual", headers: { "CF-Connecting-IP": randomIp() } }),
			custom,
		);
	}

	it("closed registration refuses a new sign-in by metadata URL without fetching it", async () => {
		const spy = mockFetch(() => new Response("{}"));
		const response = await authorizeWith(cimdUrl(), {});
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("accepting new app connections");
		expect(spy).not.toHaveBeenCalled();
	});

	it("never fetches metadata from a host off the allowlist, open or closed", async () => {
		const spy = mockFetch(() => new Response("{}"));
		for (const id of [cimdUrl("evil.example"), cimdUrl("claude.ai.evil.example"), "https://claude.ai:8443/oauth/x.json"]) {
			expect((await authorizeWith(id, OPEN)).status, id).toBe(400);
		}
		const tokenAttempt = await token({ grant_type: "authorization_code", code: "x", client_id: cimdUrl("evil.example"), code_verifier: "x", redirect_uri: CLAUDE_REDIRECT });
		expect(tokenAttempt.status).toBe(401);
		const basic = await viaWorker(
			new Request(`${ORIGIN}/token`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Authorization: `Basic ${btoa(`${encodeURIComponent(cimdUrl("evil.example"))}:x`)}`,
					"CF-Connecting-IP": ip,
				},
				body: "grant_type=refresh_token&refresh_token=x",
			}),
		);
		expect(basic.status).toBe(401);
		expect(spy).not.toHaveBeenCalled();
	});

	it("with registration open, an allowlisted document is fetched and the consent page shows", async () => {
		const url = cimdUrl();
		const spy = mockFetch((u) => (u === url ? Response.json(cimdDoc(url)) : new Response("unexpected", { status: 599 })));
		const response = await authorizeWith(url, OPEN);
		const html = await response.text();
		expect(response.status, html.slice(0, 300)).toBe(200);
		expect(html).toContain("claude.ai");
		expect(spy).toHaveBeenCalled();
	});

	it("refuses a document over 5 KB (the library's limit)", async () => {
		const url = cimdUrl();
		mockFetch(() => Response.json(cimdDoc(url, CLAUDE_REDIRECT, { padding: "x".repeat(6 * 1024) })));
		const response = await authorizeWith(url, OPEN);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("could not be verified");
	});

	it("refuses an http:// metadata URL outright (only https is a metadata URL)", async () => {
		const spy = mockFetch(() => new Response("{}"));
		const response = await authorizeWith("http://claude.ai/oauth/x.json", OPEN);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(spy).not.toHaveBeenCalled();
	});

	it("gives up on a document that takes longer than 10 seconds (the library's limit)", { timeout: 20_000 }, async () => {
		const url = cimdUrl();
		mockFetch(
			() =>
				new Promise<Response>(() => {
					// never answers
				}),
		);
		// The library aborts via its own signal; the mock ignores it, so emulate a server that honours it.
		fetchSpy!.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
			const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
			return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
		});
		const started = Date.now();
		const response = await authorizeWith(url, OPEN);
		const elapsed = Date.now() - started;
		expect(response.status).toBe(400);
		expect(elapsed).toBeGreaterThanOrEqual(9_500);
		expect(elapsed).toBeLessThan(15_000);
	});

	it("an app connected by metadata URL keeps refreshing after registration closes", async () => {
		const url = cimdUrl();
		mockFetch((u) => (u === url ? Response.json(cimdDoc(url)) : new Response("unexpected", { status: 599 })));
		const { tokens } = await signIn({ client_id: url, custom: OPEN });
		// Now closed (unset): a new sign-in by the same URL is refused...
		expect((await authorizeWith(url, {})).status).toBe(403);
		// ...but the existing grant still refreshes.
		const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: url });
		expect(refreshed.status).toBe(200);
	});
});

describe("rate limits (Durable Object counters)", () => {
	const denying = {
		idFromName: () => ({}),
		get: () => ({ hit: async () => ({ ok: false, retryAfter: 42 }) }),
	} as unknown as Env["AUTH_LIMITER"];
	const broken = {
		idFromName: () => {
			throw new Error("binding down");
		},
	} as unknown as Env["AUTH_LIMITER"];

	it("the 11th GET /authorize from one IP in a minute is refused", async () => {
		await awayFromWindowEdge();
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) statuses.push((await SELF.fetch(`${ORIGIN}/authorize`, { redirect: "manual", headers: { "CF-Connecting-IP": ip } })).status);
		expect(statuses.slice(0, 10).every((s) => s !== 429), statuses.join(",")).toBe(true);
		expect(statuses[10], statuses.join(",")).toBe(429);
	});

	it("POST /authorize and /register share that budget", async () => {
		await awayFromWindowEdge();
		for (let i = 0; i < 10; i++) await SELF.fetch(`${ORIGIN}/register`, { method: "POST", headers: { "CF-Connecting-IP": ip }, body: "{}" });
		const blocked = await SELF.fetch(`${ORIGIN}/authorize`, { method: "POST", headers: { "CF-Connecting-IP": ip }, body: "" });
		expect(blocked.status).toBe(429);
		expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
	});

	it("the 31st POST /token from one IP in a minute is refused, with a JSON error", async () => {
		await awayFromWindowEdge();
		const statuses: number[] = [];
		for (let i = 0; i < 31; i++) {
			const r = await SELF.fetch(`${ORIGIN}/token`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
				body: "grant_type=refresh_token&refresh_token=nope&client_id=nope",
			});
			statuses.push(r.status);
			if (i === 30) {
				expect(r.headers.get("Content-Type")).toContain("application/json");
				expect(((await r.json()) as Json).error).toBe("temporarily_unavailable");
			}
		}
		expect(statuses.slice(0, 30).every((s) => s !== 429), statuses.join(",")).toBe(true);
		expect(statuses[30]).toBe(429);
	});

	it("the 11th /bridge upgrade from one IP in a minute is refused", async () => {
		await awayFromWindowEdge();
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) {
			const r = await SELF.fetch(`${ORIGIN}/bridge`, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } });
			statuses.push(r.status);
			r.webSocket?.accept();
			r.webSocket?.close();
		}
		expect(statuses.slice(0, 10).every((s) => s === 101), statuses.join(",")).toBe(true);
		expect(statuses[10]).toBe(429);
	});

	it("caps sign-in traffic across all IPs too", async () => {
		await awayFromWindowEdge();
		const original = GLOBAL_AUTH.limit;
		GLOBAL_AUTH.limit = 3;
		GLOBAL_AUTH.bucket = `auth-all-test-${crypto.randomUUID()}`;
		try {
			const statuses: number[] = [];
			for (let i = 0; i < 4; i++) statuses.push((await SELF.fetch(`${ORIGIN}/authorize`, { redirect: "manual", headers: { "CF-Connecting-IP": randomIp() } })).status);
			expect(statuses.slice(0, 3).every((s) => s !== 429), statuses.join(",")).toBe(true);
			expect(statuses[3]).toBe(429);
		} finally {
			GLOBAL_AUTH.limit = original;
			GLOBAL_AUTH.bucket = "auth-all";
		}
		expect(GLOBAL_AUTH_LIMIT).toBe(60);
	});

	it("uses the limiter's Retry-After", async () => {
		const response = await viaWorker(new Request(`${ORIGIN}/authorize`, { headers: { "CF-Connecting-IP": ip } }), { AUTH_LIMITER: denying });
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("42");
	});

	it("fails closed when the limiter itself fails", async () => {
		for (const [method, path] of [["GET", "/authorize"], ["POST", "/authorize"], ["POST", "/register"], ["POST", "/token"], ["GET", "/bridge"]]) {
			const response = await viaWorker(new Request(`${ORIGIN}${path}`, { method, headers: { "CF-Connecting-IP": ip } }), { AUTH_LIMITER: broken });
			expect(response.status, `${method} ${path}`).toBe(429);
		}
	});

	it("does not meter the status page or the metadata", async () => {
		for (const path of ["/", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
			expect((await viaWorker(new Request(`${ORIGIN}${path}`), { AUTH_LIMITER: broken })).status, path).toBe(200);
		}
	});
});
