import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BRIDGE_NAME, type RelayResult } from "./bridge";
import { APP_TOOLS } from "./clients";
import type { AppLabel, ToolName } from "./protocol";

/**
 * The MCP surface: four read-only tools, each a straight relay to the Mac DEXTER through the
 * Bridge Durable Object. This Worker has no model, memory or data of its own; every answer comes
 * from the Mac, and when the Mac isn't connected the answer is "DEXTER is asleep".
 */

export const SERVER_VERSION = "0.2.0";

export { TOOL_NAMES } from "./protocol";

export const INSTRUCTIONS = `DEXTER is King Godfrey's personal AI operating system. It runs on his Mac; these tools reach it through a read-only relay.
- dexter_ask: ask DEXTER anything, in plain language. It answers from its own memory, rules and tools.
- dexter_whats_live: what DEXTER can do right now, and its capability totals.
- dexter_queue: open proposals and recent background requests, read only.
- dexter_memory_search (where offered): search what DEXTER has learned.
Nothing here can change DEXTER: no writing, saving, approving or running. If a tool says DEXTER is asleep, the Mac is offline or asleep; say so plainly and don't guess an answer.`;

export interface Caller {
	app: AppLabel;
	clientId: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

export const ASLEEP_TEXT =
	"DEXTER is asleep: the Mac isn't connected right now (it may be asleep or offline). Try again once it's awake.";

export function describeRelay(result: RelayResult): ToolResult {
	switch (result.status) {
		case "ok":
			return text(result.text, result.isError);
		case "asleep":
			return text(ASLEEP_TEXT, true);
		case "timeout":
			return text("DEXTER didn't answer within 55 seconds. Try again, or ask something narrower.", true);
		case "busy":
			return text("DEXTER is handling other requests. Try again in a moment.", true);
		case "dropped":
			return text("DEXTER's connection dropped while answering. Try again in a moment.", true);
		case "unconfigured":
			return text("DEXTER's bridge isn't set up yet (BRIDGE_SECRET is missing on the relay).", true);
	}
}

async function relay(env: Env, caller: Caller, tool: ToolName, args: Record<string, string>): Promise<ToolResult> {
	try {
		const stub = env.BRIDGE.get(env.BRIDGE.idFromName(BRIDGE_NAME));
		return describeRelay(await stub.relay({ tool, args, app: caller.app, clientId: caller.clientId }));
	} catch (error) {
		console.warn("relay failed:", error instanceof Error ? error.name : "unknown");
		return text("DEXTER's relay hit an error. Try again in a moment.", true);
	}
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function buildServer(env: Env, caller: Caller): McpServer {
	const server = new McpServer({ name: "dexter", title: "DEXTER", version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
	// Only what this app is allowed is registered at all: an unlisted tool is neither advertised
	// in tools/list nor callable through tools/call.
	const allowed = new Set<ToolName>(APP_TOOLS[caller.app]);

	if (allowed.has("dexter_ask")) {
		server.registerTool(
			"dexter_ask",
			{
				title: "Ask DEXTER",
				description:
					"Ask DEXTER a question in plain language and get its answer, drawn from its memory, rules and read-only tools. Takes up to about a minute.",
				inputSchema: z.object({ question: z.string().trim().min(1).max(4000).describe("The question, in plain language.") }),
				annotations: { ...READ_ONLY, idempotentHint: false },
			},
			async ({ question }) => relay(env, caller, "dexter_ask", { question }),
		);
	}

	if (allowed.has("dexter_whats_live")) {
		server.registerTool(
			"dexter_whats_live",
			{
				title: "What's live in DEXTER",
				description: "What DEXTER can do right now, with its capability totals.",
				inputSchema: z.object({}),
				annotations: READ_ONLY,
			},
			async () => relay(env, caller, "dexter_whats_live", {}),
		);
	}

	if (allowed.has("dexter_queue")) {
		server.registerTool(
			"dexter_queue",
			{
				title: "DEXTER's queue",
				description: "Open proposals waiting for a decision, and recent background requests (id, kind, status). Read only.",
				inputSchema: z.object({}),
				annotations: READ_ONLY,
			},
			async () => relay(env, caller, "dexter_queue", {}),
		);
	}

	if (allowed.has("dexter_memory_search")) {
		server.registerTool(
			"dexter_memory_search",
			{
				title: "Search DEXTER's memory",
				description: "Search what DEXTER has learned and remembered. Read only.",
				inputSchema: z.object({ query: z.string().trim().min(1).max(500).describe("Words to look for.") }),
				annotations: READ_ONLY,
			},
			async ({ query }) => relay(env, caller, "dexter_memory_search", { query }),
		);
	}

	return server;
}
