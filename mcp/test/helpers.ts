import { createExecutionContext, env, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
import { expect } from "vitest";
import worker, { CANONICAL_ORIGIN, mcpApiHandler } from "../src/index";
import {
	canonicalJson,
	connectInput,
	hmac,
	importSecret,
	nowSeconds,
	openEnvelope,
	randomHex,
	readyInput,
	sealFrame,
	sha256Hex,
	verifyMac,
	type ReplyBody,
	type ReplyMsg,
	type RequestMsg,
} from "../src/protocol";

export const ORIGIN = CANONICAL_ORIGIN;
export type Json = Record<string, any>;

/** The fixed fake key from vitest.config.ts. */
export const TEST_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
export const WRONG_SECRET = "HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4=";

export function randomIp(): string {
	const [a, b, c] = crypto.getRandomValues(new Uint8Array(3));
	return `10.${a}.${b}.${c}`;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fixed-window counters reset on the minute; a burst test waits until it isn't about to straddle one. */
export async function awayFromWindowEdge(): Promise<void> {
	const intoMinute = Date.now() % 60_000;
	if (intoMinute > 55_000) await sleep(60_000 - intoMinute + 200);
}

export async function key(secret = TEST_SECRET): Promise<CryptoKey> {
	const k = await importSecret(secret);
	if (!k) throw new Error("bad test secret");
	return k;
}

export function bridgeStub() {
	return env.BRIDGE.get(env.BRIDGE.idFromName("dexter"));
}

/** Closes every socket the Bridge holds, so a test starts with the Mac disconnected. */
export async function resetBridge(): Promise<void> {
	await runInDurableObject(bridgeStub(), async (_instance, state) => {
		for (const ws of state.getWebSockets()) {
			try {
				ws.close(1000, "test reset");
			} catch {
				// already closed
			}
		}
	});
}

/** Rewrites every authenticated socket's attachment. */
export async function editAuthedAttachments(edit: (a: Json) => Json): Promise<void> {
	await runInDurableObject(bridgeStub(), async (_instance, state) => {
		for (const ws of state.getWebSockets()) {
			const a = ws.deserializeAttachment() as Json | null;
			if (a?.state === "authed" || a?.state === "pending") ws.serializeAttachment(edit(a));
		}
	});
}

/** A socket plus a queue of what arrives on it. */
export class TestSocket {
	private queue: string[] = [];
	private waiters: ((value: string) => void)[] = [];
	closed: Promise<{ code: number; reason: string }>;

	constructor(readonly ws: WebSocket) {
		ws.addEventListener("message", (event) => {
			const data = typeof event.data === "string" ? event.data : "";
			const waiter = this.waiters.shift();
			if (waiter) waiter(data);
			else this.queue.push(data);
		});
		this.closed = new Promise((resolve) => {
			ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
		});
	}

	next(timeoutMs = 3000): Promise<string> {
		const queued = this.queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no message within timeout")), timeoutMs);
			this.waiters.push((value) => {
				clearTimeout(timer);
				resolve(value);
			});
		});
	}

	async closedWithin(ms = 3000): Promise<{ code: number; reason: string }> {
		return Promise.race([this.closed, sleep(ms).then(() => ({ code: -1, reason: "still open" }))]);
	}

	send(value: unknown): void {
		this.ws.send(typeof value === "string" ? value : JSON.stringify(value));
	}
}

export async function openBridgeSocket(ip = randomIp()): Promise<TestSocket> {
	const response = await SELF.fetch(`${ORIGIN}/bridge`, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } });
	expect(response.status).toBe(101);
	const ws = response.webSocket!;
	ws.accept();
	return new TestSocket(ws);
}

/** Plays the Mac: dials /bridge and completes the challenge handshake. */
export async function connectMac(secret = TEST_SECRET): Promise<{ sock: TestSocket; conn: string; challenge: string; ready: Json }> {
	const sock = await openBridgeSocket();
	const hello = JSON.parse(await sock.next()) as Json;
	expect(hello).toMatchObject({ v: "v1", type: "challenge" });
	const k = await key(secret);
	sock.send({ v: "v1", type: "connect", conn: hello.conn, mac: await hmac(k, connectInput(hello.challenge, hello.conn)) });
	const ready = JSON.parse(await sock.next()) as Json;
	return { sock, conn: hello.conn, challenge: hello.challenge, ready };
}

