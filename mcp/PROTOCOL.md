# Bridge wire protocol v1 (Worker side)

How the Mac DEXTER (`dexter/mcp_bridge.py`) and this Worker's `Bridge` Durable Object talk.
The code is the source of truth: `src/protocol.ts` (encoding, MAC, checks) and `src/bridge.ts`
(socket handling). If this file and the code disagree, the code wins: fix this file.

**Status:** verified only offline, by `test/bridge.test.ts` playing the Mac's part with the same
module. It has never talked to the real Mac client and never run on the live Worker. The Mac
side is being written separately. Every point below marked **[reconcile]** is a choice made here
that the Mac side has to match, or argue against.

## 1. Transport

- The Mac dials `wss://mcp.iiiglobe.com/bridge`. Nothing on the Mac listens.
- WebSocket text frames only, UTF-8. A binary frame closes the socket (1003). A message longer
  than 524,288 characters closes it (1009).
- Every request to `/bridge` costs one unit of a per-IP budget: 10 a minute. Over that, the
  answer is HTTP 429 with `Retry-After`. Reconnect with backoff.
- If `BRIDGE_SECRET` is missing or doesn't decode to 32 bytes, `/bridge` answers HTTP 503 and
  never upgrades.

## 2. The secret and the key **[reconcile]**

- `BRIDGE_SECRET` is the base64 text of 32 random bytes: the value `dexter mcp secret --new`
  prints, pasted into `wrangler secret put BRIDGE_SECRET`.
- **The HMAC key is the 32 decoded bytes, not the base64 text.** Python:
  `key = base64.b64decode(open(path).read().strip())`, then `assert len(key) == 32`.
- The Worker accepts the standard or URL-safe alphabet, with or without `=` padding, and ignores
  surrounding whitespace. Anything that doesn't decode to exactly 32 bytes leaves the bridge shut.
- MAC = HMAC-SHA256(key, UTF-8 bytes of the input), written as **64 lowercase hex characters**.
- Every MAC comparison is constant-time (`hmac.compare_digest` on the Mac).
- Test vector: key = `bytes(range(32))` (base64 `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=`),
  input `v1|connect|ab|cd`, MAC = `335122ea6d795b250a84118bf741253ee6d931ff7d5c0aa4ca7dc64b1bfd9fb4`.

## 3. Connect handshake

1. The Worker accepts the socket and sends at once:
   `{"v":"v1","type":"challenge","conn":"<32 hex>","challenge":"<64 hex>","ts":<unix seconds>}`
   `conn` is this connection's id (16 random bytes). `challenge` is 32 random bytes, used once.
2. The Mac answers within **10 seconds**:
   `{"v":"v1","type":"connect","conn":"<same conn>","mac":"<hex HMAC(key, "v1|connect|" + challenge + "|" + conn)>"}`
3. If it checks out, the Worker sends:
   `{"v":"v1","type":"ready","conn":"<conn>","mac":"<hex HMAC(key, "v1|ready|" + challenge + "|" + conn)>"}`
   The `ready` MAC proves the Worker holds the secret too. **[reconcile]** The Mac should check it
   before it processes any frame (spec: "only after accept does the Mac process frames").
4. Anything else closes the socket with code **1008**: wrong MAC, wrong `conn`, a `v` other than
   `"v1"` (reason `unsupported version`), or not JSON. Past the 10-second deadline: code **4001**.
   A socket gets one attempt. There is no retry on the same socket.

**One authenticated socket at a time.** When a new socket completes the handshake, the old
authenticated socket is closed with code **4000** (`replaced by a newer connection`). Requests in
flight on it answer "asleep". A socket that hasn't authenticated can never displace one that has.
At most 3 unauthenticated sockets wait at once: a 4th pushes out the oldest (1008).

## 4. Keep-alive and "asleep" **[reconcile]**

- The Mac sends the text message `ping` every **20 seconds**. The Worker answers `pong`. The
  runtime answers this without waking the Durable Object.
- Python `websockets`' own `ping_interval` sends protocol-level ping frames. Those keep TCP alive
  but **the Worker can't see them**. The text `ping` is what counts.
- An authenticated socket that hasn't been heard from (a `ping` or any message) for **50 seconds**
  is stale. Tool calls then answer "DEXTER is asleep" immediately. So does having no socket at all.
- If the socket closes while a request is in flight, that request answers "asleep" immediately.

## 5. Frames (after the handshake)

Every request and reply travels in an envelope:

```
{"v":"v1","type":"frame","msg":"<signed text>","mac":"<hex HMAC(key, msg)>"}
```

- `msg` is a **string**. It holds the JSON of the signed message. The MAC is over the exact UTF-8
  bytes of that string.
