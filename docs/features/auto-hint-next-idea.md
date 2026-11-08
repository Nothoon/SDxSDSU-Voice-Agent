# Implement Auto Hint and Next Idea

## Authorized product change

The user requested an opt-in Auto Hint mode and a dedicated Next Idea button. This brief updates the previous manual-only MVP policy. Deliver the features in the existing application; do not create another app. This file is an implementation specification, not evidence that either feature is already working.

Read AGENTS.md, README.md, docs/ui-integration.md, and your role brief first. Inspect current main and teammate branches. Preserve the current stack and ownership: Ali owns UI, Nathan owns authoritative session state/coverage/selection, Vineet owns speech detection and audio. Record interface changes for all three owners. An integration agent may coordinate the feature across these boundaries; do not overwrite unfinished teammate work.

## User experience

- Speaking view: Hint, Next Idea, More, Auto Hint on/off, Pause, End, current idea, and a small next-idea preview.
- Rename the existing Cue control to Hint. Keep its existing C shortcut as an alias; add H for Hint and Right Arrow for Next Idea.
- Shortcuts work only during listening, outside editable controls, dialogs, and buttons; ignore held-key repeats and modifier combinations. Buttons remain accessible by keyboard and touch.
- Auto Hint defaults off for each new session. Let the user enable it in preflight or while speaking. Explain: “After a pause, hear a short reminder.” Show whether it is off, waiting for speech, armed, or unavailable without exposing technical internals.
- Reuse approved IdeaCard.cue (2–5 words) as the keyword/anchor and expandedCue for More. Do not require new fields, slide uploads, or generated speech. A recognizable phrase such as “Customer story” is sufficient.
- Keep approved text visible if audio fails. Mock mode must explicitly label simulated speech, pause detection, and playback.

## State: focus is different from coverage

Introduce activeIdeaId separately from coverage, lastDeliveredCue, and pendingCueRequest. The current demo uses lastId for selection and remembered cues; split those responsibilities rather than extending that ambiguity.

- Start on the first approved idea.
- Moving focus never marks an idea covered. Coverage changes require actual finalized transcript evidence.
- Explicit selection and Next Idea update authoritative focus and its revision immediately, even if synthesis fails.
- Natural transitions may update focus after validated finalized speech clearly expresses another card's meaning. A keyword mention alone is insufficient. Preserve coverage of reordered ideas.
- A delayed inference based on speech before a manual move cannot revert that move. Track a focus revision/transcript boundary, not just response arrival time.
- Keep lastDeliveredCue tied to cardId, level, text, and request/session identity. More expands that same card. After a focus change, clear/disable More until a new hint is presented so it cannot unexpectedly describe the previous idea.
- Maintain a separate focus revision and session identity alongside coverage revisions as needed; do not treat the last delivered cue as proof of current focus.

## Hint action

Hint gives the current idea's approved short cue and does not change activeIdeaId. It is available even if that idea was already covered and the user wants to revisit it. For the MVP, use the approved short cue rather than inventing text for a missing subpoint. More gives the approved expanded cue for the same delivered card.

Example: active idea is Pricing -> Hint says “Monthly savings” -> focus stays Pricing.

## Next Idea action

One press moves focus and requests the destination's approved short cue. No separate select-then-Hint interaction.

1. Search forward after activeIdeaId in approved order for a card whose coverage is not covered; partial counts as remaining.
2. Skip cards already covered. Do not silently jump to an earlier card or apply deadline priority to this button.
3. Preserve the previous idea's coverage, including uncovered/partial; advancing is an intentional skip, not completion.
4. If there is no remaining later card but earlier ideas are unfinished, show “End of outline — earlier ideas remain” and offer manual selection. Do not claim all points covered.
5. If every card is covered, show “All points covered.” Never fabricate another idea or speak a completion announcement automatically.
6. One deliberate activation advances once. Ignore double-click/tap bursts while that transition is pending and key repeats. Distinct later activations may advance again.
7. New manual intent cancels obsolete automatic hints and pending audio. Update focus/text without waiting for synthesis; play when a safe speech gap exists, with a bounded wait (initially 2 seconds). If speech continues, retain text and cancel pending audio.

Example: Problem -> Next Idea -> Customer story, cue “Customer story”; Problem remains partial if it was partial.

## Auto Hint mode

Use a deterministic pause policy over real voice-activity events and validated coverage. Do not ask a language model to decide whether someone is psychologically stuck.

Initial tunable defaults: 3.5 seconds of continuous speaker silence, at least 1 second of accumulated detected speaker speech to arm/rearm, and 10 seconds between automatic deliveries. These are starting parameters for rehearsal, not measured optimal thresholds.

