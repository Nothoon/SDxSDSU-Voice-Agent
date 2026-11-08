# Ali UI: setup and handoff

## Checkout and provenance

Work is in `/home/ali/Documents/Codex/2026-11-08/im/work/SDxSDSU-Voice-Agent`, branch `ali/ui`, based on `ed75e1d`. Both original checkouts were clean before work. Both use `https://github.com/Nothoon/SDxSDSU-Voice-Agent.git`. The older checkout at `ace10ec` remains untouched. Its dependency-free Node/static approach informed this frontend scaffold; no teammate implementation existed in the newer checkout.

On November 8, 2026, `git fetch origin` failed with `Could not resolve host: github.com`. The connected GitHub API reported main at `ed75e1df195b88633d5fb001613fa0d5691b844b`. No successful Git pull, push, publication, or teammate contact occurred. Re-fetch before merging once Git networking works.

## Run locally

Node 22+, no installation or provider credentials needed:

```sh
npm start
npm run check
npm test
```

Open http://localhost:3000. Use the sample outline or add your own cards. Edit each title, meaning, short cue, fuller reminder, and must-mention flag. Move cards with the labeled up/down buttons. Set duration, approve, complete demo preflight (or choose text-only), and begin. Request Cue, then More; select an idea manually; Pause, Resume, and End. `C` requests a cue when focus is outside an input or button. Transcripts and simulated events live under Debug.

The application retains only in-memory state. End clears session coverage, transcript fixtures, current cue, and mock session buffers; the approved outline and aggregate recap remain for another attempt. Refresh starts over. No application audio is recorded, uploaded, or stored by this demo. This does not establish any future provider retention policy.

## Mock boundary

`public/app.js` owns UI rendering, outline edits/approval, controls, request/revision guards, timer and recap presentation. `public/demo-adapters.js` supplies isolated fixtures using the README IdeaCard and CueResponse fields. The minimal `server.mjs` serves frontend assets and a health route only.

Everything involving microphone input, connection health, coverage interpretation, selection policy, speech gaps, interruption detection, synthesis, audio routing, and audio playback is simulated. The preview explicitly plays no audio. No silence timer generates cues. Mock selection keeps a requested idea stable for repeated Cue and More; coverage is keyed by card ID so out-of-order updates preserve prior coverage. Target duration is collected and passed to session start, but priority selection near the deadline belongs to Nathan's real backend.

Do not interpret debug coverage fixtures as semantic matching. Real paraphrase handling, partial evidence, deduplication, end-of-duration prioritization, resumption timing, and acoustic echo handling remain unverified.

## Adapter handoff (provisional UI boundary, not a new shared contract)

Nathan owns shared contracts. These methods describe what the demo UI consumes; reconcile them with his actual client rather than replacing it. Replace the factory import or provide `window.threadCreateAdapters` before the app module starts. No permanent credentials may cross this boundary.

Factory returns `{ mode, session, voice, subscribe? }`. `mode` is `demo` for mocks. All session mutations return snapshots `{ coverage: Record<cardId, status>, revision, lifecycle, connection, segments }`. Revisions must be monotonic and correspond to CueResponse.stateRevision. Coverage statuses are `uncovered | partial | covered`. Lifecycle is `ready | listening | paused | ended`; connection is independent.

Nathan:

- `session.start(approvedCards, { durationSeconds })` opens a new session.
- `session.cue({ requestId, cardId, level })` returns the README CueResponse; `level` is `short | expanded`. Echo requestId. More must remain tied to the last requested idea. Manual selection may target a covered idea.
- `session.select(cardId)`, `pause()`, `resume()`, `end()` return snapshots. End closes server streams and clears application session buffers.
- Optional `subscribe(callback)` emits `{ type: 'state', state }` for authoritative newer snapshots, or `{ type: 'error', message }`. Wire state events only after the active start call resolves. Preserve last reliable coverage on disconnect.
- `session.fixture(...)` exists only in the demo. Replace/hide mock debug controls for the live client; never apply fixtures to a live session.

Vineet:

- `voice.start()`, `pause()`, `stop()` resolve after their lifecycle operation; Pause must suspend transmission, stop playback, and cancel pending work. Stop closes tracks/streams and clears audio buffers.
- `voice.preview()` provides a real audible routing check when connected. Adjust preflight presentation with the real adapter; current copy explicitly describes simulation.
- `voice.play(cueResponse)` manages one playback at a time, speech-gap gating, stale/overlap cancellation and text fallback. `voice.cancel()` is synchronous and cancels pending/current playback.
- Emit `{ type: 'speaker-resumed' }` to invalidate UI requests; the voice controller itself must stop playback immediately, without waiting for UI rendering.

The UI rejects stale request IDs, outdated revisions and cue results after manual selection, coverage changes, Pause or End. UI invalidation calls voice cancellation. Real adapters must enforce cancellation internally too, including already queued provider work. Current UI preflight copy and debug fixtures must be adapted when real integrations land; injecting a factory alone is not a completed integration.

## Verification

`npm run check` syntax checks the preview server, UI and adapters. `npm test` runs Node tests covering lifecycle, More identity, out-of-order coverage preservation, disconnect, clearing session state at End, late responses after invalidation/End, and same-idea text fallback on error.

A Playwright browser suite is included in `tests/browser.cjs`. Run `npm start` in one terminal. With Playwright available, run `npm run test:browser`; alternatively set `PLAYWRIGHT_MODULE` to an existing Playwright package path. It uses desktop 1440×1080 and mobile 390×844, exercises the main controls, checks horizontal overflow and JS errors, and writes screenshots under `/tmp/thread-*.png`. Playwright is deliberately not added to the shared manifest while network installation is unavailable.

Browser verification could not run in this environment: binding `127.0.0.1:3000` failed with `EPERM`; cached Chromium failed on sandbox socket initialization; computer-use inventory returned no browsers. No desktop/mobile visual QA or real earbud/microphone checks are claimed. Run this suite and visually review screenshots before a demo. Then verify permission denial, STT disconnect, TTS failure, rapid cue requests, speech resumption during actual audio, Pause/End track shutdown, and the shared Daytona preview with the owners' adapters.

## Requested design tools

No installed Impeccable or Apple Design skill was found in the local skill/plugin locations. Apple Design was read through the connected GitHub tool and its typography, immediate feedback, system font, agency, and reduced-motion guidance informed the UI. No installation is claimed. Playwright MCP is not exposed as a connected tool. Cached Playwright packages and Chromium exist, but the execution restrictions above prevent launching them. No configuration was overwritten or new dependency installed.
