// Cloudflare Pages Function: text-to-speech for DEXTER on devices with no Web Speech (the wall
// calendar's WebView). Proxies to OpenAI so the key never reaches the browser.
//
// Required on the Pages project (Settings > Variables and Secrets, type Secret):
//   OPENAI_API_KEY      your OpenAI API key
//   DEXTER_PASSPHRASE   already set for chat.js; the same gate applies here
//
// POST /api/tts  { text, voice? }  ->  audio/mpeg. The X-Dexter-Model response header says which
// model answered, so a silent fall back to tts-1 is visible.
//
// The gate above and the helpers from decodeHeader down are copied from chat.js. Keep them in step.

const MODELS = ['gpt-4o-mini-tts', 'tts-1'];
const DEFAULT_VOICE = 'cedar';
// tts-1 predates cedar and marin, so if it ends up serving the request it gets a voice it knows.
const TTS1_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const TTS1_VOICE = 'onyx';
const STYLE = 'Calm, low and measured. Direct and confident, never cheerful or salesy.';
const MAX_CHARS = 1200;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.OPENAI_API_KEY) {
    return json({ error: 'Server missing OPENAI_API_KEY' }, 500);
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

  const text = clip(typeof body?.text === 'string' ? body.text.trim() : '');
  if (!text) return json({ error: 'Missing text' }, 400);
  const voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim().toLowerCase() : DEFAULT_VOICE;
  if (!/^[a-z]{2,20}$/.test(voice)) return json({ error: 'Invalid voice' }, 400);

  let failure = { error: 'Could not reach OpenAI', status: 502 };
  for (const model of MODELS) {
    const payload = {
      model,
      input: text,
      voice: model === 'tts-1' && !TTS1_VOICES.includes(voice) ? TTS1_VOICE : voice,
      response_format: 'mp3',
    };
    // Only the gpt-4o models take a style prompt.
    if (model !== 'tts-1') payload.instructions = STYLE;

    let upstream;
    try {
      upstream = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify(payload),
      });
    } catch {
      failure = { error: 'Could not reach OpenAI', status: 502 };
      continue;
    }

    if (upstream.ok && upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Dexter-Model': model },
      });
    }

    const data = await upstream.json().catch(() => ({}));
    // A rejected server key must not come back as 401, which the page reads as "wrong passphrase".
    // OpenAI's own message quotes part of the key, so it is not passed through either.
    if (upstream.status === 401) return json({ error: 'OpenAI rejected OPENAI_API_KEY' }, 502);
    failure = {
      error: data?.error?.message || `OpenAI error ${upstream.status}`,
      status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
    };
  }
  return json({ error: failure.error }, failure.status);
}

// Hard cap on what one request may speak. Cuts after the last sentence end inside the cap, or at
// the last space if there is none.
function clip(text) {
  if (text.length <= MAX_CHARS) return text;
  let end = 0;
  for (const m of text.matchAll(/[.!?]+["')\]]*(?=\s|$)/g)) {
    const stop = m.index + m[0].length;
    if (stop > MAX_CHARS) break;
    end = stop;
  }
  if (end > 0) return text.slice(0, end);
  const head = text.slice(0, MAX_CHARS);
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).trim();
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
