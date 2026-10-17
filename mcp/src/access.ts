import {
	AuthorizationError,
	authorizationErrorRedirect,
	CimdFetchError,
	type AuthRequest,
	type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { base64UrlDecode, base64UrlEncode, escapeHtml, hmacHex, sameEmail, sha256Base64Url } from "./util";

/**
 * The OAuth "default handler": everything that isn't /mcp, /token or /register.
 *
 * Two ways to prove you're the operator:
 * - Passphrase (default): the consent page asks for DEXTER_PASSPHRASE. One secret, no other setup.
 * - Cloudflare Access (optional upgrade): set the ACCESS_* secrets and the consent page hands off
 *   to an Access sign-in instead. Access wins when both are configured.
 *
 * Consent, CSRF binding, single-use state and anti-framing come from @cloudflare/workers-oauth-provider.
 */

export interface DexterProps extends Record<string, unknown> {
	operator: true;
	email: string;
	name: string;
	sub: string;
	client: string;
}

type AuthMode = "access" | "passphrase";

interface OidcEndpoints {
	authorization: string;
	token: string;
	jwks: string;
	issuer?: string;
}

const MIN_PASSPHRASE_LENGTH = 12;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_SECONDS = 15 * 60;

function hasAccessConfig(env: Env): boolean {
	const endpoints = Boolean(env.ACCESS_ISSUER || (env.ACCESS_AUTHORIZATION_URL && env.ACCESS_TOKEN_URL && env.ACCESS_JWKS_URL));
	return Boolean(env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET && endpoints);
}

function passphraseUsable(env: Env): boolean {
	return (env.DEXTER_PASSPHRASE ?? "").length >= MIN_PASSPHRASE_LENGTH;
}

function authMode(env: Env): AuthMode | null {
	if (hasAccessConfig(env)) return "access";
	if (passphraseUsable(env)) return "passphrase";
	return null;
}

/** Plain-language list of what's still missing, for the setup page. Never includes values. */
export function missingConfig(env: Env): string[] {
	const missing: string[] = [];
	if (!env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
	const mode = authMode(env);
	if (!mode) {
		missing.push(
			env.DEXTER_PASSPHRASE
				? `DEXTER_PASSPHRASE (needs at least ${MIN_PASSPHRASE_LENGTH} characters)`
				: "DEXTER_PASSPHRASE",
		);
	}
	if (mode === "access" && !env.ALLOWED_EMAIL) missing.push("ALLOWED_EMAIL");
	return missing;
}

let discovery: { issuer: string; promise: Promise<OidcEndpoints> } | undefined;

async function accessEndpoints(env: Env): Promise<OidcEndpoints> {
	if (env.ACCESS_AUTHORIZATION_URL && env.ACCESS_TOKEN_URL && env.ACCESS_JWKS_URL) {
		return {
			authorization: env.ACCESS_AUTHORIZATION_URL,
			token: env.ACCESS_TOKEN_URL,
			jwks: env.ACCESS_JWKS_URL,
			issuer: env.ACCESS_ISSUER,
		};
	}
	const issuer = (env.ACCESS_ISSUER ?? "").replace(/\/+$/, "");
	if (!discovery || discovery.issuer !== issuer) {
		const promise = fetch(`${issuer}/.well-known/openid-configuration`).then(async (response) => {
			if (!response.ok) throw new Error(`Access discovery failed (${response.status}). Check ACCESS_ISSUER.`);
			const config = (await response.json()) as {
				issuer: string;
				authorization_endpoint: string;
				token_endpoint: string;
				jwks_uri: string;
			};
			return {
				authorization: config.authorization_endpoint,
				token: config.token_endpoint,
				jwks: config.jwks_uri,
				issuer: config.issuer,
			};
		});
		promise.catch(() => {
			discovery = undefined;
		});
		discovery = { issuer, promise };
	}
	return discovery.promise;
}

/** Signs remembered-consent cookies (Access mode). Derived from the client secret: one less secret to manage. */
function consentSecret(env: Env): Promise<string> {
	return hmacHex(env.ACCESS_CLIENT_SECRET ?? "", "dexter-mcp-consent-v1");
}

/** Constant-time passphrase check: compare keyed hashes, not the raw strings. */
async function passphraseMatches(env: Env, attempt: string): Promise<boolean> {
	const expected = env.DEXTER_PASSPHRASE ?? "";
	if (!expected || !attempt) return false;
	const [a, b] = await Promise.all([hmacHex(expected, "dexter-pass-check"), hmacHex(attempt, "dexter-pass-check")]);
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function clientIp(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function failureKey(request: Request): string {
	return `dexter:pass-fail:${clientIp(request)}`;
}

async function tooManyFailures(env: Env, request: Request): Promise<boolean> {
	const count = Number((await env.OAUTH_KV.get(failureKey(request))) ?? "0");
	return count >= MAX_FAILURES;
}

async function recordFailure(env: Env, request: Request): Promise<void> {
	const key = failureKey(request);
	const count = Number((await env.OAUTH_KV.get(key)) ?? "0") + 1;
	await env.OAUTH_KV.put(key, String(count), { expirationTtl: FAILURE_WINDOW_SECONDS });
}

/**
 * First layer on POST /authorize and POST /register: the AUTH_RL rate limit (wrangler.jsonc),
 * keyed by client IP, checked before either endpoint writes to KV. Fails closed: a missing or
 * failing limiter refuses the request rather than letting it through unmetered.
 */
export async function authRateLimit(env: Env, request: Request): Promise<Response | null> {
	let success: boolean;
	try {
		({ success } = await env.AUTH_RL.limit({ key: clientIp(request) }));
	} catch {
		success = false;
	}
	if (success) return null;
	const headers = new Headers({ "Retry-After": "60", "Cache-Control": "no-store" });
	if (new URL(request.url).pathname === "/register") {
		headers.set("Content-Type", "application/json");
		return new Response(
			JSON.stringify({ error: "temporarily_unavailable", error_description: "Too many requests. Try again in a minute." }),
			{ status: 429, headers },
		);
	}
	return page("Too many requests", `<div class="card"><p class="warn">Too many sign-in attempts from this network. Wait a minute and try again.</p></div>`, 429, headers);
}

function unavailable(): Response {
	return page(
		"Sign-in paused",
		`<div class="card"><p class="warn">DEXTER can't reach its lock-out counter right now, so it isn't checking passphrases. Try again in a minute.</p></div>`,
		500,
	);
}

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
	headers.set("Content-Type", "text/html; charset=utf-8");
	headers.set("Cache-Control", "no-store");
	headers.set("X-Frame-Options", "DENY");
	headers.set("Content-Security-Policy", "frame-ancestors 'none'");
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0e14;color:#d7e3ee}
main{max-width:480px;margin:0 auto;padding:32px 16px}h1{font-size:20px;letter-spacing:.08em;color:#38e1ff;margin:0 0 4px}
.sub{color:#7d8b99;margin:0 0 24px}.card{border:1px solid #1f2a36;border-radius:10px;padding:16px;background:#0f151d}
.warn{color:#ffb547}strong{color:#fff}form{margin-top:20px}.row{display:flex;gap:12px;margin-top:12px}
input[type=password]{box-sizing:border-box;width:100%;padding:12px;border-radius:8px;border:1px solid #1f2a36;background:#0a0e14;color:#fff;font-size:16px}
button{flex:1;padding:12px;border-radius:8px;border:1px solid #1f2a36;background:#0f151d;color:#d7e3ee;font-size:16px}
button.primary{background:#38e1ff;color:#0a0e14;border-color:#38e1ff;font-weight:600}code{color:#9fb3c8}a{color:#38e1ff}
</style></head><body><main><h1>DEXTER</h1><p class="sub">Personal AI operating system</p>${body}</main></body></html>`,
		{ status, headers },
	);
}

function consentPage(
	details: ConsentDescription,
	handle: string,
	headers: Headers,
	mode: AuthMode,
	notice?: { text: string; status: number },
): Response {
	const name = escapeHtml(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app registered itself, so its name isn't verified.";
	const loopback = details.redirectIsLoopback
		? `<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>`
		: "";
	const warning = notice ? `<p class="warn">${escapeHtml(notice.text)}</p>` : "";
	const proof =
		mode === "passphrase"
			? `<label for="passphrase">DEXTER passphrase</label>
<input id="passphrase" type="password" name="passphrase" autocomplete="current-password" required>`
			: `<p>You'll sign in with Cloudflare Access next.</p>`;
	return page(
		`Connect ${details.clientName} to DEXTER`,
		`<div class="card"><p><strong>${name}</strong> wants to use DEXTER's memory, log and reminders.</p>
<p>${origin} Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>${loopback}${warning}
<form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}">${proof}
<div class="row"><button name="decision" value="deny" formnovalidate>Deny</button><button class="primary" name="decision" value="approve">Allow</button></div></form></div>`,
		notice?.status ?? 200,
		headers,
	);
}

async function redirectToAccess(
	env: Env,
	request: Request,
	authRequest: AuthRequest,
	headers?: Headers,
): Promise<Response> {
	const endpoints = await accessEndpoints(env);
	const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const upstream = await env.OAUTH_PROVIDER.beginUpstream(authRequest, { data: { verifier }, headers });
	const url = new URL(endpoints.authorization);
	url.searchParams.set("client_id", env.ACCESS_CLIENT_ID ?? "");
	url.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "openid email profile");
	url.searchParams.set("state", upstream.state);
	url.searchParams.set("code_challenge", await sha256Base64Url(verifier));
	url.searchParams.set("code_challenge_method", "S256");
	upstream.headers.set("Location", url.toString());
	return new Response(null, { status: 302, headers: upstream.headers });
}

interface IdTokenClaims {
	sub: string;
	email?: string;
	name?: string;
	iss?: string;
	aud?: string | string[];
	exp?: number;
}

async function verifyIdToken(env: Env, idToken: string, endpoints: OidcEndpoints): Promise<IdTokenClaims> {
	const [headerPart, payloadPart, signaturePart] = idToken.split(".");
	if (!headerPart || !payloadPart || !signaturePart) throw new Error("Malformed ID token");
	const decoder = new TextDecoder();
	const header = JSON.parse(decoder.decode(base64UrlDecode(headerPart))) as { alg?: string; kid?: string };
	const claims = JSON.parse(decoder.decode(base64UrlDecode(payloadPart))) as IdTokenClaims;
	if (header.alg !== "RS256") throw new Error("Unexpected ID token algorithm");

	const jwksResponse = await fetch(endpoints.jwks);
	if (!jwksResponse.ok) throw new Error("Could not load Access signing keys");
	const { keys } = (await jwksResponse.json()) as { keys: (JsonWebKey & { kid?: string })[] };
	const jwk = keys.find((key) => key.kid === header.kid);
	if (!jwk) throw new Error("ID token signed with an unknown key");
	const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
		"verify",
	]);
	const valid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		base64UrlDecode(signaturePart),
		new TextEncoder().encode(`${headerPart}.${payloadPart}`),
	);
	if (!valid) throw new Error("ID token signature is invalid");

	const now = Math.floor(Date.now() / 1000);
	if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("ID token expired");
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audiences.includes(env.ACCESS_CLIENT_ID)) throw new Error("ID token was issued for a different app");
	if (endpoints.issuer && claims.iss !== endpoints.issuer) throw new Error("ID token issuer mismatch");
	if (!claims.sub) throw new Error("ID token has no subject");
	return claims;
}

async function exchangeCode(env: Env, request: Request, code: string, verifier: string): Promise<IdTokenClaims> {
	const endpoints = await accessEndpoints(env);
	const response = await fetch(endpoints.token, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: new URL("/callback", request.url).href,
			client_id: env.ACCESS_CLIENT_ID ?? "",
			client_secret: env.ACCESS_CLIENT_SECRET ?? "",
			code_verifier: verifier,
		}).toString(),
	});
	if (!response.ok) throw new Error(`Access token exchange failed (${response.status})`);
	const body = (await response.json()) as { id_token?: string };
	if (!body.id_token) throw new Error("Access returned no ID token");
	return verifyIdToken(env, body.id_token, endpoints);
}

async function issueToken(
	env: Env,
	authRequest: AuthRequest,
	identity: { email: string; name: string; sub: string },
	headers: Headers,
): Promise<Response> {
	const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
	const props: DexterProps = { operator: true, ...identity, client: client?.clientName ?? "unknown client" };
	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: authRequest,
		userId: identity.sub,
		metadata: { label: props.client },
		scope: authRequest.scope,
		props,
	});
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

