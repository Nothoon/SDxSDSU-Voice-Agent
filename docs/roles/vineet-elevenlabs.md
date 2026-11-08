# Vineet — ElevenLabs and voice behavior

## Your mission

Make Thread listen continuously and deliver short, controlled reminders through an earbud. Read root AGENTS.md and README.md first. Verify current ElevenLabs documentation before implementation.

## Own

- ElevenLabs live speech-to-text adapter and browser microphone/audio capture.
- Normalizing partial/final transcript events to the shared types, with stable IDs and timestamps.
- ElevenLabs synthesis for approved short and expanded cues; prepare/cache audio after outline approval and invalidate it when text or voice changes.
- Browser voice controller: start, pause, resume, end, preview, play, and immediate cancellation; suggested boundary: `src/voice/`.
- Detecting speaker resumption, stopping playback, avoiding overlapping cues, and handling echo without losing the speaker's interruption.
- Provider connection/error callbacks and audio-device preflight behavior.
- Server-side ElevenLabs provider code, coordinated with Nathan's server boundary.

## Start without blocking

Prove mic → transcript first. Separately play one fixed approved cue through the real earbud. Supply a mock voice controller to Ali while provider wiring is unfinished.

## Handoffs

- **Vineet → Nathan:** Finalized transcript events and server provider adapter; document audio format, timing, cancellation, errors, and credentials required.
- **Nathan → Vineet:** Session state, server credential/relay boundary, approved cue text/card IDs, and current request revision.
- **Vineet → Ali:** Audio controller and callbacks for transcript, connection state, playback, and speaker activity. Ali owns the visible controls.

Do not choose the next idea or mark coverage inside the voice adapter. Do not let a conversational agent automatically respond after every pause. Thread's application decides whether a requested cue is eligible to play.

Never embed a permanent API key in the browser. Use a supported short-lived credential or server relay, coordinated with Nathan. Do not build a second backend solely for this adapter.

## Done when

- Real microphone speech produces finalized transcript segments in the agreed shape.
- Short and expanded approved cues are audible through the demo earbud and have a text fallback.
- Speaker resumption stops playback; rapid requests do not produce a queue; stale synthesis results are discarded.
- Assistant audio is excluded from coverage evidence while speaker interruption remains captured.
- Pause/End stop mic transmission and playback, release resources, and close relevant provider connections.
- The loop works from the Daytona preview on the actual browser; document latency measurements and limitations rather than assuming targets are met.

## Starting prompt for Vineet's agent

> I am Vineet. Implement Thread's ElevenLabs live transcription, approved-cue synthesis/cache, and browser voice controller. Read AGENTS.md, README.md, and docs/roles/vineet-elevenlabs.md first. Inspect existing code and current provider docs. Coordinate server credentials and contracts with Nathan and controls with Ali. Keep cue selection outside the audio adapter and verify the real microphone/earbud loop.

## Pull this handoff and start

This is an implementation assignment, not a claim that live voice is already built. At the time this handoff was written, remote `main` contained the product plan and role briefs only. Inspect the latest remote branches before selecting paths; teammates may have added implementation since then. Do not copy an uncommitted local prototype or assume an endpoint exists.

In a clean existing checkout:

```sh
git status --short
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c vineet/voice
```

If there are local changes, preserve them before switching. If `vineet/voice` already exists remotely, use `git switch --track origin/vineet/voice` instead of creating it; if it already exists locally, switch to it and pull its upstream with `--ff-only`. Never reset or force-push to make these commands succeed.

For a fresh checkout:

```sh
git clone https://github.com/Nothoon/SDxSDSU-Voice-Agent.git
cd SDxSDSU-Voice-Agent
git switch -c vineet/voice
```

Read `AGENTS.md`, `README.md`, and this file, then inspect all committed code. If Ali's frontend or Nathan's backend exists only on another branch, agree on the integration base before wiring it in. Do not merge an unfinished teammate branch without coordination. There are no verified install/run commands in this documentation-only baseline; document the actual commands once the shared scaffold exists.

## Copy this to Vineet's lead agent

