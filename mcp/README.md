# DEXTER MCP front door (DEX-001, relay build)

One MCP address, `https://mcp.iiiglobe.com/mcp`, for Claude, Claude Code and ChatGPT. Every answer
comes from the **Mac DEXTER**. This Worker is a locked door and a relay. It has no model, memory,
database or reminders of its own. When the Mac isn't connected, every tool answers "DEXTER is
asleep". There is no cached or second-hand answer.

```
Claude / ChatGPT ──OAuth──▶ Worker /mcp ──RPC──▶ Bridge (Durable Object) ◀──WebSocket── Mac DEXTER
                                                    (the Mac dials out; nothing on the Mac listens)
```

**Status:** built and tested offline only (`npm test`). Not deployed from this branch. It has
never talked to the real Mac bridge. The live Worker at mcp.iiiglobe.com is still the 10/17 build.

## Tools (all read-only)

| Tool | What it does | Claude | Claude Code | ChatGPT |
|---|---|---|---|---|
| `dexter_ask` | Ask DEXTER a question. It answers from its memory, rules and read-only tools (up to ~55 s) | yes | yes | yes (no calendar: the Mac switches it off for this label) |
| `dexter_whats_live` | What DEXTER can do right now, plus capability totals | yes | yes | yes |
| `dexter_queue` | Open proposals and recent background requests (id/kind/status) | yes | yes | yes |
| `dexter_memory_search` | Search what DEXTER has learned | yes | yes | **not offered** |

- Every tool is annotated `readOnlyHint: true`. None can write, save, approve or run anything.
- A tool an app isn't offered is neither listed nor callable.
- Which app a connection belongs to is decided at sign-in. It comes from the Client ID Metadata
  Document host or the registered redirect URI, never from the name the app gives itself.
- Apps DEXTER doesn't recognise are refused at the consent page. Local (loopback) apps that don't
  identify as Claude get the restricted ChatGPT policy (Codex CLI, for example).
- The Mac re-checks everything on its side. The Worker's policy is the first layer, not the only
  one.

## Set it up (his hands)

All `wrangler` lines run in your own Terminal, from this `mcp/` folder, signed in to the Cloudflare
account that owns `dexter-mcp`. Not inside a Claude Code session: transcripts are stored.

1. **Generate the bridge secret on the Mac.** `dexter mcp secret --new` prints it once.
2. **Set the two secrets** (each command prompts for the value; paste, Enter):
   ```
   npx wrangler secret put DEXTER_PASSPHRASE
   npx wrangler secret put BRIDGE_SECRET
   ```
   `DEXTER_PASSPHRASE`: four or more random words, its own. Never reused from anywhere else.
3. **Deploy:** `npx wrangler deploy`. This creates the Bridge and AuthLimiter Durable Objects
   (migration `v1`) and drops the old D1 binding and cron. The custom domain stays as it is, and
   `workers_dev` is off, so the workers.dev address stops answering.
4. **Exempt the MCP paths from bot blocking**, on mcp.iiiglobe.com only. In Cloudflare: the
   iiiglobe.com zone, then Security, then WAF, then Custom rules, then Create rule. Action **Skip**,
   with "All Super Bot Fight Mode rules" and "Bot Fight Mode / AI bots" (whichever the zone has)
   ticked. Expression:
   ```
   (http.host eq "mcp.iiiglobe.com" and (http.request.uri.path eq "/mcp" or starts_with(http.request.uri.path, "/.well-known/oauth-") or http.request.uri.path eq "/authorize" or http.request.uri.path eq "/token"))
   ```
   Not yet in that list, and worth deciding: `/register` (needed only while connecting an app by
   dynamic registration) and `/bridge` (the Mac's own connection, which a bot challenge could
   block).
5. **Check it.** Open `https://mcp.iiiglobe.com`. It should say **Online**. If it lists missing
   secrets, add those.
6. **Start the Mac bridge** (Part A: `com.dexter.mcpbridge`).
7. **Connect an app.** New connections are closed by default. Open them only while connecting:
   ```
   npx wrangler secret put ALLOW_CLIENT_REGISTRATION     # type: true
   ```
   - **Claude:** claude.ai, then Settings, then Connectors, then Add custom connector. URL
     `https://mcp.iiiglobe.com/mcp`. Connect, enter the passphrase, Allow. Mobile uses the same
     connector once it's added.
   - **Claude Code:** `claude mcp add --transport http dexter https://mcp.iiiglobe.com/mcp`, then
     `/mcp` in a session to sign in.
   - **ChatGPT** (only if the plan allows custom MCP servers): Settings, then Apps, then Advanced,
     then Developer mode, then Create app. Same URL, web only.

   Then close new connections again:
   ```
   npx wrangler secret delete ALLOW_CLIENT_REGISTRATION
   ```
   Apps already connected keep working.

