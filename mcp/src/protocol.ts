/**
 * Bridge wire protocol v1: the bytes exchanged between this Worker's `Bridge` Durable Object and
 * the Mac DEXTER (`dexter/mcp_bridge.py`). PROTOCOL.md is the human-readable copy of this file;
 * if the two ever disagree, fix PROTOCOL.md to match this code and tell the Mac side.
 *
 * Never exercised against the real Mac client: everything here is verified only by the offline
 * tests in test/bridge.test.ts, which play the Mac's part with this same module.
 */

export const PROTOCOL_VERSION = "v1";

/** A frame's timestamp may be at most this far from the receiver's clock, either way. */
export const TS_SKEW_SECONDS = 60;
/** Seen nonces are remembered at least this long (spec: >= 120 s; it must exceed 2 x skew). */
export const NONCE_TTL_SECONDS = 180;
/** An unauthenticated socket must finish the connect handshake within this long. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** The Mac sends the text "ping" this often; the Worker answers "pong" without waking. */
export const PING_INTERVAL_SECONDS = 20;
/** An authenticated socket silent for longer than this is stale: tool calls answer "asleep". */
export const STALE_AFTER_MS = 50_000;
/** How long a tool call waits for the Mac's reply. Clients give up at about 60 s. */
export const REPLY_TIMEOUT_MS = 55_000;
/** Largest text message accepted from the Mac, in UTF-16 code units (roughly bytes for ASCII). */
export const MAX_MESSAGE_CHARS = 512 * 1024;

export const TOOL_NAMES = ["dexter_ask", "dexter_whats_live", "dexter_queue", "dexter_memory_search"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const APP_LABELS = ["claude", "claude_code", "chatgpt"] as const;
export type AppLabel = (typeof APP_LABELS)[number];

const encoder = new TextEncoder();
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const CONN = /^[0-9a-f]{32}$/;
const REQUEST_ID = /^[0-9a-f-]{36}$/;

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(byteCount: number): string {
	return toHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

export async function sha256Hex(text: string): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, JSON.stringify for scalars.
 * Only the SENDER needs it (so frames are reproducible and easy to diff in logs). The receiver
 * never re-serializes: it verifies the MAC over the exact bytes it received. That is what makes
 * the scheme immune to Python/JS differences in escaping and number formatting.
 * Arguments are restricted to strings, booleans, safe integers, null, arrays and plain objects.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw new TypeError("canonicalJson: only safe integers are allowed");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

/**
 * The HMAC key is the 32 raw bytes the base64 secret decodes to (NOT the base64 text itself).
 * Standard or URL-safe alphabet, padding optional, surrounding whitespace ignored. Anything that
 * doesn't decode to exactly 32 bytes is refused: the bridge then stays shut (fail closed).
 */
export function decodeSecret(secret: string | undefined): Uint8Array | null {
	if (!secret) return null;
	const cleaned = secret.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
	if (!/^[A-Za-z0-9+/]+$/.test(cleaned)) return null;
	let binary: string;
	try {
		binary = atob(cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4));
	} catch {
		return null;
	}
	if (binary.length !== 32) return null;
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const keyCache = new Map<string, Promise<CryptoKey | null>>();

export function importSecret(secret: string | undefined): Promise<CryptoKey | null> {
	const raw = decodeSecret(secret);
	if (!raw || !secret) return Promise.resolve(null);
	let key = keyCache.get(secret);
	if (!key) {
		key = crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		keyCache.clear();
		keyCache.set(secret, key);
	}
	return key;
}

/** Lowercase hex HMAC-SHA256 over the UTF-8 bytes of `data`. */
export async function hmac(key: CryptoKey, data: string): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data))));
}

