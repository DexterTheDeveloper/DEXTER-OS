import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { handleAuthRequest, page, SCOPE_READ, SCOPES_SUPPORTED, tooManyRequests, type DexterProps } from "./access";
import { BRIDGE_NAME } from "./bridge";
import { cimdAllowed, isAppLabel, isUrlClientId } from "./clients";
import { AUTH_BUDGETS, BRIDGE_BUDGETS, overBudget, TOKEN_BUDGETS, type Budget } from "./ratelimit";
import { buildServer } from "./server";
import { base64UrlDecode, sameEmail } from "./util";

export { Bridge } from "./bridge";
export { AuthLimiter } from "./ratelimit";

/**
 * DEXTER MCP front door: a thin authenticated relay to the Mac DEXTER. No model, no memory.
 * - /mcp: stateless MCP endpoint behind OAuth (2026-07-28 clients and 2025-era clients).
 * - /bridge: the Mac's outbound WebSocket, held by the Bridge Durable Object.
 * - /authorize, /callback: consent page (passphrase, or Cloudflare Access).
 * - /token (also revocation), /register, /.well-known/*: served by the OAuth provider.
 * Everything answers on https://mcp.iiiglobe.com only.
 */

export const CANONICAL_ORIGIN = "https://mcp.iiiglobe.com";
/** The one audience every token is bound to (RFC 8707). */
export const RESOURCE = `${CANONICAL_ORIGIN}/mcp`;

const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days from sign-in...
const REFRESH_TOKEN_IDLE_TTL = 30 * 24 * 60 * 60; // ...extended by each use; 30 idle days ends it

export const mcpApiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const props = (ctx as ExecutionContext & { props?: Partial<DexterProps> }).props ?? {};
		// Tokens are only issued to the operator; this is the second lock. Once ALLOWED_EMAIL is
		// set, the token must carry that email: one with none (issued by the passphrase page before
		// Access was added) is refused too, so adding Access retires every earlier token.
		const emailOk = !env.ALLOWED_EMAIL || sameEmail(props.email, env.ALLOWED_EMAIL);
		if (props.operator !== true || !emailOk || !isAppLabel(props.app) || typeof props.clientId !== "string") {
			return Response.json({ error: "forbidden" }, { status: 403 });
		}
		const caller = { app: props.app, clientId: props.clientId };
		const handler = createMcpHandler(() => buildServer(env, caller), { route: "/mcp" });
		return handler(request, env, ctx);
	},
};

/**
 * New app connections are accepted only while ALLOW_CLIENT_REGISTRATION is exactly "true" (any
 * case). Unset is CLOSED, and so is every other value: "false", "no", "0", "", a stray space, a
 * typo. String() so a JSON var (true, 0) is read as the text it spells instead of throwing.
 */
export function registrationAllowed(env: Env): boolean {
	const value = env.ALLOW_CLIENT_REGISTRATION;
	return value !== undefined && value !== null && String(value).toLowerCase() === "true";
}

// Two providers at most: with and without the registration endpoint. CIMD stays enabled in both
// so apps already connected by a metadata URL keep refreshing; NEW sign-ins by URL are gated in
// front of the provider (cimdGate), following the same flag.
const providers = new Map<boolean, OAuthProvider<Env>>();

function providerFor(registration: boolean): OAuthProvider<Env> {
	let provider = providers.get(registration);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: mcpApiHandler,
			defaultHandler: { fetch: handleAuthRequest },
			// Absolute, so the issuer (and the `iss` on every authorization response, RFC 9207) is
			// always https://mcp.iiiglobe.com, whatever Host a request arrived with.
			authorizeEndpoint: `${CANONICAL_ORIGIN}/authorize`,
			tokenEndpoint: `${CANONICAL_ORIGIN}/token`,
			...(registration ? { clientRegistrationEndpoint: `${CANONICAL_ORIGIN}/register` } : {}),
			clientIdMetadataDocumentEnabled: true,
			resourceMetadata: { resource: RESOURCE, resource_name: "DEXTER" },
			requiredScopes: [SCOPE_READ],
			scopesSupported: SCOPES_SUPPORTED,
			accessTokenTTL: ACCESS_TOKEN_TTL,
			refreshTokenTTL: REFRESH_TOKEN_TTL,
			refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL,
		});
		providers.set(registration, provider);
	}
	return provider;
}