- **The receiver checks the MAC over the bytes it received, before it parses `msg`, and never
  re-serializes.** So Python and JS don't have to agree on JSON formatting. "Canonical JSON bytes
  signed once" means exactly this.
- The sender should still produce canonical JSON: keys sorted, separators `,` and `:` with no
  spaces, and only strings, booleans, integers and null. That keeps frames reproducible and easy
  to diff. In Python: `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
  The Worker never re-encodes a received `msg`, so `ensure_ascii` doesn't affect verification.
- Check order on receipt: envelope `v == "v1"` → MAC → parse `msg` → inner `v == "v1"` → the
  field checks below. An unknown version is refused.

### 5.1 Request (Worker → Mac), `msg` fields

| field | value |
|---|---|
| `v` | `"v1"` |
| `dir` | `"w2m"` |
| `conn` | this connection's id (from the challenge) |
| `id` | request id, a fresh random UUID (lowercase, 36 chars). Never the MCP client's JSON-RPC id |
| `nonce` | 16 random bytes, 32 lowercase hex |
| `ts` | integer unix seconds |
| `tool` | `dexter_ask`, `dexter_whats_live`, `dexter_queue` or `dexter_memory_search` |
| `body` | a **string** holding canonical JSON: `{"app":"claude"\|"claude_code"\|"chatgpt","args":{...},"client_id":"<OAuth client id>"}` |

`args` by tool, validated by the Worker before sending (the Mac validates again):
- `dexter_ask`: `{"question": string, 1-4000 chars, trimmed}`
- `dexter_whats_live`: `{}`
- `dexter_queue`: `{}`
- `dexter_memory_search`: `{"query": string, 1-500 chars, trimmed}`. Never sent with `app = "chatgpt"`.

The Mac should check: `dir == "w2m"`, `conn` equals its current connection, `|now - ts| <= 60`,
`nonce` not seen in the last 120 s or more, `tool` in its fixed handler table. It should take
nothing else from the Worker on trust: no names, grades or system text.

### 5.2 Reply (Mac → Worker), `msg` fields

| field | value |
|---|---|
| `v` | `"v1"` |
| `dir` | `"m2w"` |
| `conn` | same connection id |
| `id` | the request's `id` |
| `nonce` | a **fresh** 16 random bytes, 32 lowercase hex |
| `ts` | integer unix seconds |
| `tool` | the request's `tool` |
| `req_nonce` | the request's `nonce` |
| `req_body_sha256` | lowercase hex SHA-256 of the UTF-8 bytes of the request's `body` string, exactly as received |
| `body` | a **string** holding JSON: `{"text": string, "is_error": boolean}`. Extra keys are ignored |

The Worker checks: MAC; `dir == "m2w"`; `conn` is the current authenticated connection; `id`
matches a request still waiting; `tool`, `req_nonce` and `req_body_sha256` match that request
(constant-time); `|now - ts| <= 60`; `nonce` unseen within **180 s** (kept in Durable Object
storage, so it survives eviction); `body` parses to the shape above.

- A reply that fails any of these **closes the socket (1008)**. Every request in flight on it
  answers "connection dropped". The Mac should reconnect.
- One exception: a correctly signed reply whose `id` is no longer waiting (it timed out) is
  dropped quietly and the socket stays up.
- The Worker waits **55 seconds** for a reply, then the tool answers "didn't answer within 55
  seconds". At most 16 requests are in flight at once. Past that, "busy".

### 5.3 What the Mac never receives

- No unsigned frames.
- No plain `pong` except in answer to `ping`.
- No error frames. A request the Mac refuses (bad MAC, stale) should simply not be answered. The
  Worker times out. The Mac may also close the socket.

## 6. What the MCP caller sees

| Bridge outcome | Tool result (`isError`) |
|---|---|
| reply | the reply's `text`, with `isError = is_error` |
| no socket / stale / closed mid-call / replaced | "DEXTER is asleep: the Mac isn't connected right now…" (true) |
| 55 s timeout | "DEXTER didn't answer within 55 seconds…" (true) |
| bad reply frame | "DEXTER's connection dropped while answering…" (true) |
| 16 in flight | "DEXTER is handling other requests…" (true) |
| BRIDGE_SECRET unusable | "DEXTER's bridge isn't set up yet…" (true) |

## 7. Constants

| name | value |
|---|---|
| timestamp window | ±60 s |
| nonce memory (Worker) | 180 s (spec minimum 120 s) |
| handshake deadline | 10 s |
| ping interval (Mac) | 20 s |
| stale after | 50 s of silence |
| reply timeout | 55 s |
| max message | 524,288 chars |
| max unauthenticated sockets | 3 |
| max requests in flight | 16 |
