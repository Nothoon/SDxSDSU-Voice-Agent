import type { CueResponse, ProviderStatus, TranscriptSegment } from "../shared/types.js";
import type { AutoHintStatus } from "./core/autohint.js";

// Voice controller contract (Vineet → Ali). Ali owns the buttons; this owns the
// microphone, transcription, and cue playback behind them. The controller never chooses
// a cue or marks coverage: the UI asks the backend for a cue and passes it to playCue().

export type PlaybackStopReason =
  | "ended" // played to completion
  | "speaker-resumed" // the speaker started talking during the cue
  | "speaker-continued" // the speaker kept talking with no gap, so the cue was not played
  | "superseded" // a newer cue request replaced it
  | "stopped" // stopPlayback(), pause(), or end()
  | "stale" // older stateRevision than a cue already handled
  | "no-audio" // nothing to play (e.g. "All points covered."); show the text
  | "not-listening" // paused or ended
  | "failed"; // audio fetch or playback failed; show the text

export type PlaybackEvent =
  | { state: "waiting"; cue: CueResponse } // speaker is talking; waiting for a gap
  | { state: "playing"; cue: CueResponse; startLatencyMs: number } // request → audible start
  | { state: "stopped"; cue: CueResponse; reason: PlaybackStopReason; stopLatencyMs?: number; error?: string };

export type VoiceEvents = {
  // Partial and final segments, after echo filtering, as sent to the backend.
  transcript: (segment: TranscriptSegment) => void;
  connection: (status: ProviderStatus, detail?: string) => void;
  speaking: (active: boolean) => void;
  playback: (event: PlaybackEvent) => void;
  level: (rms: number) => void; // microphone level, ~20 Hz, for a meter
  error: (message: string) => void;
  // Opt-in Auto Hint: a qualifying pause happened. Ask the backend for an automatic cue
  // ({ source: "auto" }) and pass the result to playCue(cue, { auto: true, triggeredAt: at }).
  autoHint: (trigger: { at: number }) => void;
  autoHintStatus: (status: AutoHintStatus) => void;
};

export type PlayOptions = {
  auto?: boolean; // automatic cue: dropped if the speaker spoke after triggeredAt
  triggeredAt?: number; // the autoHint event's `at`
};

export interface VoiceController {
  readonly simulated: boolean;
  // Requests the microphone and opens live transcription for a backend session.
  // Call after the backend session is started (POST /start).
  start(sessionId: string): Promise<void>;
  // Stops mic capture and transmission, closes the transcription stream, stops playback.
  pause(): void;
  resume(): Promise<void>;
  // Like pause, and releases everything; the controller can be started again later.
  end(): void;
  // Plays a backend CueResponse. Resolves with how playback finished. Never queues:
  // a newer cue supersedes an older one, and stale revisions are ignored.
  playCue(cue: CueResponse, options?: PlayOptions): Promise<PlaybackStopReason>;
  // Opt-in, off by default. Turning it off stops a playing automatic cue (not a manual one).
  setAutoHint(enabled: boolean): void;
  // Tell the scheduler a hint was shown without audio, so silence doesn't trigger another.
  markHintShown(): void;
  stopPlayback(): void;
  // Plays a fixed phrase to check earbud routing and volume.
  preview(): Promise<PlaybackStopReason>;
  listOutputDevices(): Promise<MediaDeviceInfo[]>;
  // Returns false when the browser cannot route output (no setSinkId); use system output.
  setOutputDevice(deviceId: string): Promise<boolean>;
  on<E extends keyof VoiceEvents>(event: E, listener: VoiceEvents[E]): () => void;
}
