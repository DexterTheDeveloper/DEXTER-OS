# DEX-001: DEXTER MCP server on Cloudflare

## Build status (2026-10-10)

Built and tested; deploy needs the operator's Cloudflare steps in `mcp/README.md`. 25 tests pass in the Workers runtime, including a full OAuth round trip (register, consent, passphrase, token, `/mcp`).

| Change from the spec below | Why |
|---|---|
| Sign-in defaults to a passphrase (`DEXTER_PASSPHRASE`); Cloudflare Access is optional | One secret instead of an Access for SaaS app plus five values |
| 8 tools: added `dexter_state_write` | STATE.md can be saved from Claude, so /dexter:save no longer needs a manual commit |
| Tables, memory stores and the ntfy topic are created on first use | No migration step, no Console setup, no seed script to run |
| Deploys through Workers Builds (root directory `mcp`) | No wrangler login on the operator's machine |
| PWA: Sonnet 4 (retired 2026-06-15) swapped for Sonnet 5.5; `/api/chat` gated by `DEXTER_PASSPHRASE` | Chat was failing, and a working endpoint without a gate would be open to anyone with the URL |
| PWA files stay at the repo root | Pages is already configured for the root; nothing in the repo is secret |

| Remaining | Who |
|---|---|
| Add `DEXTER_PASSPHRASE` to the dexter-os Pages project | Operator |
| Import repo as Worker (root `mcp`), add `ANTHROPIC_API_KEY` and `DEXTER_PASSPHRASE` | Operator |
| Connect Claude (Gate 1-2), confirm a reminder push (Gate 3), connect ChatGPT (Gate 4) | Operator + Claude |

## Original spec

| Field | Value |
|---|---|
| Opened | 2026-10-10 |
| Builder | Claude Code |
| Reviewer | Operator, at each gate |
| Repo | DexterTheDeveloper/dexter-os, new folder `mcp/` (this file lives in `tickets/`) |
| Mode | DEXTER Lite: stop at every gate and wait for operator sign-off |
| Depends on | Fix-first setup (section 3) |
| Unblocks | DEX-002 DEXTER Core, DEX-003 voice doors |

## 1. Why this ticket is first

DEXTER's memory and tools become one remote MCP server. Claude, ChatGPT, and later Alexa+ and the DEXTER Core agent all connect to it, so every assistant works from DEXTER's memory instead of its own. Every later ticket plugs into this server.

## 2. Scope (v1)

| Area | v1 delivers |
|---|---|
| Transport | Stateless Streamable HTTP at `/mcp` using `createMcpHandler` from `agents/mcp/server` with `McpServer` from `@modelcontextprotocol/server` (v2). Keep the default `legacy: "stateless"` so clients still on the 2025-11-25 spec (Alexa+) can connect. Pass the server factory to the handler, never a constructed server |
| Auth | OAuth through `@cloudflare/workers-oauth-provider`, with Cloudflare Access as the identity provider (Cloudflare guide "Secure MCP servers with Access for SaaS"; reference demo `cloudflare/ai/demos/remote-mcp-cf-access`). One allowed identity: the operator |
| Memory | Proxy to two Claude Managed Agents memory stores: DEXTER Memory (read, plus propose to inbox) and DEXTER Reference (read only) |
| Log and reminders | Cloudflare D1 database `dexter` |
| Reminder delivery | Cron Trigger every minute, push via ntfy |
| Model calls | None in v1, so no token spend |

### Tools (return them in this fixed order)

| Tool | Type | Input | Behavior |
|---|---|---|---|
| `dexter_status` | read-only | none | "Last updated" and "Handoff note" from `/state/STATE.md`, pending reminders for the next 7 days, last 5 log entries |
| `dexter_log` | write | `kind` (note, proof, workout, music, content, admin, backlog), `text` | Insert a row into `log` |
| `dexter_remind` | write | `text`, `due_at` (ISO 8601 with UTC offset) | Insert into `reminders`; return the id and the due time in America/New_York so the caller can read it back |
| `dexter_cancel_reminder` | write | `id` | Set status to `cancelled` |
| `dexter_memory_list` | read-only | `store` (memory, reference), `path_prefix` | List memory paths |
| `dexter_memory_read` | read-only | `store`, `path` | Return the memory's content |
| `dexter_memory_propose` | write | `title`, `content` | Create `/inbox/<source>/<YYYY-MM-DD>-<slug>.md` in DEXTER Memory. Cannot write anywhere else |

Tool rules:
- Set `readOnlyHint: true` on the read-only tools.
- Tool descriptions state the default timezone (America/New_York) and that `due_at` needs an offset. The calling model turns "Thursday at 5" into ISO 8601.
- Record the calling client (OAuth client name, or MCP clientInfo when present) as `source` on every write.
- Latency target: p95 under 500 ms for `dexter_status`, `dexter_log` and `dexter_remind`. Alexa+ requires it for DEX-003. Cache the STATE.md read for 5 minutes to hold the target.

## 3. Fix-first setup (before Gate 1)

