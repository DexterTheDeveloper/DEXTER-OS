// Cloudflare Pages Function: proxies DEXTER's chat to Claude so the Anthropic key never reaches
// the browser. Deploys automatically with the Pages project.
//
// Required on the Pages project (Settings > Variables and Secrets, type Secret):
//   ANTHROPIC_API_KEY   your Anthropic API key
//   DEXTER_PASSPHRASE   12+ characters; the PWA asks for it once and remembers it on that device
//
// Without the passphrase gate, anyone who finds the pages.dev URL could spend your Claude credits.

const MODEL = 'claude-sonnet-5-5';

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

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      // Chat is latency-sensitive: low effort keeps replies quick and short.
      output_config: { effort: 'low' },
      system: SYS,
      messages: [{ role: 'user', content: `[MODULE: ${mod}] ${text}` }],
    }),
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return json({ error: data?.error?.message || `Claude API error ${upstream.status}` }, upstream.status);
  }

  // Replies can include thinking blocks; the PWA only wants the text.
  const reply = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!reply) return json({ error: 'Empty reply from Claude' }, 502);
  return json({ content: [{ type: 'text', text: reply }] }, 200);
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