```text
I am Vineet, responsible for Thread's ElevenLabs voice workstream.
Read AGENTS.md, README.md, and docs/roles/vineet-elevenlabs.md.
Inspect current code and remote branches before editing. Work on vineet/voice.

Deliver a small voice module that connects real microphone speech to normalized
transcript events and plays only approved, explicitly requested cue text.
Use the existing stack. Ali owns UI/scaffolding; Nathan owns the backend,
shared contracts, session state, coverage, cue selection, and Daytona setup.
Do not build a separate application or conversational agent.

First write a short interface/ownership note, then split work between the
transcription, synthesis, and browser-controller agents described below.
Use separate worktrees/branches for independently editing agents, with one
integrator owning shared changes. If delegation is unavailable, implement
these tasks sequentially. Verify current official ElevenLabs documentation
before choosing SDK methods, streaming formats, or credential lifetimes.

Start with microphone -> one final transcript and one fixed approved cue
through the real earbud. Supply explicit mocks while integration is pending.
Then integrate cancellation, interruption, pause/end, stale-result rejection,
and visible error callbacks. Never put permanent credentials in the browser.

Run relevant checks and record what passed, failed, or needs hardware/keys.
Commit only your work, push the role branch, and open an implementation PR
targeting main. Return the commit SHA, PR link, setup commands, interface note,
and exact remaining handoffs to Ali and Nathan. Do not claim a live test passed
unless it ran on the actual microphone/browser/earbud setup.
```

## Split the implementation between agents

The paths below are suggested module boundaries. Adapt them to committed code and freeze the actual file ownership in the interface note before parallel edits. Agent 1 owns transcription provider code; Agent 2 owns synthesis provider code; Agent 3 owns browser capture/playback. The lead owns shared interfaces, dependency changes, server wiring, and integration. Do not have multiple agents edit the same manifest, lockfile, route, or controller.

### Agent 1 — streaming transcription

```text
Implement the ElevenLabs transcription adapter for Vineet's workstream.
Read the root instructions, README, Vineet's brief, and the agreed interface note.
Own the transcription-specific provider module, suggested src/voice/transcription/.
Coordinate server entrypoints with Nathan through the lead; Agent 3 owns browser
microphone capture. Do not create another backend or edit UI/coverage logic.

Check current official provider docs for live transcription, supported audio
formats, session authentication, errors, and shutdown. Document the selected
format, sample rate, timestamp origin, and whether reconnect can replay data.
Normalize provider events to README TranscriptSegment fields. Give repeated
partial/final updates of the same utterance a stable ID, keep IDs unique across
reconnects, and expose partials separately from finalized evidence. Nathan owns
coverage and final-segment deduplication; never mark cards covered here.

Expose connection/error and speaker-activity events through the agreed interface.
Support cancellation and clean disconnection. Do not silently retry forever or
replay old audio after Pause/End. Keep credentials and raw transcript logs out of
browser bundles and normal logs. Test partial-to-final normalization, duplicates,
disconnect, cancellation, and late events with provider fixtures.

Return module/API details, credential requirements, check results, and a focused
commit. Report the real microphone test separately from fixture checks.
```

### Agent 2 — approved cue synthesis and cache

```text
Implement ElevenLabs synthesis/cache for Vineet's workstream.
Read the root instructions, README, Vineet's brief, and the agreed interface note.
Own the synthesis-specific provider module, suggested src/voice/synthesis/.
Use Nathan's server credential boundary; the lead wires routes and dependencies.

Synthesize only approved short/expanded cue text supplied by the application.
Do not select cards, generate new reminders, or automatically speak on silence.
Verify current official provider docs for synthesis, output formats, and aborts.
Prepare cue audio after outline approval. Cache in session memory using the
approved text, level, voice, model, and relevant audio settings; invalidate when
any input changes and clear application-owned cache/resources at End.

Return audio with agreed metadata so the controller can associate it with the
requestId, cardId, level, and stateRevision. Support cancellation and rejection of
late results. Audio failure must leave the approved text usable. Do not persist
audio/transcripts or expose provider keys. Cover cache hit/invalidation, provider
failure, aborted generation, and late completion with focused checks.

Return setup requirements, API details, checks, and a focused commit. Mark
provider calls as unverified if credentials are unavailable.
```