1. Only arm when enabled, listening, providers/tracking healthy, and speaker speech has occurred since Start/Resume, enabling the mode, or the last cue delivery. Silence before the user begins never triggers a hint.
2. Reset the pause clock on speaker activity; do not use absence of finalized STT messages as evidence of silence. Network delay is not a pause. Assistant playback cannot count as speaker activity.
3. At the pause threshold, wait for pending final transcript/coverage processing to settle. If state is stale, uncertain, or disconnected, suppress the automatic cue and show an appropriate status. Never guess a new idea from unreliable state.
4. If active idea is uncovered/partial, hint that idea without changing focus.
5. If active idea is covered, use the same forward-only destination rule as Next Idea, update focus, and deliver that destination's approved short cue. Preserve skipped coverage.
6. Deliver at most one automatic hint per silence episode. Rearm only after new speaker speech satisfies the speech gate and the cooldown has elapsed. Continued silence must never walk through the outline or repeat a hint.
7. Manual Hint, More, or Next Idea takes precedence and resets the automatic gate after delivery. Cancel the pending automatic request before acting on manual intent.
8. Turning Auto Hint off cancels pending and currently playing automatic audio immediately; it must not cancel an unrelated manual cue. Pause/End cancel all timers, requests, and playback; Resume requires fresh speech before rearming.
9. Speaker resumption cancels pending automatic work and stops playback immediately while preserving capture of the interruption. Reject late synthesis responses after resumption, focus changes, mode changes, Pause, End, or session replacement.
10. If there is no forward destination, show the end/completion state described above and remain silent. If audio fails after showing an automatic hint, count that episode as consumed and do not retry repeatedly.

Do not trigger solely from fillers, repeated words, or a model's “stumble” label. A pause can be intentional; opt-in, adjustable timing, one-shot behavior, and immediate interruption keep the feature controllable.

## Implementation boundaries

- Ali: controls, current/next presentation, accessibility, preflight setting, status and text fallback; remove outdated “only a request triggers a cue” copy when enabled.
- Nathan: authoritative active idea, coverage, transition/selection policy, request deduplication, inference/focus ordering, auto-hint eligibility, shared contracts and tests.
- Vineet: real speaker activity events, monotonic timing, synthesis/cache, speech-gap playback, interruption, echo handling and lifecycle cleanup.
- Pick one owner for the automatic scheduler; do not run competing timers in UI and backend. Coordinate voice events with authoritative session state through the existing adapter boundary.
- Extend session snapshots with focus/mode state and cue requests with explicit intent/source (hint, next, more; manual or automatic). These are proposed additions, not existing endpoints. Agree concrete names with Nathan.
- Existing public/app.js, public/demo-adapters.js, and docs/ui-integration.md are starting integration points. Keep provider logic out of UI and keys on the server.
- Prepare/cache approved cue audio after outline approval and invalidate on text/voice changes. Reuse the same cancellable playback path for manual and automatic cues.
- Preserve manual card selection for revisiting earlier/covered ideas and correcting inference. Manual controls remain usable with Auto Hint off or tracking unavailable; offline Next uses last reliable coverage and clearly reports degraded tracking.
- Update README, role briefs and UI integration notes during implementation so manual-only rules do not survive as conflicting guidance.

## Required checks

Use fake clocks and deterministic voice/coverage fixtures for timing/state cases; then verify real microphone/earbud behavior separately.

| Case | Expected |
| --- | --- |
| Auto Hint off; prolonged silence | No automatic request/audio |
| Enabled before first speech or after Resume | No hint until fresh speaker speech arms it |
| Short pause below threshold | No automatic hint |
| Sustained pause on unfinished idea | One current-idea hint; focus unchanged |
| Sustained pause on covered idea | One forward transition and destination hint |
| Continued silence after hint | No repeated cue or further advance |
| New speech plus cooldown | A later pause can trigger once |
| STT delay, uncertain coverage, disconnected provider | No speculative automatic cue |
| Speaker returns during generation/playback | Cancel pending/audio; capture the speaker; late result ignored |
| Next from partial idea | Advance without marking previous idea covered |
| Later idea already covered | Next skips it without erasing its evidence |
| Only earlier unfinished ideas remain | End-of-outline message; no wrap or false completion |
| More after Hint | Expanded text for same card |
| Focus changes | Old More is disabled; delayed inference cannot revert manual focus |
| Auto Hint and Next happen together | Manual action wins; one current cue; no overlap |
| Double activation or held shortcut | One transition per deliberate activation |
| Mode off, Pause, End, repeated sessions | No orphan timers, mic transmission, or late playback |
| Audio fails | Approved text remains; no automatic retry loop |
| Mock mode | Simulation is visible; fixture checks are not called live verification |

Run existing project checks and add meaningful transition/timer tests. Record exact results and unverified hardware/provider behavior. Demo: explain part of Problem, pause for its hint, finish it, press Next Idea to hear “Customer story,” then resume and interrupt the cue.

## Copyable agent prompt

Implement docs/features/auto-hint-next-idea.md in the existing Thread application. Read root instructions and current code first. Deliver opt-in Auto Hint and a one-action Next Idea button, keeping focus separate from coverage. Coordinate the existing UI/backend/voice ownership, preserve approved-text-only cues, prevent repeated automatic hints and stale playback, update the mock adapter and docs, and run deterministic state/timer tests plus available live checks. This brief authorizes optional automatic cues and supersedes older manual-only guidance. Commit focused implementation changes and report setup, test results, and remaining integration dependencies; do not claim mocks prove live speech works.
