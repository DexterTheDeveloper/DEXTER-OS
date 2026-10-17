# Server voice: manual test plan

Covers `functions/api/tts.js`, `functions/api/stt.js` and the voice changes in `index.html`.
Needs the site deployed with `OPENAI_API_KEY` set **and redeployed after setting it** (README, "Server voice").

## 0. After every deploy: get the new page onto each device

The service worker serves the previous page first, then updates itself in the background.
Load the site, wait about 10 seconds, then reload (on the calendar: relaunch the kiosk twice).
On the calendar the **speaker button next to MIC** is the marker that the new page is live.
Phone and Mac show nothing new, so for them the check is that nothing changed (section 2).

## 1. curl smoke test (from the Mac)

```bash
BASE=https://dexter-os.pages.dev
printf 'DEXTER passphrase: '; read -rs PASS; echo      # typed silently, never lands in shell history
```

**Chat still works** (the model changed to claude-opus-5-5):

```bash
curl -sS -X POST "$BASE/api/chat" -H "Content-Type: application/json" \
  -H "X-Dexter-Passphrase: $PASS" -d '{"module":"COMMAND","text":"Say hello in one sentence."}'
```
Expect `{"content":[{"type":"text","text":"..."}]}`. An `error` here means chat is broken, not just voice.

**Text to speech:**

```bash
curl -sS -X POST "$BASE/api/tts" -H "Content-Type: application/json" \
  -H "X-Dexter-Passphrase: $PASS" -d '{"text":"DEXTER online. All systems ready."}' \
  -D /tmp/dexter-tts.headers -o /tmp/dexter-tts.mp3
head -1 /tmp/dexter-tts.headers; grep -i -E '^(content-type|x-dexter-model)' /tmp/dexter-tts.headers
file /tmp/dexter-tts.mp3; afplay /tmp/dexter-tts.mp3
```
Expect `200`, `content-type: audio/mpeg`, a file `file` calls MPEG layer III, and a low male voice (cedar) saying the line.
`x-dexter-model: gpt-4o-mini-tts` is the primary. If it says `tts-1`, the primary was refused and the fallback answered: check the model name against your OpenAI account.
Voice override: add `"voice":"onyx"` to the JSON and listen for a different voice.

**Speech to text** (round trip: feed the mp3 back in):

```bash
curl -sS -D /tmp/dexter-stt.headers -X POST "$BASE/api/stt" -H "X-Dexter-Passphrase: $PASS" \
  -F "audio=@/tmp/dexter-tts.mp3;type=audio/mpeg"
grep -i '^x-dexter-model' /tmp/dexter-stt.headers
```
Expect `{"text":"DEXTER online. All systems ready."}` (wording may differ slightly) and `x-dexter-model: gpt-transcribe`.
`gpt-4o-mini-transcribe` there means the primary was refused and the fallback answered.
Also try the Safari-style container the iPhone and calendar-class devices may produce:

```bash
say -o /tmp/s.aiff "turn the lights on"; afconvert -f m4af -d aac /tmp/s.aiff /tmp/s.m4a
curl -sS -X POST "$BASE/api/stt" -H "X-Dexter-Passphrase: $PASS" -F "audio=@/tmp/s.m4a;type=audio/mp4"
```

**Gate and errors** (each must be quick JSON, never an HTML page):

| Request | Expect |
|---|---|
| tts or stt with a wrong passphrase | `401 {"error":"Wrong or missing passphrase."}` |
| tts or stt with no passphrase header | `401`, same body |
| tts with `{"text":"   "}` | `400 {"error":"Missing text"}` |
| tts with `{"text":"hi","voice":"../x"}` | `400 {"error":"Invalid voice"}` |
| stt with a JSON body instead of a file | `400` |
| any call before the secret is set and redeployed | `500 {"error":"Server missing OPENAI_API_KEY"}` |

## 2. Mac Chrome: behaviour must be unchanged

Open the site in Chrome, DevTools > Network, filter `api`, hard reload (twice, per section 0).

- [ ] The page looks the same as before: **no speaker button** beside MIC; sidebar still reads `VOICE ON` (static).
- [ ] Console: no errors on load. `speechSynthesis.getVoices().length` is above 0 (if it is 0, the server voice takes over after 3 s, which is not the Mac's normal state).
- [ ] Type a command and press Enter: the reply is spoken by Chrome's own voice, the same voice as before.
- [ ] Network shows `/api/chat` only. **No `/api/tts` and no `/api/stt`** at any point.
- [ ] Click MIC and speak: Chrome's recognition fills the field and sends it, as before. Still no `/api/stt`.
- [ ] iPhone (Safari or the home-screen app), same four checks: no speaker button, voice and mic as before.

## 3. Wall calendar (the server path)

New page live (section 0). Use the on-screen keyboard for typing.

- [ ] **Speaker button** is visible next to MIC. (If the calendar is rotated to portrait the sidebar is hidden, so this button is the only mute control.)
- [ ] After boot DEXTER shows its greeting as text but **does not speak it**. Nothing is spoken until the first touch.
- [ ] Type a command, Enter: the reply appears and is **spoken** in the server voice. Avatar shows SPEAKING, then STANDBY. A long reply starts after its first sentence and the sentences follow in order, never overlapping.
- [ ] While it is speaking, send another command: the first voice stops at once and the second reply is spoken.
- [ ] Tap the **speaker button**: icon changes to the muted one. Send a command: text only, silent, and the avatar returns to STANDBY (not stuck on PROCESSING). Tap again to turn voice back on. Muting mid-sentence stops it immediately. Reload: the setting is remembered.
- [ ] **MIC**: tap it. The mic blinks red, the field says `Recording... tap MIC`, the footer shows `● REC`, the avatar shows LISTENING. Say "what is on my calendar" and tap MIC again: PROCESSING, then your words appear in the field and are sent, then the reply is spoken.
- [ ] **15 seconds**: tap MIC and keep talking (or stay silent). At 15 s it stops by itself and sends what it has.
- [ ] Failures. Each must leave one short status line in the chat and typed chat still working, never a frozen or blank page:
  - Wi-Fi off, then send: the existing `API error` line (as before). Wi-Fi back on: works again with no reload.
  - Tap MIC, then tap it again within a second: `too short`, back to idle.
  - Microphone blocked in the kiosk settings: `microphone blocked, type instead`.
  - Secret missing or not redeployed: `Server missing OPENAI_API_KEY (text only)` after a reply, and the same line after a recording.
  - Wrong passphrase stored: tapping MIC asks for the passphrase once and retries (needs the kiosk to support the prompt dialog; if it does not, the status line says `Wrong or missing passphrase`).

## What this plan does not prove

The local checks used a faked OpenAI and desktop Chrome. These only show up on the real thing: the actual cedar voice quality, `gpt-transcribe` accuracy on the calendar's microphone, the kiosk WebView's own autoplay setting, and Wi-Fi latency (expect about 1 to 2 seconds before speech starts).
