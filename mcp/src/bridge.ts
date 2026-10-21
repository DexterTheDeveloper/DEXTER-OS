import { DurableObject } from "cloudflare:workers";
import {
	canonicalJson,
	checkReply,
	connectInput,
	HANDSHAKE_TIMEOUT_MS,
	hmac,
	importSecret,
	MAX_MESSAGE_CHARS,
	NONCE_TTL_SECONDS,
	nowSeconds,
	openEnvelope,
	PROTOCOL_VERSION,
	randomHex,
	readyInput,
	REPLY_TIMEOUT_MS,
	sealFrame,
	sha256Hex,
	STALE_AFTER_MS,
	verifyMac,
	type AppLabel,
	type ChallengeMessage,
	type RequestBody,
	type RequestMsg,
	type SentRequest,
	type ToolName,
} from "./protocol";

/**
 * The Mac DEXTER's one outbound socket, held by a single Durable Object instance (named "dexter").
 *
 * The Mac dials wss://mcp.iiiglobe.com/bridge; nothing on the Mac listens. Tool calls from /mcp
 * arrive here as `relay()` RPCs, go to the Mac as signed frames, and wait (55 s at most) for a
 * signed reply bound to that exact request. No socket, or a silent one, answers "asleep" at once.
 *
 * Per-socket state lives in the socket attachment (it survives hibernation). In-flight requests
 * live in memory: an outstanding relay() keeps the object awake, so they can't be lost to
 * hibernation, only to eviction, which fails the RPC and the caller sees an error.
 *
 * Verified only offline (test/bridge.test.ts plays the Mac). Never connected to the real Mac.
 */

export const BRIDGE_NAME = "dexter";

/** Unauthenticated sockets allowed at once. A stranger can't use them to push the Mac off. */
const MAX_PENDING_SOCKETS = 3;
/** Requests in flight at once. */
const MAX_IN_FLIGHT = 16;

type Attachment =
	| { state: "pending"; conn: string; challenge: string; opened: number }
	| { state: "authed"; conn: string; opened: number; last: number };

export type RelayResult =
	| { status: "ok"; text: string; isError: boolean }
	| { status: "asleep" }
	| { status: "timeout" }
	| { status: "busy" }
	| { status: "dropped" }
	| { status: "unconfigured" };

export interface RelayInput {
	tool: ToolName;
	args: Record<string, string>;
	app: AppLabel;
	clientId: string;
}

interface Pending extends SentRequest {
	resolve: (result: RelayResult) => void;
	timer: ReturnType<typeof setTimeout>;
}

const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;
const CLOSE_UNSUPPORTED = 1003;
const CLOSE_REPLACED = 4000;
const CLOSE_HANDSHAKE_TIMEOUT = 4001;