function authFailure(error: unknown): Response {
	if (error instanceof AuthorizationError) {
		if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
		return page(
			"Sign-in problem",
			`<div class="card"><p>${escapeHtml(error.description)}</p><p>Start the connection again from your app.</p></div>`,
			400,
		);
	}
	if (error instanceof CimdFetchError) {
		return page("Sign-in problem", `<div class="card"><p>This app could not be verified.</p></div>`, 400);
	}
	throw error;
}

export async function handleAuthRequest(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const oauth = env.OAUTH_PROVIDER;
	const missing = missingConfig(env);

	if (url.pathname === "/" && request.method === "GET") {
		const status = missing.length
			? `<p class="warn">Setup incomplete. Add these secrets to the dexter-mcp Worker: <code>${missing.map(escapeHtml).join(", ")}</code></p>`
			: "<p>Online. Connect an assistant to <code>/mcp</code>.</p>";
		return page("DEXTER MCP", `<div class="card">${status}</div>`);
	}

	if ((url.pathname === "/authorize" || url.pathname === "/callback") && missing.length) {
		return page(
			"DEXTER setup",
			`<div class="card"><p class="warn">DEXTER isn't finished setting up. Add these secrets to the dexter-mcp Worker: <code>${missing.map(escapeHtml).join(", ")}</code></p></div>`,
			503,
		);
	}
	const mode = authMode(env);

	try {
		if (url.pathname === "/authorize" && request.method === "GET") {
			const authRequest = await oauth.parseAuthRequest(request);
			if (mode === "access") {
				const remember = { secret: await consentSecret(env) };
				if (await oauth.isConsentRemembered(request, authRequest, remember)) {
					return redirectToAccess(env, request, authRequest);
				}
			}
			const details = await oauth.describeConsent(authRequest);
			const consent = await oauth.beginConsent(authRequest);
			return consentPage(details, consent.handle, consent.headers, mode ?? "passphrase");
		}

		if (url.pathname === "/authorize" && request.method === "POST") {
			const form = await request.formData();
			const handle = String(form.get("handle") ?? "");
			if (form.get("decision") !== "approve") {
				const denied = await oauth.denyConsent(request, handle);
				return new Response(null, { status: 302, headers: denied.headers });
			}

			if (mode === "access") {
				const approved = await oauth.approveConsent(request, handle, {
					remember: { secret: await consentSecret(env) },
				});
				return redirectToAccess(env, request, approved.request, approved.headers);
			}

			// Passphrase mode, in this order: the lock-out counter (fails closed), then the consent
			// handle and its binding cookie, and only then the passphrase. A POST without a live
			// consent transaction gets the same 400 whether the passphrase is right or wrong, so
			// this page can't be used to test guesses outside an OAuth flow.
			let locked: boolean;
			try {
				locked = await tooManyFailures(env, request);
			} catch {
				return unavailable();
			}
			if (locked) {
				return page(
					"Too many tries",
					`<div class="card"><p class="warn">Too many wrong passphrases. Wait 15 minutes and try again.</p></div>`,
					429,
					new Headers({ "Retry-After": String(FAILURE_WINDOW_SECONDS) }),
				);
			}
			const approved = await oauth.approveConsent(request, handle);
			if (!(await passphraseMatches(env, String(form.get("passphrase") ?? "")))) {
				try {
					await recordFailure(env, request);
				} catch {
					return unavailable();
				}
				// The handle above was single-use. Start a fresh consent transaction so a typo can be
				// retried on this page instead of from the app.
				const retry = await oauth.beginConsent(approved.request);
				for (const cookie of approved.headers.getSetCookie()) retry.headers.append("Set-Cookie", cookie);
				return consentPage(await oauth.describeConsent(approved.request), retry.handle, retry.headers, "passphrase", {
					text: "That passphrase didn't match. Try again.",
					status: 401,
				});
			}
			return issueToken(
				env,
				approved.request,
				{ email: env.ALLOWED_EMAIL ?? "", name: "Operator", sub: "operator" },
				approved.headers,
			);
		}

		if (url.pathname === "/callback" && request.method === "GET" && mode === "access") {
			const resumed = await oauth.finishUpstream<{ verifier: string }>(request);
			const code = url.searchParams.get("code");
			if (url.searchParams.get("error") || !code) {
				resumed.headers.set("Location", authorizationErrorRedirect(resumed.request, "access_denied"));
				return new Response(null, { status: 302, headers: resumed.headers });
			}

			const claims = await exchangeCode(env, request, code, resumed.data.verifier);
			if (!sameEmail(claims.email, env.ALLOWED_EMAIL)) {
				resumed.headers.set(
					"Location",
					authorizationErrorRedirect(resumed.request, "access_denied", "This DEXTER server only accepts its operator."),
				);
				return new Response(null, { status: 302, headers: resumed.headers });
			}
			return issueToken(
				env,
				resumed.request,
				{ email: claims.email ?? "", name: claims.name ?? claims.email ?? "", sub: claims.sub },
				resumed.headers,
			);
		}
	} catch (error) {
		return authFailure(error);
	}

	return new Response("Not found", { status: 404 });
}
