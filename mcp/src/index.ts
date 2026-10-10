import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { handleAuthRequest, type DexterProps } from "./access";
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
		// Tokens are only issued to the operator; this is the second lock. In Access mode the
		// signed-in email must still match ALLOWED_EMAIL.
		const emailOk = !env.ALLOWED_EMAIL || !props.email || sameEmail(props.email, env.ALLOWED_EMAIL);
		if (props.operator !== true || !emailOk) {
			return Response.json({ error: "forbidden" }, { status: 403 });
		}
		const caller = { email: props.email ?? "", source: props.client ?? "unknown client" };
		const handler = createMcpHandler(() => buildServer(env, caller), { route: "/mcp" });
		return handler(request, env, ctx);
	},
};

// The protected-resource URL has to be absolute, and the workers.dev subdomain isn't known at build
// time, so one provider is built per origin the Worker is reached on.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
	let provider = providers.get(origin);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: mcpApiHandler,
			defaultHandler: { fetch: handleAuthRequest },
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			clientIdMetadataDocumentEnabled: true,
			resourceMetadata: { resource: `${origin}/mcp`, resource_name: "DEXTER" },
		});
		if (providers.size < 8) providers.set(origin, provider);
	}
	return provider;
}

export default {
	fetch(request, env, ctx) {
		return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
	},
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(deliverDueReminders(env));
	},
} satisfies ExportedHandler<Env>;
