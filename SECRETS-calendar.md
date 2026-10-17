# Wall calendar: the three secrets (operator only)

The calendar function needs three Pages secrets. Each line below reads the value straight from the file on
the Mac into wrangler's stdin, so **no value is ever printed on screen or kept in shell history**.

Order matters:

1. **Re-consent first.** The refresh token in `~/.dexter/google_calendar_token.json` right now is dead.
   Run `dexter calendar list` on the Mac, pick **DexterOS@iiiglobe.com** at the account chooser
   (Advanced → continue → Allow). That rewrites the token file with a live refresh token for DexterOS@.
2. Then run the three lines (from any folder; `npx wrangler@4` prompts for a Cloudflare login the first time):

```bash
python3 -c "import json;print(json.load(open('$HOME/.dexter/google_credentials.json'))['installed']['client_id'],end='')" | npx wrangler@4 pages secret put GOOGLE_CLIENT_ID --project-name dexter-os
python3 -c "import json;print(json.load(open('$HOME/.dexter/google_credentials.json'))['installed']['client_secret'],end='')" | npx wrangler@4 pages secret put GOOGLE_CLIENT_SECRET --project-name dexter-os
python3 -c "import json;print(json.load(open('$HOME/.dexter/google_calendar_token.json'))['refresh_token'],end='')" | npx wrangler@4 pages secret put GOOGLE_REFRESH_TOKEN --project-name dexter-os
```

Each one answers `✨ Success! Uploaded secret GOOGLE_...`. Nothing else is shown.

File shapes these lines rely on (keys only, checked 2026-10-17):
`google_credentials.json` → `installed` → `client_id`, `client_secret`;
`google_calendar_token.json` → `refresh_token` (top level).

3. **Redeploy.** A Pages secret only takes effect on the next deployment (Deployments → Retry deployment, or
   push a commit). Until then `/api/calendar` answers `503 calendar not configured`.

Optional, plain variable (not a secret): `GOOGLE_CALENDAR_IDS` = comma-separated calendar ids to limit the
feed. Leave it unset to read every calendar shared to DexterOS@.

If the wall ever shows `calendar re-consent needed`: repeat steps 1, the third line, and 3.
