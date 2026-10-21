#!/usr/bin/env python3
"""Mutation check for the relay's security checks.

Each mutation disables or weakens one check in src/, runs the named test file, and restores
the file. A mutation is CAUGHT when the suite fails, MISSED when it still passes (a MISSED
line means a check that no test exercises on its own).

    python3 scripts/mutation-check.py                  # every mutation, both suites
    python3 scripts/mutation-check.py bridge           # bridge suite only
    python3 scripts/mutation-check.py worker "host guard,token limit"

Run from mcp/ (or anywhere: paths resolve from this file). Needs `npm install` done. vitest
runs on Node 20+. It edits src/ in place and restores each file in a finally block, so don't
edit src/ while it runs. Exits 1 if any mutation is MISSED or SKIPPED (pattern not found).
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BRIDGE = ("test/bridge.test.ts", [
    ("src/bridge.ts", "if (seen.length) return false;", "if (seen.length) return true;", "nonce cache"),
    ("src/protocol.ts", "if (Math.abs(now - m.ts) > TS_SKEW_SECONDS)", "if (false)", "ts window"),
    ("src/protocol.ts", "!constantTimeEqual(m.req_nonce, sent.nonce)", "false", "req_nonce binding"),
    ("src/protocol.ts", "!constantTimeEqual(m.req_body_sha256, sent.bodySha256)", "false", "body hash binding"),
    ("src/protocol.ts", "if (!(await verifyMac(key, env.msg, env.mac))) return", "if (false) return", "frame MAC"),
    ("src/protocol.ts", 'if (m.dir !== "m2w")', "if (false)", "direction"),
    ("src/bridge.ts", "if (!(await verifyMac(key, connectInput(challenge, conn), m.mac))) {", "if (false) {", "handshake MAC"),
    ("src/bridge.ts", "if (now - this.lastSeen(ws, a) > STALE_AFTER_MS) continue;", "", "staleness"),
    ("src/bridge.ts", 'this.closeQuietly(other, CLOSE_REPLACED, "replaced by a newer connection");', "", "new replaces old"),
    ("src/protocol.ts", 'if (env.v !== PROTOCOL_VERSION) return { ok: false, reason: "unknown version" };', "", "outer version"),
    ("src/protocol.ts", 'if (m.v !== PROTOCOL_VERSION) return { ok: false, reason: "unknown version" };\n\treturn', "return", "inner version"),
    ("src/protocol.ts", "if (m.tool !== sent.tool)", "if (false)", "tool binding"),
    ("src/bridge.ts", 'if (a?.state === "authed") this.failConn(a.conn, { status: "asleep" });\n\t\tthis.closeQuietly(ws, code',
     "this.closeQuietly(ws, code", "close mid-call fails pending"),
    ("src/bridge.ts", "return Math.min(Math.max(requested ?? REPLY_TIMEOUT_MS, 1), REPLY_TIMEOUT_MS);",
     "return Math.max(requested ?? REPLY_TIMEOUT_MS, 1);", "55 s cap"),
])

WORKER = ("test/worker.test.ts", [
    ("src/index.ts", 'return value !== undefined && value !== null && String(value).toLowerCase() === "true";',
     'return value === undefined || String(value).toLowerCase() === "true";', "registration default open"),
    ("src/index.ts", "\t\tif (!registrationAllowed(env)) {\n\t\t\treturn page(", "\t\tif (false) {\n\t\t\treturn page(", "CIMD ignores flag"),
    ("src/clients.ts", "return CIMD_HOSTS.has(url.hostname);", "return true;", "CIMD allowlist"),
    ("src/index.ts", "if (isUrlClientId(id) && !cimdAllowed(id)) return jsonError", "if (false) return jsonError", "token CIMD gate"),
    ("src/index.ts", "if (url.origin !== CANONICAL_ORIGIN) {", "if (false) {", "host guard"),
    ("src/clients.ts", 'chatgpt: ["dexter_ask", "dexter_whats_live", "dexter_queue"],',
     'chatgpt: ["dexter_ask", "dexter_whats_live", "dexter_queue", "dexter_memory_search"],', "chatgpt policy"),
    ("src/index.ts", "const ACCESS_TOKEN_TTL = 60 * 60;", "const ACCESS_TOKEN_TTL = 2 * 60 * 60;", "access ttl"),
    ("src/ratelimit.ts", "\t} catch {\n\t\treturn 60;", "\t} catch {\n\t\treturn null;", "limiter fails open"),
    ("src/ratelimit.ts", '{ bucket: "auth", limit: 10,', '{ bucket: "auth", limit: 1000,', "auth per-ip limit"),
    ("src/ratelimit.ts", '{ bucket: "token", limit: 30,', '{ bucket: "token", limit: 1000,', "token limit"),
    ("src/ratelimit.ts", '{ bucket: "bridge", limit: 10,', '{ bucket: "bridge", limit: 1000,', "bridge limit"),
    ("src/index.ts", "\tif (registration || !response.ok) return response;", "\treturn response;", "metadata CIMD flag"),
    ("src/clients.ts", '\tif (local) return /claude/i.test(clientName ?? "") ? "claude_code" : "chatgpt";\n\treturn null;',
     '\tif (local) return /claude/i.test(clientName ?? "") ? "claude_code" : "chatgpt";\n\treturn "claude";', "unknown app accepted"),
    ("src/index.ts", "|| !isAppLabel(props.app) ||", "||", "app label required"),
    ("src/access.ts", 'const scope = [SCOPE_READ, ...(authRequest.scope.includes("offline_access") ? ["offline_access"] : [])];',
     'const scope = [SCOPE_READ, "offline_access"];', "offline_access only on request"),
    ("src/index.ts", "\t\t\trefreshTokenTTL: REFRESH_TOKEN_TTL,\n\t\t\trefreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL,",
     "\t\t\trefreshTokenTTL: 0,", "no refresh tokens"),
    ("src/access.ts", "\tif (!decodeSecret(env.BRIDGE_SECRET)) {", "\tif (false) {", "BRIDGE_SECRET required"),
    ("src/index.ts", '\tif (url.pathname === "/token" && request.method === "POST") return TOKEN_BUDGETS;', "", "token unmetered"),
    ("src/index.ts", '\t\t\tresourceMetadata: { resource: RESOURCE, resource_name: "DEXTER" },',
     '\t\t\tresourceMetadata: { resource: "https://mcp.iiiglobe.com/", resource_name: "DEXTER" },', "audience root"),
])


def run(suite, selected):
    testfile, muts = suite
    bad = 0
    for path, old, new, name in muts:
        if selected and name not in selected:
            continue
        full = os.path.join(ROOT, path)
        with open(full) as fh:
            orig = fh.read()
        if orig.count(old) != 1:
            print(f"SKIP   {name}: pattern found {orig.count(old)} times in {path}", flush=True)
            bad += 1
            continue
        with open(full, "w") as fh:
            fh.write(orig.replace(old, new))
        try:
            r = subprocess.run(["npx", "vitest", "run", testfile], cwd=ROOT, capture_output=True, text=True, timeout=900)
            out = r.stdout + r.stderr
            lines = [l for l in out.splitlines() if "Tests" in l and ("passed" in l or "failed" in l)]
            verdict = "CAUGHT" if r.returncode else "MISSED"
            bad += verdict == "MISSED"
            print(f"{verdict} {name}: {lines[-1].strip() if lines else out[-300:]}", flush=True)
        finally:
            with open(full, "w") as fh:
                fh.write(orig)
    return bad


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    selected = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
    suites = {"bridge": [BRIDGE], "worker": [WORKER], "all": [BRIDGE, WORKER]}[which]
    bad = sum(run(s, selected) for s in suites)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
