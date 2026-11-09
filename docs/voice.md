# Thread voice adapter (Vineet's workstream)

Live transcription (ElevenLabs Scribe realtime), approved-cue synthesis (ElevenLabs TTS), and the browser voice controller. Started on branch `vineet/voice` on top of `nathan/backend`. **Vineet has not reviewed it yet.**

## Run

```bash
npm install
cp .env.example .env      # add ELEVENLABS_API_KEY for live voice; without it the voice is SIMULATED
npm start                 # builds the browser bundle, then serves the API and the voice test page
npm test
```

Open `/voice-demo/` on the server. On the Daytona preview the URL is `https://3000-<DAYTONA_SANDBOX_ID>.proxy.daytona.works/voice-demo/`. This page is a developer test harness, not the product UI.

Use it in this order:

1. Pick an outline preset (cast-iron sample or README demo) or edit its JSON, then Create & approve. Cue audio is prepared automatically.
2. Pick the earbud, then press Preview.
3. Press Start and speak.
4. Press Cue (Space) or More (M).
5. Use Pause, Resume and End.

The log shows each playback's request-to-audible-start and speech-onset-to-stop latency.

Without `ELEVENLABS_API_KEY`, the server runs the **SIMULATED** mock provider. A banner on the page says so. Transcript input is typed into a text box, and cue audio is a placeholder tone, not speech.

## Pieces

| Path | Runs in | Role |
| --- | --- | --- |
| `src/server/voice/elevenlabs.ts` | server | Creates single-use STT tokens and calls TTS. The key never leaves the server. |
| `src/server/voice/mock.ts` | server | SIMULATED provider: tone WAVs, no STT. |
| `src/server/voice/cache.ts` | server | Cue audio cache keyed by voice + text; editing a card invalidates its entry. |
| `src/server/voice/routes.ts` | server | Voice routes and the test page. |
| `src/voice/core/*` | both | DOM-free logic with unit tests: transcript normalization, echo stripping, energy VAD. |
| `src/voice/browser/mic.ts` | browser | `getUserMedia` (echo cancellation on) → AudioWorklet → 16 kHz PCM16, 50 ms frames. |
| `src/voice/browser/controller.ts` | browser | `ThreadVoiceController`: the interface in `src/voice/types.ts`. |
| `src/voice/demo/` | browser | Test page. |

## Server routes

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/sessions/:id/voice/stt-token` | `{ token, wsUrl }`. Allowed only for `ready`, `listening` or `paused` sessions. The token is single-use and expires after 15 minutes (per ElevenLabs SDK docs). Returns 503 with the mock provider. |
| POST | `/api/sessions/:id/voice/prepare` | Synthesizes short and expanded audio for every approved card, three at a time. Call it after approval. |
| GET | `/api/sessions/:id/voice/cue-audio?cardId=&level=short\|expanded` | Audio for that card's approved text only, so this is not an open TTS proxy. Returns 409 before approval and 404 for an unknown card. The `X-Thread-Simulated` header marks mock audio. |
| GET | `/api/voice/preview-audio` | A fixed phrase for the earbud check. |

The routes also set `providers.tts` on the session:
- `connected` when real synthesis succeeds.
- `degraded` when the mock provider is in use.
- `disconnected` when synthesis fails.

## Browser controller (for Ali)

```ts
import { createVoiceController } from "../voice/index.js";
const voice = createVoiceController({ apiBase: "", simulated: false });

voice.on("transcript", (seg) => …);        // partial + final, after echo filtering
voice.on("connection", (status, detail) => …);
voice.on("speaking", (active) => …);
voice.on("playback", (e) => …);            // waiting | playing | stopped(reason)
voice.on("error", (msg) => …);             // e.g. "Microphone permission was denied"

await voice.prepare(sessionId);             // after POST /approve
await api.start(sessionId); await voice.start(sessionId);
const cue = await api.cue(sessionId, "short");
showText(cue.text);                         // always show text first
await voice.playCue(cue);                   // resolves with the stop reason
voice.pause(); voice.resume(); voice.end(); // call alongside the backend lifecycle routes
```

The controller never chooses a cue or calls `/cue`, `/start`, `/pause` or `/end`. The UI calls those backend routes and the matching controller method. With `simulated: true`, the controller needs no microphone or key. `simulateSpeech(text)` then produces partial and final segments and speaker activity, and playback still works.

## Behavior

- **Transcription.** The browser fetches a token and opens `wss://api.elevenlabs.io/v1/speech-to-text/realtime`. Settings are `model_id=scribe_v2_realtime`, `audio_format=pcm_16000` and `commit_strategy=vad`. It sends `input_audio_chunk` messages.
  - A `partial_transcript` becomes `isFinal: false`. These are throttled to about 3 per second.
  - A `committed_transcript` becomes `isFinal: true`.
  - Both parts of one utterance share the ID `<run>-<connection>-<n>`.
  - Segments are POSTed to `/segments` one at a time, in order.
