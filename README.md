# DEXTER — IIIGLOBE OS

AI operating system interface for King Godfrey / IIIGLOBE.
Claude-powered brain · Voice I/O · PWA (installs to iPhone home screen)

---

## Deploy to GitHub Pages (5 commands)

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
