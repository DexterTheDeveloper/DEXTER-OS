import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// Secrets are set in the Cloudflare dashboard (Worker > Settings > Variables and Secrets),
// so `wrangler types` can't see them. Declared here so the code type-checks.
declare global {
	interface __BaseEnv_Env {
		/** Anthropic API key. Used only for the Managed Agents memory store API. */
		ANTHROPIC_API_KEY?: string;

		/** The operator's passphrase (12+ characters). Entered once when connecting an assistant. */
		DEXTER_PASSPHRASE?: string;

		/** Optional Cloudflare Access sign-in instead of the passphrase. Access for SaaS (OIDC) app: Client ID. */
		ACCESS_CLIENT_ID?: string;
		/** Access for SaaS (OIDC) app: Client secret. */
		ACCESS_CLIENT_SECRET?: string;
		/** Access for SaaS (OIDC) app: Issuer. Endpoints are discovered from it. */
		ACCESS_ISSUER?: string;
		/** Optional explicit endpoints, used instead of discovery when all three are set. */
		ACCESS_AUTHORIZATION_URL?: string;
		ACCESS_TOKEN_URL?: string;
		ACCESS_JWKS_URL?: string;

		/** Access mode only: the one email allowed to connect. Everyone else is refused. */
		ALLOWED_EMAIL?: string;

		/**
		 * Dynamic client registration (POST /register) is on unless this is "false". Set it as a
		 * secret (`wrangler secret put ALLOW_CLIENT_REGISTRATION`) once every assistant is connected:
		 * a secret survives deploys, and a plain var of the same name would collide with it.
		 * Registrations already made keep working for 90 days and renew when they are used.
		 */
		ALLOW_CLIENT_REGISTRATION?: string;

		/** Optional push settings. A private topic is generated when NTFY_TOPIC is unset. */
		NTFY_TOPIC?: string;
		NTFY_SERVER?: string;
		NTFY_TOKEN?: string;

		/** Optional pinned memory store IDs. Created and remembered automatically when unset. */
		MEMORY_STORE_ID?: string;
		REFERENCE_STORE_ID?: string;

		/** Injected by OAuthProvider for the default handler. */
		OAUTH_PROVIDER: OAuthHelpers;
	}
}

export {};