/** Constant-time comparison of two strings (length is not secret: MACs are always 64 hex chars). */
export function constantTimeEqual(a: string, b: string): boolean {
	const x = encoder.encode(a);
	const y = encoder.encode(b);
	let diff = x.length ^ y.length;
	const n = Math.max(x.length, y.length);
	for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

export async function verifyMac(key: CryptoKey, data: string, mac: unknown): Promise<boolean> {
	if (typeof mac !== "string" || !HEX64.test(mac)) return false;
	return constantTimeEqual(await hmac(key, data), mac);
}

// ---------- connect handshake ----------

export const connectInput = (challenge: string, conn: string) => `v1|connect|${challenge}|${conn}`;
export const readyInput = (challenge: string, conn: string) => `v1|ready|${challenge}|${conn}`;

export interface ChallengeMessage {
	v: "v1";
	type: "challenge";
	conn: string;
	challenge: string;
	ts: number;
}

// ---------- signed frames ----------

/** The signed part of a Worker-to-Mac request. `body` is itself canonical JSON text. */
export interface RequestMsg {
	v: "v1";
	dir: "w2m";
	conn: string;
	id: string;
	nonce: string;
	ts: number;
	tool: ToolName;
	body: string;
}

/** The signed part of a Mac-to-Worker reply. It also binds the request it answers. */
export interface ReplyMsg {
	v: "v1";
	dir: "m2w";
	conn: string;
	id: string;
	nonce: string;
	ts: number;
	tool: ToolName;
	req_nonce: string;
	req_body_sha256: string;
	body: string;
}

/** What actually goes over the socket: the signed bytes as a string, and their MAC. */
export interface Envelope {
	v: "v1";
	type: "frame";
	msg: string;
	mac: string;
}

/** Request body: what the Mac's fixed handler for `tool` receives. */
export interface RequestBody {
	args: Record<string, string>;
	app: AppLabel;
	client_id: string;
}

/** Reply body. Extra keys are ignored by the Worker. */
export interface ReplyBody {
	text: string;
	is_error: boolean;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function sealFrame(key: CryptoKey, msg: RequestMsg | ReplyMsg): Promise<Envelope> {
	const bytes = canonicalJson(msg);
	return { v: "v1", type: "frame", msg: bytes, mac: await hmac(key, bytes) };
}

export type OpenResult<T> = { ok: true; msg: T } | { ok: false; reason: string };

/**
 * Checks an envelope's version and MAC and returns the parsed signed message. Field checks
 * specific to a direction happen in `checkReply` / on the Mac side.
 * Order: version (outer) -> MAC over the exact `msg` bytes -> parse -> version (inner).
 */
export async function openEnvelope(key: CryptoKey, raw: unknown): Promise<OpenResult<Record<string, unknown>>> {
	if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not an object" };
	const env = raw as Record<string, unknown>;
	if (env.v !== PROTOCOL_VERSION) return { ok: false, reason: "unknown version" };
	if (env.type !== "frame") return { ok: false, reason: "not a frame" };
	if (typeof env.msg !== "string") return { ok: false, reason: "msg is not a string" };
	if (!(await verifyMac(key, env.msg, env.mac))) return { ok: false, reason: "bad mac" };
	let msg: unknown;
	try {
		msg = JSON.parse(env.msg);
	} catch {
		return { ok: false, reason: "msg is not JSON" };
	}
	if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return { ok: false, reason: "msg is not an object" };
	const m = msg as Record<string, unknown>;
	if (m.v !== PROTOCOL_VERSION) return { ok: false, reason: "unknown version" };
	return { ok: true, msg: m };
}

/** What the Worker remembers about a request it sent, to check the reply against. */
export interface SentRequest {
	conn: string;
	id: string;
	tool: ToolName;
	nonce: string;
	bodySha256: string;
}

/**
 * Shape + binding checks for a reply whose MAC already verified. Nonce freshness is checked by the
 * caller (it needs storage). Returns the reply body on success.
 */
export function checkReply(
	m: Record<string, unknown>,
	expectedConn: string,
	sent: SentRequest | undefined,
	now = nowSeconds(),
): OpenResult<ReplyBody> & { nonce?: string; id?: string } {
	if (m.dir !== "m2w") return { ok: false, reason: "wrong direction" };
	if (typeof m.conn !== "string" || !CONN.test(m.conn) || m.conn !== expectedConn) return { ok: false, reason: "wrong conn" };
	if (typeof m.id !== "string" || !REQUEST_ID.test(m.id)) return { ok: false, reason: "bad id" };
	if (typeof m.nonce !== "string" || !NONCE.test(m.nonce)) return { ok: false, reason: "bad nonce" };
	if (typeof m.ts !== "number" || !Number.isSafeInteger(m.ts)) return { ok: false, reason: "bad ts" };
	if (Math.abs(now - m.ts) > TS_SKEW_SECONDS) return { ok: false, reason: "stale or future ts" };
	if (!sent || sent.id !== m.id) return { ok: false, reason: "no such request" };
	if (sent.conn !== m.conn) return { ok: false, reason: "request was on another conn" };
	if (m.tool !== sent.tool) return { ok: false, reason: "tool mismatch" };
	if (typeof m.req_nonce !== "string" || !constantTimeEqual(m.req_nonce, sent.nonce)) return { ok: false, reason: "req_nonce mismatch" };
	if (typeof m.req_body_sha256 !== "string" || !constantTimeEqual(m.req_body_sha256, sent.bodySha256)) {
		return { ok: false, reason: "req_body_sha256 mismatch" };
	}
	if (typeof m.body !== "string") return { ok: false, reason: "body is not a string" };
	let body: unknown;
	try {
		body = JSON.parse(m.body);
	} catch {
		return { ok: false, reason: "body is not JSON" };
	}
	const b = body as Record<string, unknown>;
	if (typeof b !== "object" || b === null || typeof b.text !== "string" || typeof b.is_error !== "boolean") {
		return { ok: false, reason: "body shape" };
	}
	return { ok: true, msg: { text: b.text, is_error: b.is_error }, nonce: m.nonce, id: m.id };
}
