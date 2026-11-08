# Ali UI: integrated frontend

The replacement UI lives in `src/ui/` and is served at `/` by Nathan's existing server. It replaces the removed `public/` demo. Backend session/coverage logic and Vineet's voice controller are reused directly.

## Run

Node 22+:

```sh
npm ci
npm start
```

Open `http://localhost:3000/`, or the root of the existing Daytona preview. Startup builds both browser bundles. `npm run dev` watches server code; after frontend edits run `npm run build:ui` and reload. No separate UI server or new provider keys are needed.

To test without consuming provider credits:

```sh
VOICE_PROVIDER=mock COVERAGE_PROVIDER=mock npm start
```

## User flow

1. **Your ideas:** Load a sample or add/edit/reorder/delete cards. Each has a title, meaning, short approved hint, fuller reminder, and must-mention flag. Choose a duration and Review setup.
2. **Your setup:** Review session mode. Optional audio hints have an output selector, preview, and an explicit confirmation that the preview was heard. Text hints work with audio off. Live transcription still uses the microphone with audio hints off.
3. **Your moment:** Hint reminds the current idea, More expands the last presented hint, and Next Idea selects the next later unfinished card and requests its approved short hint. When the focused idea becomes covered, the screen automatically advances to the next unfinished idea in outline order, skipping covered ideas and returning to earlier missed ideas if needed. Completing every idea shows “All points covered.” This visual advancement clears stale hints without requesting or playing audio. Partial coverage preserves focus; manual selection can still revisit already covered ideas. Pause/Resume and End call both the backend and voice lifecycle. The recap uses server counts and coverage.

Keyboard shortcuts: H or C for Hint, M for More, Right Arrow for Next Idea. Shortcuts ignore editing controls, links, buttons, dialogs, held keys, and modifier combinations.

## Integration boundaries

- `src/ui/app.ts`: Client rendering, approved outline edits, HTTP commands, SSE subscription, user intent/cancellation, device settings, and recap.
- `src/ui/model.ts`: Card validation, automatic focus advancement, forward-only Next selection, shortcut eligibility, and time formatting.
- `src/ui/routes.ts`: Allowlisted product HTML/CSS/bundle routes only. `src/server/app.ts` adds these to the existing route list; no backend session policy is replaced.
- Shared contracts remain in `src/shared/types.ts`. Voice input, provider calls, echo handling, and playback stay in Vineet's controller.
- The UI consumes real `/api/sessions` lifecycle routes and `/events`; state revisions cannot move backward. Stale hint results after new intent, new finalized speech, Pause, End, or session changes are discarded. Pause/End stay available during hint requests.
- Next uses the existing `/select` then `/cue` routes. Focus is separate from coverage in the UI; selection does not claim the speaker covered a point. This is a compatibility implementation until Nathan provides an authoritative active-idea/Next command. The backend's `selectedCardId` persists and manual focus is not automatically inferred from reordered speech.
- More is cleared after automatic or manual focus changes or new speech, so it cannot unexpectedly expand an earlier card.
- On microphone startup failure, the UI stops input and attempts to pause the backend. If a lifecycle request fails, input is still stopped and End can be retried. Text hints remain visible when audio fails.
- End closes the event stream and mic/controller; the server clears transcript buffers. The outline stays in browser memory for another attempt. Refresh resets the frontend. No persistence was added.

## Import slides or docs

On the ideas screen, **Import slides or docs** opens a dialog that takes a PDF, PowerPoint (.pptx), Word (.docx), or text file up to 10 MB, or pasted notes, and posts it to `POST /api/outline/generate`. The returned cards replace the current draft list. They stay editable and still go through the usual review and **Review setup** approval, so approved cards remain the source of truth. With the simulated import provider the dialog and the success notice say so, and PDFs are refused with guidance.

## Provider modes and remaining feature work

`/api/health` chooses live or simulated input. With mock voice, the microphone is never opened; typed practice speech is passed through the real voice adapter to the backend. Mock audio is a placeholder tone, and mock coverage is word matching. These are visibly labeled and do not establish live speech quality.

The opt-in Auto Hint proposal remains in PR #3. This UI implements manual Hint and Next using the current main API. It does not add a competing automatic scheduler or claim Auto Hint is implemented. Nathan still owns authoritative focus/inference ordering and eligibility; Vineet owns activity timing. Reconcile those contracts before automatic cues.

## Verification

`npm test` includes backend/voice tests plus UI selection, validation, keyboard eligibility, and same-origin route checks. `npm run typecheck`, `npm run build:ui`, and `npm run build:voice` validate types and browser bundles.

Browser checks passed in the in-app browser against the real local API with mock providers: add/approve an outline, Hint/More/Next, typed-speech coverage updates, Pause disabling hints, Resume, End, recap, and responsive layout at desktop and 390×844 phone sizes, with no horizontal overflow or browser JavaScript errors. Live ElevenLabs speech, real microphone/earbud routing, latency targets, and Daytona-hosted browser behavior still require hardware/provider verification.

## Handoff

Slide/doc import (branch `vineet/document-import`) was added at the user's request across roles: `src/server/outline/` and the `/api/outline/generate` route for Nathan to review, and the import dialog in `src/ui/app.ts`/`styles.css` for Ali. It adds no dependency (PPTX/DOCX are read with a small built-in zip reader) and no shared-type changes.

Ali owns `src/ui/`. Nathan retains `src/server/`, shared contracts, and Daytona startup. Vineet retains `src/voice/` and speech providers. Build changes reuse the existing esbuild dependency, preserve the lockfile, and add no runtime dependency. The developer `/voice-demo/` remains available.