- **Timestamps.** `startMs` and `endMs` are on the controller's clock, measured when messages arrive. They trail real speech by the recognition delay and only serve to order segments.
- **Pause and End.** Both close the WebSocket, stop the mic tracks so the browser's recording indicator turns off, and stop playback. Resume reconnects with a new token. End also reports STT `disconnected` and frees the cached audio.
- **Unexpected disconnect.** The controller reports `stt: disconnected` and retries up to 3 times (1, 2, then 3 s apart). Up to 2 s of audio is buffered while it reconnects.
- **No overlap.** Each `playCue` replaces the previous one (`superseded`). A cue whose `stateRevision` is not newer than the last one handled is ignored (`stale`). Nothing queues.
- **Speech gap.** If the speaker is talking when a cue arrives, the controller emits `waiting` and plays only after a pause. If no pause comes within 3 s, it drops the cue (`speaker-continued`), and the speaker can ask again.
- **Speaker resumption.** A local energy VAD needs 120 ms of sustained level to detect speech. During playback its threshold doubles to resist echo. Detected speech stops playback immediately (`speaker-resumed`). The VAD never triggers a cue.
- **Echo exclusion.** Three layers:
  1. The earbud.
  2. Browser `echoCancellation`.
  3. `stripEcho`: a final segment that overlaps a playback window (plus 1.5 s) and consists mostly of cue words is dropped, and an echoed cue prefix is removed. Speaker words that aren't cue words are kept, so interruptions still reach coverage.
- **Output routing.** `setOutputDevice` uses `HTMLMediaElement.setSinkId`. It returns `false` where the browser doesn't support it (e.g. some Safari/Firefox versions), in which case use system output settings.
- **Privacy.** No audio is recorded. Transcripts live only in session memory. Logs contain no audio, keys or transcript text. This says nothing about ElevenLabs-side retention, which has not been checked.

## Verified so far

- `npm test`: unit tests for normalization, echo stripping and the VAD. Route tests with the mock provider cover approved-text-only audio, caching, invalidation after an edit, preparation, the token rejection in mock mode, and TTS shown as `degraded` for the mock.
- Headless Chromium with a fake microphone, against the mock server:
  - The mic worklet produces 50 ms frames of 1600 bytes (16 kHz PCM16).
  - Through the test page, in simulated-input mode: Cue played to the end; a rapid second More superseded the first with no overlap; simulated speech during a cue stopped it; Pause and End worked.
  - Request→audible start was 5–51 ms with locally cached tone audio. This isn't representative of the demo setup.

## Not verified (needs an ElevenLabs key and real hardware)

- Live Scribe connection, message flow and transcript quality. The protocol was taken from the `@elevenlabs/client` 1.35.0 and `@elevenlabs/elevenlabs-js` 2.77.0 source because the docs site couldn't be reached from the sandbox.
- Live TTS, and whether the default voice ID `JBFqnCBsd6RMkjVDRZzb` is valid for the account.
- Real-earbud routing, the VAD thresholds against real rooms and voices, echo behavior with speakers instead of an earbud, and the 500 ms start and 250 ms stop targets.
- The Daytona preview from an actual browser (`getUserMedia` needs HTTPS, which the preview provides).

## Auto Hint

Opt-in, off by default for each session. Spec: [docs/features/auto-hint-next-idea.md](features/auto-hint-next-idea.md).

**Who decides what:**
- **When** (voice controller, the only timer): `AutoHintScheduler` in `src/voice/core/autohint.ts`, fed by the mic VAD's speech start and stop. It never relies on missing transcripts, and no model judges whether the speaker is stuck. Defaults are starting values to tune in rehearsal:
  - 3.5 s of continuous silence triggers a hint.
  - At least 1 s of speaker speech is needed since the start, a resume, toggling on, or the last hint.
  - 10 s minimum between automatic hints.
  - It waits up to 2.5 s for a transcript still in progress, then gives up on that pause.
- **Whether** (server): `POST /cue` with `{ source: "auto" }`. It waits up to 2.5 s for coverage to settle, then returns 409 if tracking isn't `ok`, STT or coverage is disconnected, or an automatic hint played in the last 10 s. Manual hints are never gated this way.
- **What** (server + UI): the approved short cue for the current idea. If that idea is already covered, the next uncovered idea forward, as with Next Idea. Past the end of the outline it stays silent.

**Controller API:**
- `setAutoHint(enabled)`, plus `autoHint` and `autoHintStatus` events (`off`, `waiting`, `armed`).
- `playCue(cue, { auto: true, triggeredAt })` drops an automatic cue if the speaker spoke after the pause began.
- `markHintShown()` for text-only hints.
- Turning Auto Hint off stops a playing automatic cue, not a manual one. Pause and End clear the timer, and Resume needs fresh speech before it can fire.
- In simulated (typed) mode, practice speech lasts 250 ms per word, so typed sentences can arm it.

**Verified:**
- `test/autohint.test.ts` uses fake clocks for every timing case in the spec table, plus the server gate: uncertain, unavailable or disconnected tracking, unsettled coverage, cooldown, and the paused state.
- Headless Chromium, live ElevenLabs STT and OpenAI coverage, a fake mic playing one spoken sentence followed by 8 s of silence, Auto Hint on in the speaker UI:
  - About 4 s after the speech ended, "Your pitch story" played by itself.
  - Continued silence did not repeat it.
  - After the next stretch of speech, a second automatic hint came 11.5 s after the first.
  - The recap showed 2 automatic hints, with no JS errors.

**Not verified:**
- A real microphone, room noise and an earbud. VAD thresholds and the 3.5 s pause need rehearsal.
- Whether echo from cue audio played through speakers (not an earbud) can count as speaker speech.
- Next Idea's double-activation and held-key cases in a real browser. The UI already ignores key repeats and blocks input while a cue is busy.
