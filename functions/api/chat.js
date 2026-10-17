// Cloudflare Pages Function: proxies DEXTER's chat to Claude so the Anthropic key never reaches
// the browser. Deploys automatically with the Pages project.
//
// Required on the Pages project (Settings > Variables and Secrets, type Secret):
//   ANTHROPIC_API_KEY   your Anthropic API key
//   DEXTER_PASSPHRASE   12+ characters; the PWA asks for it once and remembers it on that device
//
// Without the passphrase gate, anyone who finds the pages.dev URL could spend your Claude credits.
//
// Model: claude-opus-5-5. It runs adaptive thinking by default, so the request must not send `thinking`
// (disabled and budget_tokens are 400s) or temperature, top_p, top_k or tool_choice.
// Effort is "low": the page sits on PROCESSING with no streaming and the system prompt caps replies at 2-4
// sentences, so more thinking only adds seconds to every turn on a voice surface. max_tokens is 8192, a cap
// and not spend: thinking tokens count against it, and 2048 could end in stop_reason max_tokens with no text,
// which the page showed as "Empty reply from Claude".
// Refusal fallback is a beta (header anthropic-beta plus body field `fallbacks`). If Anthropic changes or
// retires it, a 400 that names it is retried once without it, so chat never breaks on a beta change.

const MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const SYS = `You are DEXTER, the AI operating system for King Godfrey and the George Street / IIIGLOBE ecosystem.

IDENTITY:
- Operator: Dexter (King Godfrey). Based in Baltimore, MD.
- Umbrella entity: George Street LLC. Creative arm: IIIGLOBE Studios (G.E.E.K. Radio, KGTV, Third Dimension).
- Primary DAW: BandLab.

RULES:
- Lead with the answer. Explain after.
- Direct, decisive, no filler. No em dashes.
- Max 3 options when giving choices. Always commit to a recommendation.
- Voice-optimized: 2-4 sentences unless depth is required.
- Never open with praise or filler.
- Never invent financial figures.`;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Server missing ANTHROPIC_API_KEY' }, 500);
  }
  if (!env.DEXTER_PASSPHRASE || env.DEXTER_PASSPHRASE.length < 12) {
    return json({ error: 'Set DEXTER_PASSPHRASE (12+ characters) on the Pages project, then redeploy.' }, 503);
  }
  const supplied = decodeHeader(request.headers.get('X-Dexter-Passphrase'));
  if (!(await sameSecret(supplied, env.DEXTER_PASSPHRASE))) {
    return json({ error: 'Wrong or missing passphrase.' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const mod = typeof body.module === 'string' && body.module ? body.module : 'COMMAND';
  if (!text) return json({ error: 'Missing text' }, 400);

  let upstream = await askClaude(env, mod, text, true);
  let data = await upstream.json().catch(() => ({}));
  // The fallback beta changed or was retired: retry once without it.
  if (upstream.status === 400 && /fallbacks|server-side-fallback|anthropic-beta/i.test(data?.error?.message || '')) {
    upstream = await askClaude(env, mod, text, false);
    data = await upstream.json().catch(() => ({}));
  }
  if (!upstream.ok) {
    return json({ error: data?.error?.message || `Claude API error ${upstream.status}` }, upstream.status);
  }

  // Replies can include thinking blocks; the PWA only wants the text.
  let reply = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  // A refusal is a normal 200 with stop_reason "refusal": show its text if it has any, else a short line.
  if (!reply && data.stop_reason === 'refusal') reply = "I can't help with that one.";
  if (!reply) return json({ error: 'Empty reply from Claude' }, 502);
  return json({ content: [{ type: 'text', text: reply }] }, 200);
}

// withFallbacks adds the refusal-fallback beta (header and body field); without it the request is plain.
function askClaude(env, mod, text, withFallbacks) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  const body = {
    model: MODEL,
    max_tokens: 8192,
    output_config: { effort: 'low' },
    system: SYS,
    messages: [{ role: 'user', content: `[MODULE: ${mod}] ${text}` }],
  };
  if (withFallbacks) {
    headers['anthropic-beta'] = FALLBACK_BETA;
    body.fallbacks = 'default';
  }
  return fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
}

function decodeHeader(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Compare keyed hashes so the check takes the same time whatever the input.
async function sameSecret(attempt, expected) {
  if (!attempt) return false;
  const [a, b] = await Promise.all([hmacHex(expected, attempt), hmacHex(expected, expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(key, data) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
