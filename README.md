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

The frontend is fully static (`index.html`, `manifest.json`, `sw.js`, `avatar.png`); `functions/api/chat.js` is a Pages Function that ships automatically alongside it — no separate Worker to deploy. `wrangler.toml` mirrors these settings for CLI deploys (`wrangler pages deploy .`) if you ever want those instead of the Git integration.

### Required: set the Anthropic API key (server-side only)

The frontend calls `/api/chat`, never `api.anthropic.com` directly — the key must never live in `index.html` or any other file the browser downloads.

1. Project → **Settings** → **Environment variables** → **Add variable**
2. Name `ANTHROPIC_API_KEY`, paste your real key, check **Encrypt**, save for both Production and Preview
3. Redeploy (Settings changes need a new deployment to take effect — trigger one from **Deployments** → **Retry deployment**, or just push a commit)

Local testing: copy `.dev.vars.example` to `.dev.vars` (gitignored, never commit it) and fill in your key, then run `npx wrangler pages dev .`.

### Required: gate it behind Cloudflare Access (personal use only)

This is a single-operator tool with no login screen of its own — anyone with the URL gets the full interface and, without a gate, could ride your Anthropic quota. Cloudflare Access puts a login wall in front of the Pages domain for free, no code changes:

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Zero Trust** (first visit prompts a one-time free-plan setup, up to 50 seats)
2. **Access** → **Applications** → **Add an application** → **Self-hosted**
3. Application domain: your `*.pages.dev` domain (or custom domain, once attached)
4. Identity provider: default **One-time PIN** (email code) needs no extra setup — good enough for a single operator
5. Policy: Include → **Emails** → your own email address only
6. Save

Every visit will now require an email login code before the DEXTER interface loads, on top of the API key never being exposed client-side.

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
- ElevenLabs upgrade: swap the `speak()` function when ready

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Full DEXTER interface (desktop + mobile) |
| `avatar.png` | King Godfrey neon helmet avatar |
| `manifest.json` | PWA config (name, icon, standalone mode) |
| `sw.js` | Service worker (offline caching) |

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
