// Opt-in Auto Hint scheduler: the single owner of "when". It decides from real speaker
// activity (VAD start/end), never from missing transcripts or a model's guess that the
// speaker is stuck. The server still decides *whether* (reliable tracking, cooldown) and
// *what* (approved cue text for the current idea).
export type AutoHintOptions = {
  pauseMs: number; // continuous speaker silence before a hint
  armSpeechMs: number; // speaker speech needed since the last hint/start before arming
  cooldownMs: number; // minimum time between automatic hints
  transcriptWaitMs: number; // extra wait for a pending transcript to finish before giving up
};

export const DEFAULT_AUTO_HINT: AutoHintOptions = {
  pauseMs: 3500,
  armSpeechMs: 1000,
  cooldownMs: 10_000,
  transcriptWaitMs: 2500,
};

// off: disabled. waiting: needs more speech before it can arm. armed: a long enough pause
// will trigger one hint.
export type AutoHintStatus = "off" | "waiting" | "armed";

export class AutoHintScheduler {
  private enabled = false;
  private speechMs = 0;
  private speakingSince: number | null = null;
  private silenceSince: number | null = null;
  private lastAutoAt: number | null = null;

  constructor(private options: AutoHintOptions = DEFAULT_AUTO_HINT) {}

  status(): AutoHintStatus {
    if (!this.enabled) return "off";
    return this.speechMs >= this.options.armSpeechMs ? "armed" : "waiting";
  }

  // Turning on (or back on) requires fresh speech before the first hint.
  setEnabled(on: boolean) {
    this.enabled = on;
    this.rearm();
  }

  // Start, Resume, Pause, End: silence before the speaker begins never triggers a hint.
  reset() {
    this.rearm();
  }

  speechStart(now: number) {
    this.speakingSince ??= now;
    this.silenceSince = null;
  }

  speechEnd(now: number) {
    if (this.speakingSince !== null) this.speechMs += now - this.speakingSince;
    this.speakingSince = null;
    this.silenceSince = now;
  }

  // Any hint shown to the speaker (manual or automatic) consumes the episode: the next
  // automatic hint needs new speech first, so silence never walks through the outline.
  delivered() {
    this.speechMs = 0;
    if (this.speakingSince !== null) this.speakingSince = null;
  }

  // Call periodically. Returns true exactly once per qualifying pause.
  // transcriptPending: speech was heard but its final transcript has not arrived yet.
  tick(now: number, transcriptPending = false): boolean {
    if (!this.enabled || this.speakingSince !== null || this.silenceSince === null) return false;
    if (this.speechMs < this.options.armSpeechMs) return false;
    const silent = now - this.silenceSince;
    if (silent < this.options.pauseMs) return false;
    if (this.lastAutoAt !== null && now - this.lastAutoAt < this.options.cooldownMs) return false;
    if (transcriptPending) {
      // Don't hint from stale state. If the transcript never lands, give up on this pause.
      if (silent >= this.options.pauseMs + this.options.transcriptWaitMs) this.speechMs = 0;
      return false;
    }
    this.lastAutoAt = now;
    this.speechMs = 0;
    return true;
  }

  private rearm() {
    this.speechMs = 0;
    this.speakingSince = null;
    this.silenceSince = null;
  }
}
