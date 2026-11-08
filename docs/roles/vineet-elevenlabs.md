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