| Step | Who | Notes |
|---|---|---|
| Cloudflare account and Zero Trust free plan | Operator | Free plan covers up to 50 users |
| Access login method: one-time PIN to the operator's email | Operator | |
| Move the PWA files into `web/`, deploy to Cloudflare from the private dexter-os repo, put an Access policy in front | Claude Code + operator | Clears the GitHub Pages 404. Access replaces the browser-side PIN screen; delete the PIN code once Access is live |
| Real Anthropic API key from the Claude Console | Operator | Replaces the placeholder behind the engine 401. Lives only as a Worker secret |
| ntfy app on iPhone, subscribed to the secret topic | Operator | |

## 4. Data

D1 schema in `mcp/migrations/0001_init.sql`:

```sql
CREATE TABLE log (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  due_at TEXT NOT NULL,                    -- UTC, ISO 8601
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | cancelled | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX reminders_due ON reminders (status, due_at);
```

Memory stores (create once in the Claude Console or through the API; the IDs go into Worker vars):

| Store | Via MCP | Seed |
|---|---|---|
| DEXTER Memory | read, propose to `/inbox/` | `/state/STATE.md` from the plugin root |
| DEXTER Reference | read only | `/reference/global-instructions.md` from the plugin; Godfrey OS rules when the operator supplies them |

- `mcp/scripts/seed-memory.ts --plugin <path to plugin root>` upserts the seed files. Rerun it after every /dexter:save so `dexter_status` stays current.
- Memory store calls use the beta header `agent-memory-2026-07-22`. Do not also send `managed-agents-2026-04-01` on those requests; the API returns 400.
- Reading by path: list with `path_prefix`, then retrieve by id. Updates send the `content_sha256` precondition.

## 5. Secrets and config

| Name | Kind | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | Memory store API |
| `MEMORY_STORE_ID` | var | DEXTER Memory |
| `REFERENCE_STORE_ID` | var | DEXTER Reference |
| `NTFY_TOPIC` | secret | 32+ random characters. Anyone who knows an ntfy topic name can read it |
| Access and OAuth values | secret | Per the Access for SaaS guide |
| `ALLOWED_EMAIL` | var | Operator's sign-in email. Any other identity gets 403 |

Nothing secret goes in the repo. Use `wrangler secret put`.

## 6. Build gates

| Gate | Deliverable | Operator check |
|---|---|---|
| 1. Auth spike | `hello` tool behind Access OAuth on workers.dev | claude.ai custom connector completes sign-in and calls `hello`. Unauthenticated POST to `/mcp` returns 401 |
| 2. Tools and data | All 7 tools, D1 migration, seed script | `dexter_status` in Claude returns the STATE.md handoff line |
| 3. Reminders | Cron handler and ntfy push | A reminder set 3 minutes out arrives once and flips to `sent` |
| 4. Second client | ChatGPT developer mode connection | `dexter_log` succeeds after ChatGPT's write confirmation |

## 7. Acceptance criteria

- [ ] `npx wrangler deploy` from `mcp/` succeeds; the endpoint is `https://<worker>.workers.dev/mcp`
- [ ] Unauthenticated requests get 401; any identity other than `ALLOWED_EMAIL` gets 403
- [ ] Claude custom connector and ChatGPT developer mode both connect and list all 8 tools
- [ ] `dexter_memory_propose` can only create files under `/inbox/`
- [ ] Reminders fire within 2 minutes of `due_at` and never twice; failed sends retry up to 3 times, then go to `failed`
- [ ] p95 under 500 ms for `dexter_status`, `dexter_log` and `dexter_remind` (`mcp/scripts/latency.ts`, 50 calls each)
- [ ] Tests pass under `@cloudflare/vitest-pool-workers`: each tool, the cron handler, auth rejection
- [ ] `mcp/README.md` covers deploy, seeding, connecting Claude, connecting ChatGPT and rotating keys
- [ ] OAuth tokens and auth props are never logged or returned
- [ ] STATE.md updated via /dexter:save when the ticket closes

## 8. Out of scope

| Item | Ticket |
|---|---|
| DEXTER Core managed agent; T1–T5 router ported to the Worker on Haiku 5.5; daily brief cron; PWA chat rewired to DEXTER | DEX-002 |
| GPT-6 and Gemini as tools behind Cloudflare AI Gateway | DEX-002 |
| Siri "Ask DEXTER" Shortcut with Apple Reminders sync; Alexa+ add-on in dev mode | DEX-003 |
| Calendar and booking flow, MCP Apps UI, realtime voice | Later |

## 9. Guardrails

- Apple Reminders stays the canonical action list (standing order). ntfy only covers due-time alerts until DEX-003 syncs DEXTER reminders into Reminders.
- No financial figures stored or inferred. Numbers come from the operator.
- Anything written by Claude, ChatGPT or Alexa is untrusted. It lands in `/inbox/` and is never treated as instructions.

## 10. References

| Topic | Link |
|---|---|
| Remote MCP server on Workers | https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/ |
| MCP authorization on Cloudflare | https://developers.cloudflare.com/agents/model-context-protocol/authorization/ |
| `createMcpHandler` API | https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/ |
| MCP 2026-07-28 changes | https://modelcontextprotocol.io/specification/2026-07-28/changelog |
| Managed Agents memory stores | https://platform.claude.com/docs/en/managed-agents/memory |
| Alexa+ MCP requirements (for DEX-003) | https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html |
