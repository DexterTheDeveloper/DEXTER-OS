# Wall calendar: manual test plan

Covers `functions/api/calendar.js` and `calendar.html` (served at `/calendar`). Needs the site deployed with
the three Google secrets set **and redeployed after setting them** (`SECRETS-calendar.md`). `sw.js` is
unchanged: `/calendar` is not in its precache, so the page always comes from the network, and `/api/*`
already bypasses the worker.

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
2. Big clock and date, TODAY list, 7-day strip underneath. Status line bottom-left (phone: under the date)
   reads `updated h:mmpm`.
3. Tap a strip day: the list switches to that day, label says TOMORROW or the weekday; tap today (or
   BACK TO TODAY) to return. MONTH opens the grid with dots on days that have events; tap a day to show it.
4. DEXTER slides the chat in (full width on the phone); CLOSE slides it away. Chat works without a second
   passphrase prompt.
5. Add an event on your phone's Google Calendar (on a calendar shared to DexterOS@); within 5 minutes it
   appears and the status time moves.
6. Turn Wi-Fi off and wait 5 minutes: the status reads `offline · showing h:mmpm`, the events stay.

## 3. On the wall (DF-18T)

1. Unlock the kiosk: tap the top-left corner 10 times → Unlock. Wrench → Settings → Web Content → Home URL
   = `https://dexter-os.pages.dev/calendar` (later `https://dexter.iiiglobe.com/calendar`). Keep Rotation 90,
   Reset on Launch ON, Keep Screen On ON. Wrench → Lock (or reboot).
   Fallback without unlocking: from the vendor screen reach `dexter-os.pages.dev/settings` as in the kiosk notes,
   then tap "0. Launch DEXTER (kiosk)" once the Home URL is changed.
2. First launch asks for the passphrase (on-screen keyboard). It is stored on the device; after that no typing.
3. Stand at the wall: today's events with the right times, readable across the room, nothing cut off,
   kiosk wrench (bottom-right) overlaps nothing important. DEXTER button is bottom-left.
4. Tap a day, tap MONTH, tap DEXTER → chat opens, typed chat works, CLOSE returns to the calendar.
5. Power menu → Restart. The calendar comes back on its own, locked, with events (the saved passphrase survives).
6. Leave it overnight: at midnight the TODAY column moves to the new day by itself.

## 4. Rollback

Cloudflare → Workers & Pages → dexter-os → Deployments → previous deployment → Rollback. The kiosk Home URL
can stay on `/calendar` (it 404s to Pages' not-found page on the old build) or go back to `/`.