function jsonError(status: number, error: string, description: string): Response {
	return Response.json({ error, error_description: description }, { status, headers: { "Cache-Control": "no-store" } });
}

/** The client ids a /token request names: form field, Basic auth user, client assertion iss/sub. */
async function tokenClientIds(request: Request): Promise<string[]> {
	const ids: string[] = [];
	const auth = request.headers.get("Authorization") ?? "";
	if (/^basic /i.test(auth)) {
		try {
			const user = atob(auth.slice(6).trim()).split(":")[0] ?? "";
			ids.push(decodeURIComponent(user.replace(/\+/g, " ")));
		} catch {
			// malformed: the provider will refuse it
		}
	}
	try {
		const form = await request.clone().formData();
		const clientId = form.get("client_id");
		if (typeof clientId === "string") ids.push(clientId);
		const assertion = form.get("client_assertion");
		if (typeof assertion === "string") {
			const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(assertion.split(".")[1] ?? ""))) as Record<string, unknown>;
			for (const claim of [claims.iss, claims.sub]) if (typeof claim === "string") ids.push(claim);
		}
	} catch {
		// not a form, or an unreadable assertion: nothing URL-shaped to fetch, the provider decides
	}
	return ids;
}

/**
 * Client ID Metadata Documents: fetched only over https from an allowlisted host (claude.ai,
 * chatgpt.com), and new sign-ins by URL only while registration is open. The OAuth library
 * itself caps the fetch at 5 KB and 10 seconds and refuses non-public addresses
 * (global_fetch_strictly_public). Returns a refusal, or null to go ahead.
 */
async function cimdGate(request: Request, url: URL, env: Env): Promise<Response | null> {
	if (url.pathname === "/authorize" && request.method === "GET") {
		const clientId = url.searchParams.get("client_id");
		if (!isUrlClientId(clientId)) return null;
		if (!cimdAllowed(clientId!)) {
			return page("App not recognised", `<div class="card"><p class="warn">DEXTER only accepts app metadata from claude.ai and chatgpt.com.</p></div>`, 400);
		}
		if (!registrationAllowed(env)) {
			return page(
				"Not accepting new apps",
				`<div class="card"><p class="warn">DEXTER isn't accepting new app connections right now. Apps already connected keep working.</p></div>`,
				403,
			);
		}
		return null;
	}
	if (url.pathname === "/token" && request.method === "POST") {
		for (const id of await tokenClientIds(request)) {
			if (isUrlClientId(id) && !cimdAllowed(id)) return jsonError(401, "invalid_client", "Client not accepted.");
		}
	}
	return null;
}

function budgetsFor(request: Request, url: URL): Budget[] | null {
	if (url.pathname === "/authorize" && (request.method === "GET" || request.method === "POST")) return AUTH_BUDGETS;
	if (url.pathname === "/register" && request.method === "POST") return AUTH_BUDGETS;
	if (url.pathname === "/token" && request.method === "POST") return TOKEN_BUDGETS;
	if (url.pathname === "/bridge") return BRIDGE_BUDGETS;
	return null;
}

/** With registration closed, the metadata stops advertising URL client ids as well as /register. */
async function adjustMetadata(response: Response, registration: boolean): Promise<Response> {
	if (registration || !response.ok) return response;
	const body = (await response.json()) as Record<string, unknown>;
	body.client_id_metadata_document_supported = false;
	const headers = new Headers(response.headers);
	headers.delete("Content-Length");
	return new Response(JSON.stringify(body), { status: response.status, headers });
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		// One hostname. The issuer, the audience and the consent cookies all assume it.
		if (url.origin !== CANONICAL_ORIGIN) {
			return new Response(`DEXTER answers on ${CANONICAL_ORIGIN} only.`, { status: 421 });
		}

		// Metered before anything touches KV, a Durable Object's socket list or a CIMD fetch.
		const budgets = budgetsFor(request, url);
		if (budgets) {
			const wait = await overBudget(env, request, budgets);
			if (wait !== null) return tooManyRequests(request, wait);
		}

		if (url.pathname === "/bridge") {
			return env.BRIDGE.get(env.BRIDGE.idFromName(BRIDGE_NAME)).fetch(request);
		}

		const refused = await cimdGate(request, url, env);
		if (refused) return refused;

		const registration = registrationAllowed(env);
		const response = await providerFor(registration).fetch(request, env, ctx);
		if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
			return adjustMetadata(response, registration);
		}
		return response;
	},
} satisfies ExportedHandler<Env>;