export class Bridge extends DurableObject<Env> {
	private pending = new Map<string, Pending>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// The Mac's keep-alive. Answered by the runtime without waking the object; the time of the
		// last one is read back with getWebSocketAutoResponseTimestamp() for the staleness check.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, exp INTEGER NOT NULL)");
	}

	private attachment(ws: WebSocket): Attachment | null {
		try {
			return (ws.deserializeAttachment() as Attachment | null) ?? null;
		} catch {
			return null;
		}
	}

	private closeQuietly(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code, reason);
		} catch {
			// already closed
		}
	}

	/** Closes pending sockets past the handshake deadline; returns the ones still pending. */
	private sweepPending(now = Date.now()): WebSocket[] {
		const live: WebSocket[] = [];
		for (const ws of this.ctx.getWebSockets()) {
			const a = this.attachment(ws);
			if (!a || a.state !== "pending") continue;
			if (now - a.opened > HANDSHAKE_TIMEOUT_MS) this.closeQuietly(ws, CLOSE_HANDSHAKE_TIMEOUT, "handshake timeout");
			else live.push(ws);
		}
		return live;
	}

	private lastSeen(ws: WebSocket, a: Extract<Attachment, { state: "authed" }>): number {
		const ping = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
		return Math.max(a.last, ping);
	}

	/** The authenticated socket, if there is one and it has been heard from recently. */
	private freshSocket(now = Date.now()): { ws: WebSocket; conn: string } | null {
		for (const ws of this.ctx.getWebSockets()) {
			const a = this.attachment(ws);
			if (!a || a.state !== "authed") continue;
			if (ws.readyState !== WebSocket.OPEN) continue;
			if (now - this.lastSeen(ws, a) > STALE_AFTER_MS) continue;
			return { ws, conn: a.conn };
		}
		return null;
	}

	private failConn(conn: string, result: RelayResult): void {
		for (const [id, p] of this.pending) {
			if (p.conn !== conn) continue;
			clearTimeout(p.timer);
			this.pending.delete(id);
			p.resolve(result);
		}
	}

	/** Records a nonce; false if it was already seen inside the window. */
	private rememberNonce(nonce: string, now = nowSeconds()): boolean {
		const sql = this.ctx.storage.sql;
		sql.exec("DELETE FROM nonces WHERE exp < ?", now);
		const seen = sql.exec("SELECT 1 FROM nonces WHERE nonce = ?", nonce).toArray();
		if (seen.length) return false;
		sql.exec("INSERT INTO nonces (nonce, exp) VALUES (?, ?)", nonce, now + NONCE_TTL_SECONDS);
		return true;
	}

	private async scheduleSweep(): Promise<void> {
		const at = Date.now() + HANDSHAKE_TIMEOUT_MS + 500;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade.", { status: 426, headers: { Upgrade: "websocket" } });
		}
		// No secret, no bridge: refuse before accepting anything.
		if (!(await importSecret(this.env.BRIDGE_SECRET))) {
			return new Response("Bridge not configured.", { status: 503 });
		}
		const pendingNow = this.sweepPending();
		// Oldest first out, so a flood of strangers can't hold the door shut for the Mac.
		pendingNow
			.sort((a, b) => (this.attachment(a)?.opened ?? 0) - (this.attachment(b)?.opened ?? 0))
			.slice(0, Math.max(0, pendingNow.length - (MAX_PENDING_SOCKETS - 1)))
			.forEach((ws) => this.closeQuietly(ws, CLOSE_POLICY, "too many pending"));

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
		this.ctx.acceptWebSocket(server);
		const conn = randomHex(16);
		const challenge = randomHex(32);
		const attachment: Attachment = { state: "pending", conn, challenge, opened: Date.now() };
		server.serializeAttachment(attachment);
		const hello: ChallengeMessage = { v: PROTOCOL_VERSION, type: "challenge", conn, challenge, ts: nowSeconds() };
		server.send(JSON.stringify(hello));
		await this.scheduleSweep();
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") return this.closeQuietly(ws, CLOSE_UNSUPPORTED, "text frames only");
		if (message.length > MAX_MESSAGE_CHARS) return this.closeQuietly(ws, CLOSE_TOO_BIG, "message too large");
		const a = this.attachment(ws);
		if (!a) return this.closeQuietly(ws, CLOSE_POLICY, "unknown socket");
		if (message === "ping") {
			// Normally answered by the auto-response; handled here too in case it reaches us.
			ws.send("pong");
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(message);
		} catch {
			return this.closeQuietly(ws, CLOSE_POLICY, "not JSON");
		}
		const key = await importSecret(this.env.BRIDGE_SECRET);
		if (!key) return this.closeQuietly(ws, CLOSE_POLICY, "bridge not configured");
		if (a.state === "pending") return this.handleConnect(ws, a, parsed, key);
		return this.handleReply(ws, a, parsed, key);
	}

	private async handleConnect(
		ws: WebSocket,
		a: Extract<Attachment, { state: "pending" }>,
		parsed: unknown,
		key: CryptoKey,
	): Promise<void> {
		const m = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
		// The challenge is single-use: whatever happens next, this socket never gets another try.
		const { challenge, conn } = a;
		if (m.v !== PROTOCOL_VERSION) return this.closeQuietly(ws, CLOSE_POLICY, "unsupported version");
		if (m.type !== "connect" || m.conn !== conn) return this.closeQuietly(ws, CLOSE_POLICY, "bad connect");
		if (Date.now() - a.opened > HANDSHAKE_TIMEOUT_MS) return this.closeQuietly(ws, CLOSE_HANDSHAKE_TIMEOUT, "handshake timeout");
		if (!(await verifyMac(key, connectInput(challenge, conn), m.mac))) {
			console.warn("bridge: connect handshake failed");
			return this.closeQuietly(ws, CLOSE_POLICY, "auth failed");
		}
		// Authenticated. New replaces old: any earlier authenticated socket is closed and its
		// in-flight requests answer "asleep" (they were sent to a connection that is going away).
		for (const other of this.ctx.getWebSockets()) {
			if (other === ws) continue;
			const oa = this.attachment(other);
			if (oa?.state !== "authed") continue;
			this.failConn(oa.conn, { status: "asleep" });
			this.closeQuietly(other, CLOSE_REPLACED, "replaced by a newer connection");
		}
		const now = Date.now();
		ws.serializeAttachment({ state: "authed", conn, opened: a.opened, last: now } satisfies Attachment);
		ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "ready", conn, mac: await hmac(key, readyInput(challenge, conn)) }));
		console.log("bridge: Mac connected");
	}

	private async handleReply(
		ws: WebSocket,
		a: Extract<Attachment, { state: "authed" }>,
		parsed: unknown,
		key: CryptoKey,
	): Promise<void> {
		ws.serializeAttachment({ ...a, last: Date.now() } satisfies Attachment);
		const opened = await openEnvelope(key, parsed);
		if (!opened.ok) {
			// A frame that fails its MAC or names an unknown version is a protocol violation.
			console.warn(`bridge: refused frame (${opened.reason})`);
			this.failConn(a.conn, { status: "dropped" });
			return this.closeQuietly(ws, CLOSE_POLICY, opened.reason === "unknown version" ? "unsupported version" : "bad frame");
		}
		const id = typeof opened.msg.id === "string" ? opened.msg.id : "";
		const sent = this.pending.get(id);
		const checked = checkReply(opened.msg, a.conn, sent);
		if (!checked.ok) {
			if (checked.reason === "no such request") {
				// Correctly signed but for a request that already timed out: drop it, keep the socket.
				console.warn("bridge: late or unknown reply dropped");
				return;
			}
			console.warn(`bridge: refused reply (${checked.reason})`);
			this.failConn(a.conn, { status: "dropped" });
			return this.closeQuietly(ws, CLOSE_POLICY, "bad frame");
		}
		if (!this.rememberNonce(checked.nonce!)) {
			console.warn("bridge: replayed nonce refused");
			this.failConn(a.conn, { status: "dropped" });
			return this.closeQuietly(ws, CLOSE_POLICY, "replay");
		}
		const p = this.pending.get(id)!;
		clearTimeout(p.timer);
		this.pending.delete(id);
		p.resolve({ status: "ok", text: checked.msg.text, isError: checked.msg.is_error });
	}

	async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
		const a = this.attachment(ws);
		if (a?.state === "authed") this.failConn(a.conn, { status: "asleep" });
		this.closeQuietly(ws, code === 1005 || code === 1006 ? 1000 : code, "closing");
	}

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		const a = this.attachment(ws);
		if (a?.state === "authed") this.failConn(a.conn, { status: "asleep" });
		this.closeQuietly(ws, 1011, "error");
	}

	async alarm(): Promise<void> {
		const stillPending = this.sweepPending();
		this.ctx.storage.sql.exec("DELETE FROM nonces WHERE exp < ?", nowSeconds());
		if (stillPending.length) await this.scheduleSweep();
	}

	/**
	 * Forwards one tool call to the Mac and waits for its signed reply. `timeoutMs` exists so tests
	 * can shorten the wait; it can only make it shorter than REPLY_TIMEOUT_MS, never longer.
	 */
	async relay(input: RelayInput, options: { timeoutMs?: number } = {}): Promise<RelayResult> {
		const key = await importSecret(this.env.BRIDGE_SECRET);
		if (!key) return { status: "unconfigured" };
		const target = this.freshSocket();
		if (!target) return { status: "asleep" };
		if (this.pending.size >= MAX_IN_FLIGHT) return { status: "busy" };

		const body: RequestBody = { args: input.args, app: input.app, client_id: input.clientId };
		const bodyText = canonicalJson(body);
		const msg: RequestMsg = {
			v: PROTOCOL_VERSION,
			dir: "w2m",
			conn: target.conn,
			id: crypto.randomUUID(),
			nonce: randomHex(16),
			ts: nowSeconds(),
			tool: input.tool,
			body: bodyText,
		};
		const envelope = await sealFrame(key, msg);
		const bodySha256 = await sha256Hex(bodyText);
		const timeout = Math.min(Math.max(options.timeoutMs ?? REPLY_TIMEOUT_MS, 1), REPLY_TIMEOUT_MS);

		return new Promise<RelayResult>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(msg.id);
				resolve({ status: "timeout" });
			}, timeout);
			this.pending.set(msg.id, { conn: msg.conn, id: msg.id, tool: msg.tool, nonce: msg.nonce, bodySha256, resolve, timer });
			try {
				target.ws.send(JSON.stringify(envelope));
			} catch {
				clearTimeout(timer);
				this.pending.delete(msg.id);
				resolve({ status: "asleep" });
			}
		});
	}
}
