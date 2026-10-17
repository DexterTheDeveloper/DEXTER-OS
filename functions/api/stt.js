// Cloudflare Pages Function: speech-to-text for DEXTER on devices with no Web Speech (the wall
// calendar's WebView). The page records with MediaRecorder and posts the clip here; this proxies
// it to OpenAI so the key never reaches the browser.
//
// Required on the Pages project (Settings > Variables and Secrets, type Secret):
//   OPENAI_API_KEY      your OpenAI API key
//   DEXTER_PASSPHRASE   already set for chat.js; the same gate applies here
//
// POST /api/stt  multipart/form-data, field "audio" (webm/opus or mp4/aac, 25 MB max)  ->  { text }
// The X-Dexter-Model response header says which model answered, so a silent fall back is visible.
//
// The gate above and the helpers from decodeHeader down are copied from chat.js. Keep them in step.

const MODELS = ['gpt-transcribe', 'gpt-4o-mini-transcribe'];
const MAX_BYTES = 25 * 1024 * 1024;
// OpenAI picks the decoder from the file name, so the clip always goes upstream with a real extension.
const EXT = {
  webm: 'webm', mp4: 'mp4', m4a: 'm4a', 'x-m4a': 'm4a', mpeg: 'mp3', mp3: 'mp3',
  wav: 'wav', 'x-wav': 'wav', wave: 'wav', ogg: 'ogg', flac: 'flac',
};

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

  // Refuse an oversized upload before buffering it (a little slack for the multipart framing).
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES + 65536) {
    return json({ error: 'Audio too large (25 MB max)' }, 413);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Expected multipart/form-data with an "audio" file' }, 400);
  }
  const audio = form.get('audio');
  if (!audio || typeof audio === 'string') return json({ error: 'Missing audio' }, 400);
  if (!audio.size) return json({ error: 'Empty audio' }, 400);
  if (audio.size > MAX_BYTES) return json({ error: 'Audio too large (25 MB max)' }, 413);

  const name = `speech.${extFor(audio)}`;
  let failure = { error: 'Could not reach OpenAI', status: 502 };
  for (const model of MODELS) {
    // One form per attempt, so the fallback never depends on what the first try did to its form.
    const out = new FormData();
    out.append('file', audio, name);
    out.append('model', model);
    out.append('language', 'en');
    out.append('response_format', 'json');

    let upstream;
    try {
      upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: out,
      });
    } catch {
      failure = { error: 'Could not reach OpenAI', status: 502 };
      continue;
    }

    const data = await upstream.json().catch(() => ({}));
    if (upstream.ok) {
      const res = json({ text: typeof data.text === 'string' ? data.text.trim() : '' }, 200);
      res.headers.set('X-Dexter-Model', model);
      return res;
    }
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

// The extension comes from the clip's MIME type, then from its file name, else webm (what Chrome records).
function extFor(file) {
  const sub = (file.type || '').split(';')[0].split('/')[1]?.trim().toLowerCase();
  if (sub && Object.hasOwn(EXT, sub)) return EXT[sub];
  const named = /\.([a-z0-9]{2,4})$/i.exec(file.name || '')?.[1]?.toLowerCase();
  return named && Object.values(EXT).includes(named) ? named : 'webm';
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