To disconnect one app, remove the connector in that app. Its refresh token stops being used and
dies after 30 idle days. Revocation is served at `/token` (RFC 7009) for apps that call it.

**Emergency stop:** `npx wrangler secret delete BRIDGE_SECRET`. The bridge shuts at once: the
Mac can't reconnect, and every tool answers that the bridge isn't set up. It needs no deploy.
Stopping the Mac's `com.dexter.mcpbridge` job has the same effect from the other end.

## How it's built

| Piece | Detail |
|---|---|
| MCP endpoint | `/mcp`, stateless, `createMcpHandler` (agents 0.28) with `@modelcontextprotocol/server` 2.0. Serves 2026-07-28 clients and 2025-era clients (`initialize` handshake, no `Mcp-Method`/`Mcp-Name` needed) |
| Bridge | Durable Object `Bridge`, one instance. Holds the Mac's socket with the hibernation API, challenge handshake, signed frames, nonce cache in DO storage, `ping`/`pong` auto-response, 55 s reply timeout. Wire format: [PROTOCOL.md](PROTOCOL.md) |
| Sign-in | OAuth 2.1 via `@cloudflare/workers-oauth-provider` 1.2.3. PKCE S256 only. `iss` on every authorization response (RFC 9207). Every token is bound to exactly `https://mcp.iiiglobe.com/mcp` (RFC 8707). Access tokens last 1 hour. Refresh tokens rotate on every use and die after 30 idle days. `offline_access` is granted when an app asks for it. Revocation is at `/token` |
| Consent | The passphrase page shows the app's name, where access goes (redirect host) and exactly what it can read. Five wrong passphrases from one IP lock it out for 15 minutes (KV counter, fails closed). Optional Cloudflare Access sign-in instead, below |
| Redirect URIs | Exact string match against the registered list. The one exception, per RFC 8252 and needed by Claude Code: a loopback redirect (`http://localhost`/`127.0.0.1`) may use any port |
| Client ID Metadata Documents | Fetched only over https, from exactly `claude.ai` or `chatgpt.com`, refused before any fetch otherwise. The library caps each fetch at 5 KB and 10 s and refuses non-public addresses (`global_fetch_strictly_public`). New sign-ins by URL follow `ALLOW_CLIENT_REGISTRATION`. Apps already connected that way keep refreshing |
| Registration | Closed unless `ALLOW_CLIENT_REGISTRATION` is exactly `true` (any case). Unset, `false`, a typo or anything else keeps it closed and stops advertising it |
| Rate limits | Durable Object counters (exact, single-threaded), checked before anything else. Sign-in pages and registration: 10 a minute per IP and 60 a minute in total. `/token`: 30 a minute per IP. `/bridge`: 10 a minute per IP. If the limiter can't be reached, the request is refused |
| Hostnames | Only `https://mcp.iiiglobe.com` answers (anything else gets 421). `workers_dev: false`, `preview_urls: false` |
| Storage | `OAUTH_KV` (grants, tokens, registrations, lock-out counters) and the two Durable Objects' own storage (nonces, rate counters). No D1 |

## Optional: Cloudflare Access instead of the passphrase

Create an Access for SaaS (OIDC) app with redirect URL `https://mcp.iiiglobe.com/callback` and a
policy for your email. Then add the secrets `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`,
`ACCESS_ISSUER` and `ALLOWED_EMAIL`. Once those are set, the consent page hands off to an Access
sign-in instead of asking for the passphrase. Tokens issued earlier carry no email, so they stop
working when `ALLOWED_EMAIL` is set: reconnect each app.

## Settings

| Name | Kind | Purpose |
|---|---|---|
| `DEXTER_PASSPHRASE` | secret, required | The consent-page passphrase, 12+ characters |
| `BRIDGE_SECRET` | secret, required | 32-byte base64 shared with the Mac bridge (`dexter mcp secret --new`) |
| `ALLOW_CLIENT_REGISTRATION` | secret, normally unset | `true` only while connecting an app |
| `ACCESS_*`, `ALLOWED_EMAIL` | secrets, optional | Cloudflare Access sign-in |

## Develop

```bash
npm install          # .npmrc sets legacy-peer-deps for the agents package
npm test             # offline, in the Workers runtime: OAuth round trips, the bridge protocol, rate limits
npm run typecheck    # wrangler needs Node 22+
```

The Worker only answers on `https://mcp.iiiglobe.com`, so `wrangler dev` on localhost answers 421.
Tests use that origin directly. `.dev.vars.example` lists the local variables. Never commit
`.dev.vars`.
