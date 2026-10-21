/// <reference types="@cloudflare/vitest-plugin/types" />
import { runDurableObjectAlarm, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	canonicalJson,
	connectInput,
	constantTimeEqual,
	decodeSecret,
	hmac,
	nowSeconds,
	randomHex,
	readyInput,
	sealFrame,
	sha256Hex,
} from "../src/protocol";
import { ASLEEP_TEXT } from "../src/server";
import {
	bridgeStub,
	callTool,
	connectMac,
	editAuthedAttachments,
	key,
	openBridgeSocket,
	ORIGIN,
	randomIp,
	readRequest,
	replyFrame,
	resetBridge,
	serve,
	sleep,
	TEST_SECRET,
	viaWorker,
	WRONG_SECRET,
	type Json,
} from "./helpers";

const ask = (question = "what's live?") =>
	bridgeStub().relay({ tool: "dexter_ask", args: { question }, app: "claude", clientId: "client-1" }, { timeoutMs: 3000 });

beforeEach(async () => {
	await resetBridge();
});

describe("protocol primitives", () => {
	it("canonical JSON sorts keys, has no whitespace and refuses floats", () => {
		expect(canonicalJson({ b: 1, a: { d: [true, null, "x"], c: "é" } })).toBe('{"a":{"c":"é","d":[true,null,"x"]},"b":1}');
		expect(() => canonicalJson({ n: 1.5 })).toThrow();
	});

	it("the key is the 32 decoded bytes; anything else is refused", () => {
		expect(decodeSecret(TEST_SECRET)?.length).toBe(32);
		expect(decodeSecret(TEST_SECRET.replace(/=+$/, ""))?.length).toBe(32); // padding optional
		expect(decodeSecret(` ${TEST_SECRET}\n`)?.length).toBe(32); // whitespace ignored
		expect(decodeSecret("AAEC")).toBeNull(); // too short
		expect(decodeSecret(btoa("x".repeat(33)))).toBeNull(); // too long
		expect(decodeSecret("not base64 !!")).toBeNull();
		expect(decodeSecret(undefined)).toBeNull();
	});

	it("HMAC is over the decoded key bytes, not the base64 text (a fixed vector for the Mac side)", async () => {
		// Key = bytes 0x00..0x1f. Python: hmac.new(bytes(range(32)), b"v1|connect|ab|cd", "sha256").hexdigest()
		const mac = await hmac(await key(), connectInput("ab", "cd"));
		const textKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(TEST_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const wrongWay = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", textKey, new TextEncoder().encode("v1|connect|ab|cd"))), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		expect(mac).toMatch(/^[0-9a-f]{64}$/);
		expect(mac).not.toBe(wrongWay);
		// Computed independently with Python's hmac module (see the comment above).
		expect(mac).toBe("335122ea6d795b250a84118bf741253ee6d931ff7d5c0aa4ca7dc64b1bfd9fb4");
	});

	it("constant-time compare gets equality right, including length mismatches", () => {
		expect(constantTimeEqual("abc", "abc")).toBe(true);
		expect(constantTimeEqual("abc", "abd")).toBe(false);
		expect(constantTimeEqual("abc", "abcd")).toBe(false);
		expect(constantTimeEqual("", "")).toBe(true);
	});
});

describe("connect handshake", () => {
	it("sends a challenge, accepts the right answer and proves it holds the secret too", async () => {
		const { conn, challenge, ready } = await connectMac();
		expect(conn).toMatch(/^[0-9a-f]{32}$/);
		expect(challenge).toMatch(/^[0-9a-f]{64}$/);
		expect(ready).toMatchObject({ v: "v1", type: "ready", conn });
		expect(ready.mac).toBe(await hmac(await key(), readyInput(challenge, conn)));
	});

	it("refuses a wrong secret and closes the socket", async () => {
		const sock = await openBridgeSocket();
		const hello = JSON.parse(await sock.next()) as Json;
		sock.send({ v: "v1", type: "connect", conn: hello.conn, mac: await hmac(await key(WRONG_SECRET), connectInput(hello.challenge, hello.conn)) });
		expect((await sock.closedWithin()).code).toBe(1008);
		expect((await ask()).status).toBe("asleep");
	});

	it("refuses an answer computed for a different challenge (a recorded handshake can't be replayed)", async () => {
		const first = await connectMac();
		const sock = await openBridgeSocket();
		const hello = JSON.parse(await sock.next()) as Json;
		// The old connection's answer, re-sent on the new socket under the new conn id.
		sock.send({ v: "v1", type: "connect", conn: hello.conn, mac: await hmac(await key(), connectInput(first.challenge, first.conn)) });
		expect((await sock.closedWithin()).code).toBe(1008);
		// The authenticated Mac was not disturbed by the failed attempt.
		serve(first.sock, () => ({ text: "still here", is_error: false }));
		expect(await ask()).toEqual({ status: "ok", text: "still here", isError: false });
	});

	it("refuses an unknown protocol version", async () => {
		const sock = await openBridgeSocket();
		const hello = JSON.parse(await sock.next()) as Json;
		sock.send({ v: "v2", type: "connect", conn: hello.conn, mac: await hmac(await key(), connectInput(hello.challenge, hello.conn)) });
		const closed = await sock.closedWithin();
		expect(closed.code).toBe(1008);
		expect(closed.reason).toBe("unsupported version");
	});

	it("refuses a connect naming a different conn id", async () => {
		const sock = await openBridgeSocket();
		const hello = JSON.parse(await sock.next()) as Json;
		const other = randomHex(16);
		sock.send({ v: "v1", type: "connect", conn: other, mac: await hmac(await key(), connectInput(hello.challenge, other)) });
		expect((await sock.closedWithin()).code).toBe(1008);
	});

	it("closes a socket that never answers the challenge once the deadline passes", async () => {
		const sock = await openBridgeSocket();
		await sock.next();
		await editAuthedAttachments((a) => ({ ...a, opened: a.opened - 11_000 }));
		await runDurableObjectAlarm(bridgeStub());
		expect((await sock.closedWithin()).code).toBe(4001);
	});

	it("one authenticated socket at a time: a new Mac connection replaces the old one", async () => {
		const first = await connectMac();
		const second = await connectMac();
		const closed = await first.sock.closedWithin();
		expect(closed.code).toBe(4000);
		serve(second.sock, () => ({ text: "from the new socket", is_error: false }));
		expect(await ask()).toMatchObject({ status: "ok", text: "from the new socket" });
	});

	it("unauthenticated sockets can't push the Mac off", async () => {
		const mac = await connectMac();
		const strangers = await Promise.all([openBridgeSocket(), openBridgeSocket(), openBridgeSocket(), openBridgeSocket()]);
		for (const s of strangers) await s.next();
		serve(mac.sock, () => ({ text: "undisturbed", is_error: false }));
		expect(await ask()).toMatchObject({ status: "ok", text: "undisturbed" });
		// The oldest stranger was turned away to keep at most three waiting.
		expect((await strangers[0].closedWithin()).code).toBe(1008);
	});

	it("refuses a plain HTTP request to /bridge", async () => {
		const response = await SELF.fetch(`${ORIGIN}/bridge`, { headers: { "CF-Connecting-IP": randomIp() } });
		expect(response.status).toBe(426);
	});
});

describe("request/reply", () => {
	it("forwards a signed request carrying the tool, args, app label and client id, and returns the reply", async () => {
		const mac = await connectMac();
		const pending = bridgeStub().relay(
			{ tool: "dexter_memory_search", args: { query: "tracklist" }, app: "claude_code", clientId: "https://claude.ai/oauth/x" },
			{ timeoutMs: 3000 },
		);
		const req = await readRequest(mac.sock);
		expect(req.conn).toBe(mac.conn);
		expect(req.tool).toBe("dexter_memory_search");
		expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(req.nonce).toMatch(/^[0-9a-f]{32}$/);
		expect(JSON.parse(req.body)).toEqual({ args: { query: "tracklist" }, app: "claude_code", client_id: "https://claude.ai/oauth/x" });
		expect(req.body).toBe(canonicalJson(JSON.parse(req.body)));
		mac.sock.send(await replyFrame(req, { text: "found it", is_error: false }));
		expect(await pending).toEqual({ status: "ok", text: "found it", isError: false });
	});

	it("keeps concurrent requests apart by request id", async () => {
		const mac = await connectMac();
		const a = ask("first");
		const b = ask("second");
		const reqA = await readRequest(mac.sock);
		const reqB = await readRequest(mac.sock);
		expect(reqA.id).not.toBe(reqB.id);
		// Answer in the opposite order.
		mac.sock.send(await replyFrame(reqB, { text: `re: ${JSON.parse(reqB.body).args.question}`, is_error: false }));
		mac.sock.send(await replyFrame(reqA, { text: `re: ${JSON.parse(reqA.body).args.question}`, is_error: false }));
		expect(await a).toMatchObject({ text: "re: first" });
		expect(await b).toMatchObject({ text: "re: second" });
	});

	it("passes the Mac's is_error through", async () => {
		const mac = await connectMac();
		serve(mac.sock, () => ({ text: "withheld", is_error: true }));
		expect(await ask()).toEqual({ status: "ok", text: "withheld", isError: true });
	});

	it("times out when the Mac doesn't answer, and drops a late reply without dropping the socket", async () => {
		const mac = await connectMac();
		const pending = bridgeStub().relay({ tool: "dexter_queue", args: {}, app: "claude", clientId: "c" }, { timeoutMs: 150 });
		const req = await readRequest(mac.sock);
		expect(await pending).toEqual({ status: "timeout" });
		mac.sock.send(await replyFrame(req, { text: "too late", is_error: false }));
		await sleep(100);
		serve(mac.sock, () => ({ text: "next one works", is_error: false }));
		expect(await ask()).toMatchObject({ status: "ok", text: "next one works" });
	});

	it("never waits longer than 55 seconds, whatever the caller asks for", async () => {
		const mac = await connectMac();
		const started = Date.now();
		const pending = bridgeStub().relay({ tool: "dexter_queue", args: {}, app: "claude", clientId: "c" }, { timeoutMs: 10 });
		await readRequest(mac.sock);
		expect(await pending).toEqual({ status: "timeout" });
		expect(Date.now() - started).toBeLessThan(2000);
	});
});

describe("asleep", () => {
	it("answers 'asleep' at once when no Mac is connected", async () => {
		const started = Date.now();
		expect(await ask()).toEqual({ status: "asleep" });
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("answers 'asleep' at once when the Mac's socket has gone quiet", async () => {
		const mac = await connectMac();
		await editAuthedAttachments((a) => ({ ...a, last: Date.now() - 60_000 }));
		const started = Date.now();
		expect(await ask()).toEqual({ status: "asleep" });
		expect(Date.now() - started).toBeLessThan(1000);
		mac.sock.ws.close();
	});

	it("a text 'ping' is answered 'pong' and keeps the socket fresh", async () => {
		const mac = await connectMac();
		await editAuthedAttachments((a) => ({ ...a, last: Date.now() - 60_000 }));
		mac.sock.send("ping");
		expect(await mac.sock.next()).toBe("pong");
		serve(mac.sock, () => ({ text: "awake", is_error: false }));
		expect(await ask()).toMatchObject({ status: "ok", text: "awake" });
	});

	it("a request in flight when the socket closes answers 'asleep' right away", async () => {
		const mac = await connectMac();
		const pending = bridgeStub().relay({ tool: "dexter_queue", args: {}, app: "claude", clientId: "c" }, { timeoutMs: 3000 });
		await readRequest(mac.sock);
		const started = Date.now();
		mac.sock.ws.close(1000, "lid closed");
		expect(await pending).toEqual({ status: "asleep" });
		expect(Date.now() - started).toBeLessThan(1500);
	});

	it("an MCP tool call says DEXTER is asleep", async () => {
		const result = await callTool("dexter_whats_live");
		expect(result.isError).toBe(true);
		expect(result.text).toBe(ASLEEP_TEXT);
	});
});

describe("replay and tampering", () => {
	async function expectRefused(mac: { sock: { closedWithin: () => Promise<{ code: number }> } }, pending: Promise<unknown>) {
		expect((await mac.sock.closedWithin()).code).toBe(1008);
		expect(await pending).toEqual({ status: "dropped" });
	}

	it("refuses a reused nonce", async () => {
		const mac = await connectMac();
		const first = ask("one");
		const reqA = await readRequest(mac.sock);
		const replyA = await replyFrame(reqA, { text: "a", is_error: false });
		mac.sock.send(replyA);
		expect(await first).toMatchObject({ status: "ok" });

		const second = ask("two");
		const reqB = await readRequest(mac.sock);
		const reusedNonce = JSON.parse(replyA.msg).nonce as string;
		mac.sock.send(await replyFrame(reqB, { text: "b", is_error: false }, { nonce: reusedNonce }));
		await expectRefused(mac, second);
	});

	it("refuses a timestamp outside ±60 s, either way", async () => {
		for (const skew of [-120, 120]) {
			const mac = await connectMac();
			const pending = ask();
			const req = await readRequest(mac.sock);
			mac.sock.send(await replyFrame(req, { text: "x", is_error: false }, { ts: nowSeconds() + skew }));
			await expectRefused(mac, pending);
		}
	});

	it("refuses a reply bound to a different request (swapped request nonce / body hash)", async () => {
		const mac = await connectMac();
		const a = ask("aaa");
		const b = ask("bbb");
		const reqA = await readRequest(mac.sock);
		const reqB = await readRequest(mac.sock);
		mac.sock.send(await replyFrame(reqA, { text: "x", is_error: false }, { req_nonce: reqB.nonce, req_body_sha256: await sha256Hex(reqB.body) }));
		expect((await mac.sock.closedWithin()).code).toBe(1008);
		expect(await a).toEqual({ status: "dropped" });
		expect(await b).toEqual({ status: "dropped" });
	});

	it("refuses a reply whose body hash alone is wrong", async () => {
		const mac = await connectMac();
		const pending = ask();
		const req = await readRequest(mac.sock);
		mac.sock.send(await replyFrame(req, { text: "x", is_error: false }, { req_body_sha256: await sha256Hex(req.body + " ") }));
		await expectRefused(mac, pending);
	});

	it("refuses a reply whose request nonce alone is wrong", async () => {
		const mac = await connectMac();
		const pending = ask();
		const req = await readRequest(mac.sock);
		mac.sock.send(await replyFrame(req, { text: "x", is_error: false }, { req_nonce: randomHex(16) }));
		await expectRefused(mac, pending);
	});

	it("refuses an otherwise perfect reply that claims the Worker-to-Mac direction", async () => {
		const mac = await connectMac();
		const pending = ask();
		const req = await readRequest(mac.sock);
		mac.sock.send(await replyFrame(req, { text: "x", is_error: false }, { dir: "w2m" as "m2w" }));
		await expectRefused(mac, pending);
	});

	it("refuses a frame changed after signing", async () => {
		const mac = await connectMac();
		const pending = ask();
		const req = await readRequest(mac.sock);
		const frame = await replyFrame(req, { text: "the real answer", is_error: false });
		mac.sock.send({ ...frame, msg: frame.msg.replace("the real answer", "a forged answer") });
		await expectRefused(mac, pending);
	});

	it("refuses a frame signed with the wrong key", async () => {
		const mac = await connectMac();
		const pending = ask();
		const req = await readRequest(mac.sock);
		mac.sock.send(await replyFrame(req, { text: "x", is_error: false }, {}, WRONG_SECRET));
		await expectRefused(mac, pending);
	});

	it("refuses the Worker's own request reflected back (direction is signed)", async () => {
		const mac = await connectMac();
		const pending = ask();
		const raw = await mac.sock.next();
		mac.sock.send(raw);
		await expectRefused(mac, pending);
	});

	it("refuses an unknown version, outside or inside the signature", async () => {
		{
			const mac = await connectMac();
			const pending = ask();
			const req = await readRequest(mac.sock);
			mac.sock.send({ ...(await replyFrame(req, { text: "x", is_error: false })), v: "v2" });
			await expectRefused(mac, pending);
		}
		{
			const mac = await connectMac();
			const pending = ask();
			const req = await readRequest(mac.sock);
			mac.sock.send(await replyFrame(req, { text: "x", is_error: false }, { v: "v2" as "v1" }));
			await expectRefused(mac, pending);
		}
	});

	it("refuses a reply naming a different tool or connection", async () => {
		for (const overrides of [{ tool: "dexter_queue" as const }, { conn: randomHex(16) }]) {
			const mac = await connectMac();
			const pending = ask();
			const req = await readRequest(mac.sock);
			mac.sock.send(await replyFrame(req, { text: "x", is_error: false }, overrides));
			await expectRefused(mac, pending);
		}
	});

	it("a request the Worker sends verifies under the shared key and nowhere else", async () => {
		const mac = await connectMac();
		const pending = ask();
		const raw = JSON.parse(await mac.sock.next()) as Json;
		expect(raw.mac).toBe(await hmac(await key(), raw.msg));
		expect(raw.mac).not.toBe(await hmac(await key(WRONG_SECRET), raw.msg));
		// sealFrame signs exactly the bytes it sends.
		const resealed = await sealFrame(await key(), JSON.parse(raw.msg));
		expect(resealed.msg).toBe(raw.msg);
		mac.sock.ws.close();
		await pending;
	});
});
