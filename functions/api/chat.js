// Cloudflare Pages Function — proxies Claude calls server-side so the
// Anthropic API key never reaches the browser. Deploys automatically with
// the Pages project (no separate Worker to wire up).
//
// Requires an ANTHROPIC_API_KEY environment variable set on the Pages
// project (Settings > Environment variables > Add variable > Encrypt).

const SYS = `You are DEXTER — the AI operating system for King Godfrey and the IIIGLOBE ecosystem.

IDENTITY:
- Operator: Dexter (King Godfrey)
- Entity: IIIGLOBE (consulting entity — divisions: G.E.E.K. Radio, KGTV, Third Dimension)
- Location: Baltimore, MD. Primary DAW: BandLab.
- Active project: Wake Up animated short film
- Job search: Active, full-time event tech roles

RULES:
- Lead with the answer. Explain after.
- Direct, decisive, no filler. No em dashes.
- Max 3 options when giving choices. Always commit to a recommendation.
- Voice-optimized: 2-4 sentences unless depth is required.
- Never open with praise or filler.`;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Server missing ANTHROPIC_API_KEY' }, 500);
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYS,
      messages: [{ role: 'user', content: `[MODULE: ${mod}] ${text}` }],
    }),
  });

  const data = await upstream.json();
  return json(data, upstream.status);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
