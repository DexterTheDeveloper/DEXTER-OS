import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { authRateLimit, handleAuthRequest, type DexterProps } from "./access";
import { deliverDueReminders } from "./reminders";
import { buildServer } from "./server";
import { sameEmail } from "./util";

/**
 * DEXTER MCP server (DEX-001).
 * - /mcp: stateless MCP endpoint behind OAuth (2026-07-28 clients and 2025-era clients like Alexa+).
 * - /authorize, /callback: consent page + Cloudflare Access sign-in.
 * - /token, /register, /.well-known/*: served by the OAuth provider.
 * - Cron (every minute): delivers due reminders through ntfy.
 */

export const mcpApiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const props = (ctx as ExecutionContext & { props?: Partial<DexterProps> }).props ?? {};
		// Tokens are only issued to the operator; this is the second lock. Once ALLOWED_EMAIL is
		// set, the token must carry that email: one with none (issued by the passphrase page before
		// Access was added) is refused too, so adding Access retires every earlier token.
		const emailOk = !env.ALLOWED_EMAIL || sameEmail(props.email, env.ALLOWED_EMAIL);
		if (props.operator !== true || !emailOk) {
			return Response.json({ error: "forbidden" }, { status: 403 });
		}
		const caller = { email: props.email ?? "", source: props.client ?? "unknown client" };
		const handler = createMcpHandler(() => buildServer(env, caller), { route: "/mcp" });
		return handler(request, env, ctx);
	},
};

/** Dynamic client registration stays on unless ALLOW_CLIENT_REGISTRATION is "false" (see env.d.ts). */
export function registrationAllowed(env: Env): boolean {
	return (env.ALLOW_CLIENT_REGISTRATION ?? "true").trim().toLowerCase() !== "false";
}

// The protected-resource URL has to be absolute, and the workers.dev subdomain isn't known at build
// time, so one provider is built per origin the Worker is reached on (and per registration setting).
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string, registration: boolean): OAuthProvider<Env> {
	const key = `${origin} ${registration ? "with" : "without"} registration`;
	let provider = providers.get(key);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: mcpApiHandler,
			defaultHandler: { fetch: handleAuthRequest },
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			// Left out entirely when registration is off: the provider then neither serves nor
			// advertises /register, and the request falls through to handleAuthRequest's 403.
			...(registration ? { clientRegistrationEndpoint: "/register" } : {}),
			clientIdMetadataDocumentEnabled: true,
			resourceMetadata: { resource: `${origin}/mcp`, resource_name: "DEXTER" },
		});
		if (providers.size < 8) providers.set(key, provider);
	}
	return provider;
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		// What writes to KV for anyone who asks is metered per IP first, from one shared budget:
		// the consent page (GET /authorize opens a consent transaction), its submit and registration.
		const metered =
			(request.method === "GET" && url.pathname === "/authorize") ||
			(request.method === "POST" && (url.pathname === "/authorize" || url.pathname === "/register"));
		if (metered) {
			const limited = await authRateLimit(env, request);
			if (limited) return limited;
		}
		return providerFor(url.origin, registrationAllowed(env)).fetch(request, env, ctx);
	},
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(deliverDueReminders(env));
	},
} satisfies ExportedHandler<Env>;
