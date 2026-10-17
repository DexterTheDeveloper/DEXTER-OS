# Wall calendar: manual test plan

Covers `functions/api/calendar.js` and `calendar.html` (served at `/calendar`). Needs the site deployed with
the three Google secrets set **and redeployed after setting them** (`SECRETS-calendar.md`). `sw.js` is
unchanged: `/calendar` is not in its precache, so the page always comes from the network, and `/api/*`
already bypasses the worker. The page plays `avatar-idle.webm` (falling back to `avatar-idle.webp`, then
`avatar.png`); `sw.js` precaches all of them once the worker is installed, which happens the first time `/`
loads (directly or through the chat drawer). The page never registers the worker itself.

## 1. curl smoke test (from the Mac)

```bash
BASE=https://dexter-os.pages.dev
printf 'DEXTER passphrase: '; read -rs PASS; echo      # typed silently, never lands in shell history
```

| Request | Expect |
|---|---|
| `curl -sS -i "$BASE/api/calendar"` (no passphrase) | `401` `{"error":"Wrong or missing passphrase."}` |
| `curl -sS -i "$BASE/api/calendar" -H "X-Dexter-Passphrase: not-the-passphrase"` | `401`, same body |
| `curl -sS -i -X POST "$BASE/api/calendar" -H "X-Dexter-Passphrase: $PASS"` | `405` or `404` from Pages (GET only) |
| before the secrets are set: `curl -sS -i "$BASE/api/calendar" -H "X-Dexter-Passphrase: $PASS"` | `503` `{"error":"calendar not configured"}` |
| after the secrets + redeploy: same line | `200`, JSON below |

200 shape (`python3 -m json.tool` it):

```
{"generatedAt":"2026-...Z","tz":"America/New_York",
 "calendars":[{"id":"...","name":"...","color":"#..."}],
 "events":[{"id":"...","cal":"...","title":"...","start":"2026-10-17T09:00:00-04:00","end":"...",
            "allDay":false,"location":"","status":"confirmed","declined":false}]}
```

- All-day events carry plain dates (`"start":"2026-10-20","end":"2026-10-22"`, end exclusive) and `allDay:true`.
- Cancelled events are absent. An event DexterOS@ declined has `declined:true`.
- `events` covers yesterday through 13 days ahead, sorted by start.
- A second curl within 5 minutes returns the identical body with no new Google call (same `generatedAt`).
- `502 {"error":"calendar re-consent needed"}` means the refresh token is dead or revoked: re-consent as
  DexterOS@ on the Mac, then re-run the `GOOGLE_REFRESH_TOKEN` line in `SECRETS-calendar.md` and redeploy.
- `502 {"error":"calendar unavailable"}` is any other Google failure; nothing of Google's body is passed through.
- Each error above is quick JSON, never an HTML page, and never contains a token or a secret.

Optional: set the plain variable `GOOGLE_CALENDAR_IDS` (comma list) to limit which calendars are read;
unset, it is every calendar shared to DexterOS@ with reader, writer or owner access.

## 2. Phone or Mac browser

1. Open `$BASE/calendar`. First visit asks "DEXTER passphrase" once (same prompt and storage as `/`).
2. Left column: DEXTER's face, moving (the idle loop), "Tap to talk" under it; 24-hour clock, weekday and
   date; NEXT UP card (next event today or tomorrow, "in 1h 20m"); status line `updated HH:MM`; gear at the
   bottom. Right: DAY | WEEK | MONTH tabs (DAY first), a Sun–Sat row for this week, and today's timeline from
   05:00 to 23:00 with a red line at the current time. Phone: face and clock in a row at the top, gear top right.
3. Tap a day in the week row: DAY shows it (TOMORROW / the weekday); ‹ › move a week; TODAY returns.
   WEEK: seven columns Sun–Sat, Mon–Fri slightly lighter; tap a day header → DAY for that day.
   MONTH: weeks start Sunday, Mon–Fri shaded, dots and a count per day, ‹ › months; tap a day → DAY.
   Days outside the feed (before yesterday, after +13 days) are hatched/dim, never shown as free.
4. Tap the face: the chat slides in (full width on the phone); CLOSE slides it away. Chat works without a
   second passphrase prompt.
5. Gear → settings: switch Clock to 12-HOUR (labels become 5 AM … 11 PM), Week starts MONDAY, move DAY start
   to 06:00, turn a calendar OFF. Reload: all four stick. They are stored per device (`dexterCalSettings`) and
   never touch the kiosk's own settings or the passphrase.
6. Add an event on your phone's Google Calendar (on a calendar shared to DexterOS@); within 5 minutes it
   appears and the status time moves.
7. Turn Wi-Fi off and wait 5 minutes: the status reads `offline · showing HH:MM`, the events stay.

## 3. On the wall (DF-18T)

1. Unlock the kiosk: tap the top-left corner 10 times → Unlock. Wrench → Settings → Web Content → Home URL
   = `https://dexter-os.pages.dev/calendar` (later `https://dexter.iiiglobe.com/calendar`). Keep Rotation 90,
   Reset on Launch ON, Keep Screen On ON. Wrench → Lock (or reboot).
   Fallback without unlocking: from the vendor screen reach `dexter-os.pages.dev/settings` as in the kiosk notes,
   then tap "0. Launch DEXTER (kiosk)" once the Home URL is changed.
2. First launch asks for the passphrase (on-screen keyboard). It is stored on the device; after that no typing.
3. Stand at the wall: today's events with the right times, readable across the room, nothing cut off,
   kiosk wrench (bottom-right) overlaps nothing important. DEXTER's face is at the top of the left column,
   clear of the 10-tap unlock corner; the gear is bottom-left.
   The face must be moving. If it is a still image, tap anywhere once: it should start moving (autoplay
   retry). Still frozen after a tap = the WebView refused both the video and the animated WebP; note it.
4. Tap a day, tap WEEK and MONTH, open the gear and close it, tap the face → chat opens, typed chat works,
   CLOSE returns to the calendar.
5. Power menu → Restart. The calendar comes back on its own, locked, with events (the saved passphrase survives).
6. Leave it overnight: at midnight the TODAY column moves to the new day by itself.

## 4. Rollback

Cloudflare → Workers & Pages → dexter-os → Deployments → previous deployment → Rollback. The kiosk Home URL
can stay on `/calendar` (it 404s to Pages' not-found page on the old build) or go back to `/`.
