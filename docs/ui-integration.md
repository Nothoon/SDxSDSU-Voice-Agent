# Ali UI: redesign handoff

Ali requested removal of the previous frontend. Its assets, simulated UI adapters, standalone static server, and UI-only tests have been removed. No replacement product UI is included in this change.

The backend and ElevenLabs voice implementation remain intact. The `/voice-demo/` page is Vineet’s developer test harness, not the removed product frontend.

## Starting the replacement UI

- Ali owns the design, frontend controls, and integration coordination. Read the root `AGENTS.md` and `docs/roles/ali-ui.md` first.
- Inspect `docs/backend-api.md`, `docs/voice.md`, and actual shared types in `src/shared/types.ts` before choosing interfaces. The removed demo adapter is not the live API contract.
- Preserve Nathan’s backend and Vineet’s voice controller. Build the replacement UI against those interfaces, keeping provider secrets on the server.
- The Auto Hint / Next Idea proposal is in PR #3. Read that brief when implementing those controls; do not restore the old UI to consume it.
- Add verified frontend run commands and meaningful UI checks when the replacement exists. There is currently no `start:ui` or browser UI test command.

## Remaining runnable components

Use Node 22+, run `npm ci`, and run `npm start` for the backend and `/voice-demo/` developer harness. `npm test` runs backend/voice tests; `npm run typecheck` checks TypeScript. See the backend and voice documentation for configuration and provider behavior.
