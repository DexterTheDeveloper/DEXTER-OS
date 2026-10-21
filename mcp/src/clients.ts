import type { AppLabel, ToolName } from "./protocol";

/**
 * Which app a connection belongs to, and what each app may use.
 *
 * The label is derived from things the client can't simply assert: the host of a Client ID
 * Metadata Document URL (fetched over https from that host), or the registered redirect URI the
 * authorization code is sent to (exact match, enforced by the OAuth library). The self-declared
 * client name is only a tie-break for apps on this computer (loopback redirects), and there the
 * default is the restricted policy.
 *
 * Untested against the real apps: the redirect hosts below are the documented ones
 * (claude.ai/api/mcp/auth_callback, chatgpt.com/connector_platform_oauth_redirect), not observed.
 */

/** CIMD documents are fetched only from these exact hosts (no subdomains, no ports). */
export const CIMD_HOSTS = new Set(["claude.ai", "chatgpt.com"]);

const CLAUDE_REDIRECT_HOSTS = new Set(["claude.ai", "claude.com"]);
const CHATGPT_REDIRECT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(value: string | null | undefined): URL | null {
	if (!value) return null;
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

/** True when `clientId` is URL-shaped the way the OAuth library treats as a CIMD client id. */
export function isUrlClientId(clientId: string | null | undefined): boolean {
	const url = parse(clientId);
	return url !== null && url.protocol === "https:";
}

/** A URL client id DEXTER is willing to fetch: https, an allowlisted host, nothing unusual. */
export function cimdAllowed(clientId: string): boolean {
	const url = parse(clientId);
	if (!url || url.protocol !== "https:") return false;
	if (url.port || url.username || url.password) return false;
	return CIMD_HOSTS.has(url.hostname);
}

function isLoopback(url: URL): boolean {
	return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * claude / claude_code / chatgpt, or null when DEXTER doesn't recognise the app (it is then
 * refused at the consent page). Apps on this computer that don't call themselves Claude get the
 * chatgpt label: the restricted policy is the safe default for an unknown local app (Codex CLI
 * included, which is OpenAI's house anyway).
 */
export function classifyClient(clientId: string, redirectUri: string, clientName?: string): AppLabel | null {
	const redirect = parse(redirectUri);
	if (!redirect) return null;
	const local = isLoopback(redirect);

	if (isUrlClientId(clientId)) {
		if (!cimdAllowed(clientId)) return null;
		const host = new URL(clientId).hostname;
		if (host === "chatgpt.com") return local || (redirect.protocol === "https:" && CHATGPT_REDIRECT_HOSTS.has(redirect.hostname)) ? "chatgpt" : null;
		// claude.ai publishes the documents for both Claude (web) and Claude Code (loopback).
		if (local) return "claude_code";
		return redirect.protocol === "https:" && CLAUDE_REDIRECT_HOSTS.has(redirect.hostname) ? "claude" : null;
	}

	if (redirect.protocol === "https:" && CHATGPT_REDIRECT_HOSTS.has(redirect.hostname)) return "chatgpt";
	if (redirect.protocol === "https:" && CLAUDE_REDIRECT_HOSTS.has(redirect.hostname)) return "claude";
	if (local) return /claude/i.test(clientName ?? "") ? "claude_code" : "chatgpt";
	return null;
}

/** Tools each app is offered. Anything not listed is neither advertised nor callable. */
export const APP_TOOLS: Record<AppLabel, readonly ToolName[]> = {
	claude: ["dexter_ask", "dexter_whats_live", "dexter_queue", "dexter_memory_search"],
	claude_code: ["dexter_ask", "dexter_whats_live", "dexter_queue", "dexter_memory_search"],
	// No memory search for ChatGPT. Its calendar access is switched off on the Mac side, inside
	// dexter_ask, keyed on the same label.
	chatgpt: ["dexter_ask", "dexter_whats_live", "dexter_queue"],
};

export const APP_NAMES: Record<AppLabel, string> = {
	claude: "Claude",
	claude_code: "Claude Code",
	chatgpt: "ChatGPT",
};

export function isAppLabel(value: unknown): value is AppLabel {
	return value === "claude" || value === "claude_code" || value === "chatgpt";
}