/** Reads one w2m frame the way the Mac must: MAC first over the exact msg bytes, then fields. */
export async function readRequest(sock: TestSocket): Promise<RequestMsg> {
	const raw = JSON.parse(await sock.next()) as Json;
	const opened = await openEnvelope(await key(), raw);
	if (!opened.ok) throw new Error(`request failed verification: ${opened.reason}`);
	const msg = opened.msg as unknown as RequestMsg;
	expect(msg.dir).toBe("w2m");
	expect(Math.abs(nowSeconds() - msg.ts)).toBeLessThanOrEqual(60);
	return msg;
}

export async function replyFrame(req: RequestMsg, body: ReplyBody, overrides: Partial<ReplyMsg> = {}, secret = TEST_SECRET) {
	const msg: ReplyMsg = {
		v: "v1",
		dir: "m2w",
		conn: req.conn,
		id: req.id,
		nonce: randomHex(16),
		ts: nowSeconds(),
		tool: req.tool,
		req_nonce: req.nonce,
		req_body_sha256: await sha256Hex(req.body),
		body: canonicalJson(body),
		...overrides,
	};
	return sealFrame(await key(secret), msg);
}

/** Answers every request on `sock` with `answer(req)` until the socket closes. */
export function serve(sock: TestSocket, answer: (req: RequestMsg) => ReplyBody): { requests: RequestMsg[] } {
	const seen: { requests: RequestMsg[] } = { requests: [] };
	const handle = async (data: string) => {
		const raw = JSON.parse(data) as Json;
		const opened = await openEnvelope(await key(), raw);
		if (!opened.ok) return;
		const req = opened.msg as unknown as RequestMsg;
		seen.requests.push(req);
		sock.send(await replyFrame(req, answer(req)));
	};
	sock.ws.addEventListener("message", (event) => {
		if (typeof event.data === "string" && event.data.startsWith("{")) void handle(event.data);
	});
	return seen;
}

export { verifyMac, readyInput };

/** Calls /mcp the way an authenticated client would, past the OAuth layer. */
export async function rpc(method: string, params: Json = {}, props: Json = {}, custom: Partial<Env> = {}, headers: Json = {}): Promise<Json> {
	const ctx = createExecutionContext() as ExecutionContext & { props?: Json };
	ctx.props = { operator: true, email: "", name: "Operator", sub: "operator", client: "Claude", app: "claude", clientId: "client-1", ...props };
	const merged: Json = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", ...headers };
	for (const name of Object.keys(merged)) if (merged[name] === undefined) delete merged[name];
	const request = new Request(`${ORIGIN}/mcp`, { method: "POST", headers: merged, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
	const response = await mcpApiHandler.fetch(request, { ...env, ...custom } as Env, ctx);
	await waitOnExecutionContext(ctx);
	return parseMcp(response);
}

export async function parseMcp(response: Response): Promise<Json> {
	const text = await response.text();
	if (response.headers.get("content-type")?.includes("text/event-stream")) {
		const data = text
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.pop();
		return { status: response.status, headers: response.headers, ...JSON.parse(data ?? "{}") };
	}
	return { status: response.status, headers: response.headers, ...(text ? JSON.parse(text) : {}) };
}

export async function callTool(name: string, args: Json = {}, props: Json = {}): Promise<{ text: string; isError: boolean; raw: Json }> {
	const result = await rpc("tools/call", { name, arguments: args }, props);
	return {
		text: (result.result?.content ?? []).map((c: Json) => c.text).join("\n"),
		isError: Boolean(result.result?.isError),
		raw: result,
	};
}

/** Sends a request straight into the Worker's fetch handler with a modified environment. */
export async function viaWorker(request: Request, custom: Partial<Env> = {}): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], { ...env, ...custom } as Env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}
