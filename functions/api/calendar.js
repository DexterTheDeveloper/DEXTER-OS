// Cloudflare Pages Function: the wall calendar's feed. Reads the next two weeks from the Google
// calendars shared to DEXTER's own account (DexterOS@) so the browser never holds a Google token.
//
// Required on the Pages project (Settings > Variables and Secrets, type Secret):
//   GOOGLE_CLIENT_ID        OAuth client id (the "installed" client the Mac's `dexter calendar` uses)
//   GOOGLE_CLIENT_SECRET    its client secret
//   GOOGLE_REFRESH_TOKEN    refresh token minted by consenting as DexterOS@ (read-only calendar scope)
//   DEXTER_PASSPHRASE       already set for chat.js; the same gate applies here
// Optional (plain variable):
//   GOOGLE_CALENDAR_IDS     comma-separated calendar ids; default = every calendar in the account's list
//                           with accessRole reader, writer or owner
//
// GET /api/calendar  ->  { generatedAt, tz, calendars: [{ id, name, color }],
//                         events: [{ id, cal, title, start, end, allDay, location, status, declined }] }
// Window: start of today (New York) minus 1 day to +14 days, recurring events expanded, cancelled dropped.
// The whole response is cached in module scope for 5 minutes; the access token until it expires.
// Errors are short fixed strings: Google's own bodies and the tokens never reach the browser or the log.
//
// The passphrase gate (the first two checks in onRequestGet) and the helpers from decodeHeader down are
// copied from chat.js. Keep them in step.

const TZ = 'America/New_York';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const CACHE_MS = 5 * 60 * 1000;
const ROLES = ['reader', 'writer', 'owner'];

let tokenCache = { value: '', expiresAt: 0 };
let feedCache = { key: '', at: 0, body: '' };

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.DEXTER_PASSPHRASE || env.DEXTER_PASSPHRASE.length < 12) {
    return json({ error: 'Set DEXTER_PASSPHRASE (12+ characters) on the Pages project, then redeploy.' }, 503);
  }
  const supplied = decodeHeader(request.headers.get('X-Dexter-Passphrase'));
  if (!(await sameSecret(supplied, env.DEXTER_PASSPHRASE))) {
    return json({ error: 'Wrong or missing passphrase.' }, 401);
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return json({ error: 'calendar not configured' }, 503);
  }

  const key = String(env.GOOGLE_CALENDAR_IDS || '');
  const now = Date.now();
  if (feedCache.body && feedCache.key === key && now - feedCache.at < CACHE_MS) {
    return raw(feedCache.body, 200);
  }

  let body;
  try {
    body = JSON.stringify(await buildFeed(env, new Date(now)));
  } catch (e) {
    if (e && e.reconsent) {
      tokenCache = { value: '', expiresAt: 0 };
      return json({ error: 'calendar re-consent needed' }, 502);
    }
    return json({ error: 'calendar unavailable' }, 502);
  }
  feedCache = { key, at: now, body };
  return raw(body, 200);
}

async function buildFeed(env, now) {
  const token = await accessToken(env, now.getTime());
  const auth = { Authorization: 'Bearer ' + token };

  const listed = await google(API + '/users/me/calendarList?minAccessRole=reader&maxResults=250', auth);
  const byId = {};
  for (const item of listed.items || []) {
    if (item.deleted || ROLES.indexOf(item.accessRole) < 0) continue;
    byId[item.id] = { id: item.id, name: item.summaryOverride || item.summary || item.id, color: item.backgroundColor || '' };
  }
  const wanted = String(env.GOOGLE_CALENDAR_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const calendars = wanted.length
    ? wanted.map((id) => byId[id] || { id, name: id, color: '' })
    : Object.keys(byId).map((id) => byId[id]);

  const today = zonedMidnight(now, TZ);
  const timeMin = new Date(today - 24 * 3600 * 1000).toISOString();
  const timeMax = new Date(today + 14 * 24 * 3600 * 1000).toISOString();
  const q = '?singleEvents=true&orderBy=startTime&maxResults=250&timeZone=' + encodeURIComponent(TZ) +
    '&timeMin=' + encodeURIComponent(timeMin) + '&timeMax=' + encodeURIComponent(timeMax) +
    '&fields=' + encodeURIComponent('items(id,status,summary,location,start,end,attendees(self,responseStatus))');

  const pages = await Promise.all(calendars.map((c) => google(API + '/calendars/' + encodeURIComponent(c.id) + '/events' + q, auth)));
  const events = [];
  calendars.forEach((c, i) => {
    for (const ev of pages[i].items || []) {
      if (!ev || ev.status === 'cancelled' || !ev.start) continue;
      const allDay = !!ev.start.date;
      const me = (ev.attendees || []).filter((a) => a && a.self)[0];
      events.push({
        id: ev.id,
        cal: c.id,
        title: ev.summary || '(no title)',
        start: allDay ? ev.start.date : ev.start.dateTime,
        end: allDay ? (ev.end && ev.end.date) || ev.start.date : (ev.end && ev.end.dateTime) || ev.start.dateTime,
        allDay,
        location: ev.location || '',
        status: ev.status || 'confirmed',
        declined: !!(me && me.responseStatus === 'declined'),
      });
    }
  });
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  return { generatedAt: now.toISOString(), tz: TZ, calendars, events };
}

async function accessToken(env, now) {
  if (tokenCache.value && now < tokenCache.expiresAt) return tokenCache.value;
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('client_id', env.GOOGLE_CLIENT_ID);
  form.set('client_secret', env.GOOGLE_CLIENT_SECRET);
  form.set('refresh_token', env.GOOGLE_REFRESH_TOKEN);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || (data && data.error === 'invalid_grant')) throw reconsent();
  if (!res.ok || !data.access_token) throw new Error('token');
  // Refresh a minute early; expires_in is seconds.
  tokenCache = { value: data.access_token, expiresAt: now + Math.max(0, (Number(data.expires_in) || 3600) - 60) * 1000 };
  return data.access_token;
}

async function google(url, auth) {
  const res = await fetch(url, { headers: auth });
  if (res.status === 401) throw reconsent();
  if (!res.ok) throw new Error('google ' + res.status);
  return res.json();
}

function reconsent() {
  const e = new Error('reconsent');
  e.reconsent = true;
  return e;
}

// The UTC instant of local midnight for `date`'s calendar day in `tz`.
function zonedMidnight(date, tz) {
  const p = partsIn(date, tz);
  let guess = Date.UTC(p.y, p.m - 1, p.d);
  for (let i = 0; i < 2; i++) {
    const q = partsIn(new Date(guess), tz);
    const drift = Date.UTC(q.y, q.m - 1, q.d, q.h, q.mi) - Date.UTC(p.y, p.m - 1, p.d);
    if (!drift) break;
    guess -= drift;
  }
  return guess;
}

function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const out = {};
  for (const part of f.formatToParts(date)) out[part.type] = part.value;
  return { y: +out.year, m: +out.month, d: +out.day, h: +out.hour % 24, mi: +out.minute };
}

function raw(body, status) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
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
