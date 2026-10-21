import { DurableObject } from "cloudflare:workers";

/**
 * Fixed-window request counters, one Durable Object per (bucket, key). Replaces the AUTH_RL
 * Workers rate-limit binding, which a live probe showed did not enforce (53 requests, no 429).
 * A Durable Object is single-threaded and its storage is strongly consistent, so the count is
 * exact: the 11th request in a window of 10 is refused, every time.
 */
export class AuthLimiter extends DurableObject<Env> {
	async hit(limit: number, windowSeconds: number): Promise<{ ok: boolean; retryAfter: number }> {
		const now = Date.now();
		const windowMs = windowSeconds * 1000;
		const window = Math.floor(now / windowMs);
		const state = (await this.ctx.storage.get<{ w: number; c: number }>("s")) ?? { w: window, c: 0 };
		if (state.w !== window) {
			state.w = window;
			state.c = 0;
		}
		state.c += 1;
		await this.ctx.storage.put("s", state);
		const retryAfter = Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000));
		return { ok: state.c <= limit, retryAfter };
	}
}

export interface Budget {
	bucket: string;
	limit: number;
	windowSeconds: number;
	/** Per client IP when true; one shared counter for everyone when false. */
	perIp: boolean;
}

/** Sign-in pages and registration: 10 a minute per IP, 60 a minute in total. */
export const AUTH_BUDGETS: Budget[] = [
	{ bucket: "auth", limit: 10, windowSeconds: 60, perIp: true },
	{ bucket: "auth-all", limit: 60, windowSeconds: 60, perIp: false },
];
/**
 * Token endpoint (code exchange, refresh, revocation): per IP only. Claude and ChatGPT call it from
 * their own servers, and a global cap here would let a stranger stop every connected app refreshing.
 */
export const TOKEN_BUDGETS: Budget[] = [{ bucket: "token", limit: 30, windowSeconds: 60, perIp: true }];
/** The Mac's socket: reconnects with backoff, so 10 a minute per IP is generous. */
export const BRIDGE_BUDGETS: Budget[] = [{ bucket: "bridge", limit: 10, windowSeconds: 60, perIp: true }];

export function clientIp(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * Charges the request against every budget. Returns the number of seconds to wait when any budget
 * is exhausted, or null when the request may go ahead. Fails closed: if the limiter can't be
 * reached, the request is refused rather than let through unmetered.
 */
export async function overBudget(env: Env, request: Request, budgets: Budget[]): Promise<number | null> {
	try {
		const ip = clientIp(request);
		const results = await Promise.all(
			budgets.map((b) => {
				const name = b.perIp ? `${b.bucket}:${ip}` : b.bucket;
				return env.AUTH_LIMITER.get(env.AUTH_LIMITER.idFromName(name)).hit(b.limit, b.windowSeconds);
			}),
		);
		const refused = results.filter((r) => !r.ok);
		return refused.length ? Math.max(...refused.map((r) => r.retryAfter)) : null;
	} catch {
		return 60;
	}
}
