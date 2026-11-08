# Ali — UI and speaker experience

## Your mission

Build the interface that makes Thread easy to prepare and discreet to use while speaking. Own integration coordination and the demo flow.

Read the repository root `AGENTS.md` and `README.md` before implementation.

## Own

- Frontend scaffold and visual components; suggested boundary: `src/ui/`.
- Outline editor: create, edit, reorder, approve cards; mark must-mention points and set duration.
- Preflight screen: explicit microphone start, earbud/volume preview, clear connection status.
- Minimal speaking screen: coverage, selected cue, Cue, More, manual card selection, Pause, End.
- Text fallback and visible degraded states; keep full transcript/debug output outside the primary speaking view.
- Lightweight session recap after the main loop works.
- Integrating Nathan's state/service client and Vineet's audio controller into the UI.

## Start without blocking

Use the README example outline and mock coverage/cue events. Implement the entire user flow before real provider wiring. Label mock mode visibly.

## Handoffs

- **Nathan → Ali:** Session lifecycle, coverage updates, cue responses, connection/error states, documented backend connection details.
- **Vineet → Ali:** Voice start/pause/stop, cue preview/play/cancel, transcript callbacks, speaker-resumption and connection events.
- **Ali → both:** Controls and event wiring, reproducible UI steps, browser/device failures found during integration.

Ali owns buttons and rendering. Vineet owns microphone/playback internals. Nathan owns tracking and next-idea decisions. Do not duplicate their logic in components.

## Done when

- A user can prepare an outline, start, request a cue, request More, pause, resume, and end without developer help.
- The actual Daytona preview works on the demo browser, with visible errors if microphone permission is denied or a provider disconnects.
- Playback and microphone behavior are verified with Vineet; stale responses cannot visibly replace the current cue.
- Setup commands and the integration procedure are documented after the stack exists.

## Starting prompt for Ali's agent

> I am Ali. Implement Thread's UI and speaker experience. Read AGENTS.md, README.md, and docs/roles/ali-ui.md first. Inspect current code, stay within my ownership, and use mocks for unfinished backend/voice interfaces. Coordinate shared contract changes rather than implementing Nathan's or Vineet's work. Build toward the first end-to-end demo checkpoint.
