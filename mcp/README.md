# DEXTER MCP server (DEX-001)

DEXTER's memory and tools as one remote MCP server on Cloudflare Workers. Claude, ChatGPT and (later) Alexa+ and the DEXTER Core agent all connect here, so every assistant works from DEXTER's memory instead of its own.

## Set it up (about 5 minutes, all in the Cloudflare dashboard)

1. **Create the Worker from this repo.** Workers & Pages → **Create** → **Import a repository** → pick `dexter-os` → set **Root directory** to `mcp` → **Deploy**. The database (D1) and key-value store (KV) are created on the first deploy. Every push to `main` redeploys.
2. **Add two secrets.** Open the new `dexter-mcp` Worker → **Settings** → **Variables and Secrets** → **Add**, type **Secret**:
   - `ANTHROPIC_API_KEY`: your Anthropic key
   - `DEXTER_PASSPHRASE`: the same passphrase you set on the dexter-os Pages project (12+ characters)
3. **Check it.** Open `https://dexter-mcp.<your-subdomain>.workers.dev`. It should say **Online**. If it lists missing secrets, add those.
4. **Connect Claude.** claude.ai → **Settings** → **Connectors** → **Add custom connector** → URL `https://dexter-mcp.<your-subdomain>.workers.dev/mcp` → **Connect** → enter the passphrase → **Allow**.
5. **Turn on reminder pushes.** Ask Claude for "DEXTER status". It shows a private ntfy topic; subscribe to it in the ntfy app.
6. **Load STATE.md.** In Claude: "Save this as DEXTER's STATE.md" and paste or attach the file.

ChatGPT works the same way: Settings → Apps → Advanced settings → turn on **Developer mode** → **Create app** → same URL (web only).

## Tools

| Tool | What it does |
|---|---|
| `dexter_status` | Handoff note from STATE.md, reminders for the next 7 days, failed reminders, last 5 log entries |
| `dexter_log` | Append to the log (note, proof, workout, music, content, admin, backlog) |
| `dexter_remind` | Push reminder at an ISO 8601 time with offset (default timezone America/New_York) |
| `dexter_cancel_reminder` | Cancel a pending reminder by id |
| `dexter_memory_list` | List memory files (store `memory` or read-only `reference`) |
| `dexter_memory_read` | Read one memory file; ends with its sha256 |
| `dexter_memory_propose` | Save a note to `/inbox/` for review; never overwrites |
| `dexter_state_write` | Replace `/state/STATE.md`; needs the sha256 from a fresh read |

## How it's built

| Piece | Detail |
|---|---|
| MCP endpoint | `/mcp`, stateless, `createMcpHandler` from `agents/mcp/server` with `@modelcontextprotocol/server` v2. Serves 2026-07-28 clients and 2025-era clients (Alexa+) |
| Sign-in | OAuth 2.1 via `@cloudflare/workers-oauth-provider` (dynamic registration and Client ID Metadata Documents). The consent page asks for `DEXTER_PASSPHRASE`; 5 wrong tries locks that IP out for 15 minutes |
| Memory | Two Claude Managed Agents memory stores, created on first use: **DEXTER Memory** (read, propose, STATE.md) and **DEXTER Reference** (read only). Every change is versioned |
| Log and reminders | D1 database `dexter`; tables are created on first use (`schema.sql` mirrors them) |
| Reminder delivery | Cron every minute, push via ntfy. Each reminder is claimed before sending so it can't go out twice; 3 failures marks it failed |
| Model calls | None. Runs on Cloudflare's free tier plus the memory store API |

## Optional: Cloudflare Access instead of the passphrase

Create an Access for SaaS (OIDC) app with redirect URL `https://dexter-mcp.<your-subdomain>.workers.dev/callback` and a policy for your email, then add secrets `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_ISSUER` and `ALLOWED_EMAIL`. When those are set, the consent page hands off to Access sign-in instead of asking for the passphrase.

## Other settings

| Name | Purpose |
|---|---|
| `NTFY_TOPIC` | Pin your own ntfy topic instead of the generated one |
| `NTFY_SERVER`, `NTFY_TOKEN` | Self-hosted or authenticated ntfy |
| `MEMORY_STORE_ID`, `REFERENCE_STORE_ID` | Pin specific memory stores |
| `DEXTER_TZ` (var) | Timezone for display, default America/New_York |

## Develop

```bash
npm install          # .npmrc sets legacy-peer-deps for the agents package
npm test             # 25 tests in the Workers runtime, including a full OAuth round trip
npm run typecheck
npx wrangler dev     # local server on :8788 (needs a .dev.vars with the secrets)
```
