# DEXTER — IIIGLOBE OS

AI operating system interface for King Godfrey / IIIGLOBE.
Claude-powered brain · Voice I/O · PWA (installs to iPhone home screen)

---

## Deploy to Cloudflare Pages (current)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git
2. Authorize GitHub, select the `dexter-os` repo, grant access
3. Project settings: Production branch `main` · Framework preset `None` · Build command *(blank)* · Build output directory `/`
4. Save and Deploy — first build takes ~1 min, gives a `*.pages.dev` URL
5. To attach a custom domain: project → Custom domains → Add a domain, then follow the DNS instructions shown

The frontend is fully static — the deploy set is 15 items: `index.html`, `manifest.json`, `sw.js`, `avatar.png`, `settings.html`, `calendar.html`, `functions/`, plus the eight face loops `avatar-{idle,listening,thinking,speaking}.{webm,webp}` that `sw.js` precaches; `functions/api/chat.js` is a Pages Function that ships automatically alongside it — no separate Worker to deploy. `wrangler.toml` mirrors these settings for CLI deploys (`wrangler pages deploy .`) if you ever want those instead of the Git integration.

### Required: set the Anthropic API key (server-side only)

The frontend calls `/api/chat`, never `api.anthropic.com` directly — the key must never live in `index.html` or any other file the browser downloads.

1. Project → **Settings** → **Environment variables** → **Add variable**
2. Name `ANTHROPIC_API_KEY`, paste your real key, check **Encrypt**, save for both Production and Preview
3. Redeploy (Settings changes need a new deployment to take effect — trigger one from **Deployments** → **Retry deployment**, or just push a commit)

Local testing: copy `.dev.vars.example` to `.dev.vars` (gitignored, never commit it) and fill in your key, then run `npx wrangler pages dev .`.

### Required: set a passphrase (personal use only)

This is a single-operator tool. Without a gate, anyone with the URL could spend your Anthropic credits through `/api/chat`, so the function refuses every request until you set a passphrase:

1. Project → **Settings** → **Variables and Secrets** → **Add**
2. Type **Secret**, name `DEXTER_PASSPHRASE`, value: a phrase you make up, 12+ characters (four random words works)
3. Redeploy (or push a commit)

The first time you chat, DEXTER asks for the passphrase and remembers it on that device. Use the same passphrase for the DEXTER MCP server (`mcp/README.md`).

Optional, stronger: put Cloudflare Access in front of the whole site (Zero Trust → Access → Applications → Self-hosted, domain = your `*.pages.dev` address, policy = your email). The passphrase still applies on top.

### Optional: server voice (wall calendar, and any browser with no Web Speech)

A browser with no `speechSynthesis` or speech recognition (the wall calendar's WebView) gets DEXTER's voice from the server instead: `functions/api/tts.js` turns replies into audio and `functions/api/stt.js` turns the MIC recording into text. Both go through OpenAI, so the key stays server-side and both use the same passphrase gate as chat. Phone and Mac keep using the browser's own voice and recognition and never call them.

Secrets on the Pages project (Settings → Variables and Secrets, type Secret):

- `OPENAI_API_KEY`: new, your OpenAI API key
- `DEXTER_PASSPHRASE`: already set, nothing to change

```bash
npx wrangler pages secret put OPENAI_API_KEY --project-name dexter-os
```

**Redeploy afterwards.** A new secret only takes effect on the next deployment. Until then the endpoints answer `Server missing OPENAI_API_KEY` and the page carries on as typed chat with a one-line note.

Replies are spoken up to 1,200 characters; recordings stop at 15 s (25 MB server cap). One model each, no fallback: `gpt-4o-mini-tts` (voice `cedar`) and `gpt-transcribe`, so a wrong or retired model name comes back as OpenAI's own error instead of being masked. For `wrangler pages dev`, add `OPENAI_API_KEY` to `.dev.vars` too. Manual checks are in `TESTPLAN-voice.md`.

## Deploy to GitHub Pages (previous, 5 commands)

```bash
# 1. Create a new repo on github.com named: dexter-os
#    (go to github.com/new, name it dexter-os, keep it public, don't add README)

# 2. From this folder, run:
git init
git add .
git commit -m "DEXTER v1.0 — initial deploy"

# 3. Connect to your repo (replace YOUR_USERNAME):
git remote add origin https://github.com/YOUR_USERNAME/dexter-os.git

# 4. Push:
git branch -M main
git push -u origin main

# 5. Enable GitHub Pages:
#    github.com/YOUR_USERNAME/dexter-os → Settings → Pages
#    Source: Deploy from branch → main → / (root) → Save
```

Your live URL will be:
`https://YOUR_USERNAME.github.io/dexter-os`

Goes live in ~60 seconds after saving.

---

## Add to iPhone Home Screen (PWA install)

1. Open `https://YOUR_USERNAME.github.io/dexter-os` in Safari
2. Tap the Share button (box with arrow up)
3. Tap "Add to Home Screen"
4. Name it DEXTER → Add

It will appear on your home screen as a standalone app.
The helmet icon will show. Opens fullscreen, no browser chrome.
Works offline after first load (service worker caches assets).

---

## Voice notes

- iPhone: mic button works in Safari iOS 17+
- Desktop: Chrome recommended for best voice recognition
- TTS voice picks the deepest available system voice automatically
- Wall calendar and other browsers with no Web Speech: voice comes from the server, see "Server voice" above
- ElevenLabs upgrade: swap the `speak()` function when ready

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Full DEXTER interface (desktop + mobile) |
| `avatar.png` | King Godfrey neon helmet avatar |
| `avatar-idle.webm` … `avatar-speaking.webp` | Face loops, one WebM + one animated-WebP fallback per state (idle / listening / thinking / speaking), no new art. Generated by `tools/make-face-loops.py` from `tools/face-source.png`, a byte copy of `/Users/iiiglobe/dexter/assets/dexter_face.png` (1024², sha256 `1a701b16…ddb8c`) — not from `avatar.png`, which is a lighter re-encode of the same art; a future Kling regeneration starts from that same source. Kling-made loops can replace these under the same names. Cosmetic: each state swap shows the `avatar.png` poster for a frame while the next loop loads |
| `calendar.html` | Wall calendar page: DEXTER's animated face (tap to talk opens a drawer that iframes `/`), clock, NEXT UP, DAY/WEEK/MONTH views and a settings gear (24h/12h, week start, work-week shading, DAY hours, calendars shown; saved per device in `dexterCalSettings`) |
| `tools/face-source.png`, `tools/make-face-loops.py` | Loop source art + generator (not deployed) |
| `manifest.json` | PWA config (name, icon, standalone mode) |
| `sw.js` | Service worker (offline caching, incl. the face loops; answers `<video>` Range requests from cache) |

---

## Local testing (before deploy)

```bash
# Python
python3 -m http.server 8080
# open: http://localhost:8080

# Node
npx serve .
```

Note: must run via a server (not file://) for PWA features and image loading.
