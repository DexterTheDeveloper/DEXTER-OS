import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// Secrets are set with `wrangler secret put` (or in the dashboard), so `wrangler types` can't see
// them. Declared here so the code type-checks.
declare global {
	interface __BaseEnv_Env {
		/** The operator's passphrase (12+ characters). Entered once when connecting an app. */
		DEXTER_PASSPHRASE?: string;

		/**
		 * Shared secret with the Mac bridge: the base64 text of 32 random bytes, generated on the Mac
		 * by `dexter mcp secret --new`. The HMAC key is the decoded bytes. Anything that doesn't
		 * decode to exactly 32 bytes leaves the bridge shut.
		 */
		BRIDGE_SECRET?: string;

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
		 * New app connections (dynamic registration at POST /register AND new sign-ins by a Client ID
		 * Metadata Document URL) are accepted only while this is exactly "true" (any case). Unset,
		 * or any other value, keeps them closed. Set it as a secret while connecting an app, then
		 * delete it. Apps already connected keep working either way.
		 */
		ALLOW_CLIENT_REGISTRATION?: string;

		/** Injected by OAuthProvider for the default handler. */
		OAUTH_PROVIDER: OAuthHelpers;
	}
}

export {};