### Agent 3 — browser voice controller

```text
Implement browser capture, playback, and lifecycle for Vineet's workstream.
Read the root instructions, README, Vineet's brief, and the agreed interface note.
Own the browser voice controller, suggested src/voice/browser/; Ali owns controls.

Expose start, pause, resume, end/stop, preview, play, and cancel using the actual
agreed frontend interface. Provide callbacks for transcripts, provider connection,
playback state, speaker activity, and actionable errors. Supply an explicitly
labeled mock with the same interface for Ali. No permanent key in browser code.

Request microphone permission only after explicit user action. Integrate capture
with Agent 1's audio requirements. Preview a fixed approved cue after an explicit
request. Support the available demo output route and document browser limitations.

Keep one current cue and at most one pending request; newer requests replace old
ones. Reject obsolete request/session/revision results before playback. If the
speaker is talking, retain the visual cue and wait for a gap; use a documented,
bounded wait and cancel if speech continues. Speaker resumption stops audio while
capture still catches the interruption. Use echo handling and playback interval
tags; do not mute all transcription throughout playback and lose the speaker.

Pause stops transmission and playback and invalidates pending work; resume starts
cleanly. End also stops media tracks, closes provider connections/audio resources,
revokes owned object URLs, and clears session buffers. Ignore callbacks from an
ended or replaced session. Denied permission, disconnects, and playback failures
must reach Ali through callbacks while approved text remains usable.

Check rapid requests, stale audio, pause/end during synthesis, repeated start/end,
and speaker interruption. Return a focused commit and separate automated results
from live browser/earbud observations.
```

## Lead agent: integrate and hand off

Before parallel implementation, record these decisions in `docs/voice-integration.md` (or an existing equivalent):

- Actual module paths and owning agent; runtime, package manager, and shared scaffold/base commit.
- Controller methods/events, callback unsubscribe/cleanup behavior, and transcript timestamp/ID rules.
- Actual server transport and authentication boundary agreed with Nathan. Routes are proposed until implemented.
- How request IDs, state revisions, session identity, speech gaps, and playback tags prevent stale audio and echo evidence.
- Placeholder-only environment variable names and which server process reads them; no credentials in the note.
- Where mock mode is selected, and how to run the real adapter without silently falling back to mock success.

Integrate agent commits one at a time. Reconcile dependency changes with Ali/Nathan and preserve their scripts. Keep implementation work on role/task branches; the lead alone pushes the combined `vineet/voice` branch. Stage explicit owned paths, review the staged diff for unrelated files and credentials, run the relevant checks, then commit and push:

```sh
git diff --cached --check
git diff --cached
git commit -m "feat(voice): integrate ElevenLabs voice adapters"
git push -u origin vineet/voice
```

Use the commit command after staging the actual implementation paths and running its documented checks. Open a PR to `main`; do not merge teammates' work or force-push shared history. Include these acceptance results in the PR:

| Check | Required evidence |
| --- | --- |
| Real mic → final segment | Browser/device, normalized event shape, successful final event |
| Approved short cue and More | Audible approved text; More stays on the same card |
| Speaker interruption | Playback stops; interrupting speech still produces transcript evidence |
| Rapid requests and late results | No overlap/backlog; obsolete audio never starts |
| Pause, resume, End | Transmission/playback stop; resume works; End releases resources |
| Provider/permission failure | Actionable status callback and usable approved text fallback |
| Daytona preview | Actual browser/earbud run, or a named unresolved integration dependency |
| Latency | Measured request-to-audio and speech-detection-to-stop times, or explicitly unmeasured |

Return to Ali: the controller import/factory, method/event example, mock/real configuration, and known browser limitations. Return to Nathan: provider adapter entrypoints, environment names, transport needs, transcript format, cancellation/cleanup behavior, and remaining server wiring. Record these in the PR and integration note; direct teammate messages require explicit authorization.

If hardware, credits, keys, or another branch blocks a live check, still deliver the isolated module, fixtures, and precise reproduction steps. Label that check **not run** with the missing dependency. Fixture success is not proof of a working live voice loop.
