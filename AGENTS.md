# Thread: instructions for every coding agent

Read README.md for the product specification, planned data contracts, cue rules, and acceptance cases. Then read the role brief matching the person you are helping:

| Person | Assignment | Required role brief |
| --- | --- | --- |
| Ali | UI and integration coordination | docs/roles/ali-ui.md |
| Nathan | Daytona, backend, session state, coverage, cue selection | docs/roles/nathan-daytona.md |
| Vineet | ElevenLabs transcription, synthesis, browser voice adapter | docs/roles/vineet-elevenlabs.md |

If the user's identity or assignment is absent, ask which role you are implementing before making role-specific changes. You may inspect the repository first. Do not assume every new agent should implement the whole application.

## Collaboration boundaries

- Work within your assigned responsibility. Cross-role changes require coordination with the owner or explicit user instruction; document any necessary handoff.
- Existing repository code takes precedence over proposed directory names in the briefs. Inspect the latest branch and instructions before editing. Do not replace another person's implementation to match an old plan.
- On an empty implementation, coordinate one stack before scaffolding. Ali owns the frontend scaffold, Nathan the backend scaffold and shared contracts, Vineet the voice module. Do not independently scaffold three applications.
- Suggested boundaries are `src/ui/` (Ali), `src/server/` (Nathan), `src/voice/` (Vineet), and `src/shared/` (Nathan, coordinated). They are proposed until the stack is agreed; frameworks may require different paths.
- The root package manifest, lockfile, shared types, environment example, and run instructions are shared integration surfaces. Coordinate changes and preserve others' dependencies and scripts. Never overwrite a lockfile to resolve a conflict without reconciling its manifest.
- Use a separate branch for each role, such as `ali/ui`, `nathan/backend`, and `vineet/voice`. Avoid concurrent pushes to the default branch. Open a PR for implementation work unless the user requests another workflow.
- Use mocks behind the agreed interfaces to start independently. Clearly label simulated data and failures; do not present mocks as live integrations.
- Do not message teammates or their chats without explicit user authorization. Record handoffs in the PR or task summary when direct coordination is unavailable.

## Current feature assignment

Read [Auto Hint and Next Idea](docs/features/auto-hint-next-idea.md) when implementing cue behavior. The user authorized opt-in automatic hints and a dedicated Next Idea button. That brief supersedes older manual-only guidance in role briefs and integration notes; other ownership and security rules still apply.

## Non-negotiable product behavior

- Thread follows approved ideas and gives minimal reminders. Manual Hint and Next Idea remain available. Automatic speech is allowed only when the user enables Auto Hint, under the pause, rearming, cancellation, and lifecycle rules in docs/features/auto-hint-next-idea.md.
- Preserve coverage when points are paraphrased or reordered. More expands the last cue and does not advance the idea.
- Prevent overlapping playback and discard stale responses. Speaker resumption interrupts cue audio.
- Pause and End stop mic transmission and playback. End also clears application session buffers and closes streams.
- Keep provider keys server-side. Browser transcription uses an appropriate short-lived credential or a server relay. Never expose permanent ElevenLabs, Daytona, or model keys to the browser or logs.
- Default to session memory, no application-side recording, and no persistent transcripts. Do not claim provider-side deletion or zero retention without verifying it.
- Run relevant checks for your component and document exact setup steps, remaining integration dependencies, and any unverified behavior. Planned latency goals are not measured performance claims.

The first shared milestone is a real microphone → transcript → coverage → requested cue → earbud loop on the Daytona preview.
