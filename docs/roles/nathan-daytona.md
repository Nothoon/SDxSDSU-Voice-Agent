# Nathan — Daytona, backend, and intelligence

## Your mission

Make Thread's backend run in Daytona and turn finalized speech into reliable coverage and cue decisions. Read root AGENTS.md and README.md first.

## Own

- Backend scaffold, server runtime, session lifecycle, shared types, and service contracts; suggested boundaries: `src/server/` and `src/shared/`.
- Daytona sandbox setup, startup commands, team preview access, environment configuration, and reproducible restart instructions.
- Server-side secrets for Daytona, ElevenLabs, and the chosen coverage model; collaborate with Vineet on the speech integration.
- Receiving finalized transcript segments, deduplication, revisions, coverage with evidence, and stale-result rejection.
- Selecting short/expanded cues deterministically from approved cards, including partial ideas, reordered points, must-mention priority, and completion.
- Session cleanup, provider error states, and text/manual fallback when tracking is unavailable.

## Keep the workload manageable

Use one small backend and in-memory session state first. Do not add a database, accounts, or dynamic per-user sandboxes for this demo. Daytona runs the application; choose a separate model/API for semantic coverage. A fixture-based backend can unblock both teammates before model integration.

## Handoffs

- **Nathan → Ali:** A documented session/transcript/cue contract, fixtures, state events, and the working preview URL. Choose transport once and keep both teammates informed.
- **Nathan → Vineet:** Server integration boundary for the ElevenLabs adapter, environment variable names, and short-lived credential or relay integration.
- **Vineet → Nathan:** Provider adapter, transcript event shape, cue-audio result shape, provider errors, and cancellation behavior.

Document actual API routes or socket messages after implementation; the README types are a starting agreement, not existing endpoints. Keep shared credentials out of Git. Verify preview authentication, browser microphone permission, and any socket connectivity on the real demo browser.

## First deliverable

Backend accessible from the Daytona preview, with one approved outline and transcript fixtures demonstrating paraphrased coverage and correct next-cue selection. Then replace fixtures with Vineet's finalized transcript stream.

## Done when

- A teammate can start/restart the service using documented commands and configure secrets from a placeholder-only `.env.example`.
- Paraphrases and reordered points produce evidence-backed coverage; delayed responses cannot overwrite newer state.
- More refers to the same idea; covered points are skipped; all-covered sessions generate no new spoken content.
- Pause/End and disconnect cleanup work with the client and voice adapter.
- Relevant README acceptance cases pass and measured behavior is reported honestly.

## Starting prompt for Nathan's agent

> I am Nathan. Implement Thread's Daytona environment, backend, shared contracts, session state, semantic coverage, and cue selection. Read AGENTS.md, README.md, and docs/roles/nathan-daytona.md first. Inspect current code, coordinate one stack with Ali, and expose a small documented interface for Ali and Vineet. Start with an in-memory backend and transcript fixtures, then integrate live speech. Keep secrets server-side.
