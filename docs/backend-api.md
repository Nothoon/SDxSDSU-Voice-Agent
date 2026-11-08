# Thread backend API (Nathan)

Small Node + TypeScript server with in-memory sessions. Types live in [`src/shared/types.ts`](../src/shared/types.ts); change them only in coordination with Nathan.

## Run

```bash
npm install
cp .env.example .env   # optional; defaults run in mock mode
npm start              # or: npm run dev (restarts on change)
npm test               # acceptance tests for tracking and cue rules
npm run demo:fixtures  # drives a running server through the demo flow
```

- Default port `3000`, bound to `0.0.0.0`.
- Daytona preview: `https://3000-<DAYTONA_SANDBOX_ID>.proxy.daytona.works` (printed at startup). **Not yet verified from a browser.**
- Restart: stop the process (Ctrl+C) and run `npm start` again. Sessions are in memory and are lost on restart.

### Coverage provider

| `COVERAGE_PROVIDER` | Behavior |
| --- | --- |
| `mock` (default) | **SIMULATED.** Word-overlap heuristic; weak on paraphrase. `providers.coverage` reports `degraded`. |
| `claude` | Claude (`COVERAGE_MODEL`, default `claude-opus-5-5`) with structured output, low effort, and server-side refusal fallback. Requires `ANTHROPIC_API_KEY`. |

## Transport

JSON over HTTP for commands, Server-Sent Events for state. Every event includes the full `SessionState`, so clients replace state instead of merging it. CORS uses `ALLOWED_ORIGIN` (default `*`).

## Routes

All under `/api`. Errors return `{ "error": string }` with 400, 404, or 409.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/health` | | `{ ok, coverage, voice: { provider, simulated, stt } }` |
| GET | `/fixtures/outline` | | `{ outline: IdeaCard[] }` (README example) |
| POST | `/sessions` | `{ outline?, targetDurationSec? }` | `SessionState` |
| GET | `/sessions/:id` | | `SessionState` |
| PUT | `/sessions/:id/outline` | `{ outline, targetDurationSec? }` | `SessionState` (resets approval) |
| POST | `/sessions/:id/approve` | | `SessionState` (`draft → ready`) |
| POST | `/sessions/:id/start` \| `pause` \| `resume` \| `end` | | `SessionState` |
| POST | `/sessions/:id/segments` | `{ segment }` or `{ segments: [] }` | `{ accepted, ignored }` |
| POST | `/sessions/:id/cue` | `{ level: "short" \| "expanded" }` | `CueResponse` |
| POST | `/sessions/:id/select` | `{ cardId \| null }` | `SessionState` |
| POST | `/sessions/:id/coverage` | `{ cardId, status }` | `SessionState` (manual correction) |
| POST | `/sessions/:id/providers` | `{ provider: "stt" \| "tts", status }` | `SessionState` |
| GET | `/sessions/:id/recap` | | `SessionRecap` |
| GET | `/sessions/:id/transcript` | | `{ segments }` (debug view only) |
| GET | `/sessions/:id/events` | | SSE stream of `SessionEvent` |
| POST | `/sessions/:id/voice/stt-token` | | `{ token, wsUrl, simulated }` single-use ElevenLabs STT token ([voice.md](voice.md)) |
| POST | `/sessions/:id/voice/prepare` | | `{ prepared, failed, simulated }` pre-synthesizes approved cues |
| GET | `/sessions/:id/voice/cue-audio?cardId&level` | | Audio for an approved cue |
| GET | `/voice/preview-audio` | | Audio for a fixed earbud-check phrase |

Lifecycle: `draft → ready → listening ↔ paused → ended`.

## Behavior guaranteed by the server

- Only finalized segments (`isFinal: true`) affect coverage. Partial segments are relayed as `partialTranscript` events. Duplicate segment IDs are ignored. Segments sent while paused or ended are dropped.
- Coverage updates must reference known card IDs and real segment IDs, or they are rejected and `trackingStatus` becomes `uncertain`. A "covered" result below 0.6 confidence is held at `partial`.
- Coverage only moves forward and never overrides a manual correction.
- Results computed for an older transcript revision are discarded. One evaluation runs at a time; newer speech queues at most one follow-up.
- If the coverage provider fails, `trackingStatus` becomes `unavailable`, the last coverage is kept, and Cue continues from it.
- Cue selection is deterministic: manual selection, then the partial idea in progress, then (in the final 20% of the target duration) an uncovered must-mention idea, then the next uncovered idea in approved order.
- Cue text always comes from approved card fields. Repeated short Cues reuse the same card until new speech or a manual change. `expanded` (More) always expands the last cue's card.
- When every idea is covered, Cue returns `cardId: null` with the text "All points covered." Clients should show it and not play audio.
- Each `CueResponse` has a new `requestId` and a higher `stateRevision`. The client plays only the newest one.
- End clears transcript buffers and aborts in-flight coverage. Coverage and counters stay available for the recap.

## Integration notes

- **Ali:** subscribe to `/events`, render `state.coverage`, `state.lastCue`, `trackingStatus`, and `providers`. Use `/select` and `/coverage` for the manual card selector.
- **Vineet:** the voice adapter POSTs segments to `/segments` and reports STT/TTS health with `/providers`. `CueResponse.audioUrl` stays unset; the voice controller builds the `/voice/cue-audio` URL from `cardId` + `level` + text. Echo exclusion happens in the voice adapter. See [voice.md](voice.md).
