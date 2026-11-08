// Local energy-based speaker-activity detector. Used only to stop cue playback when the
// speaker resumes and to wait for a speech gap before playing; it never triggers a cue.
// Transcription commits use ElevenLabs' own VAD.
export type VadOptions = {
  minSpeechMs: number; // sustained energy needed to declare speech
  hangoverMs: number; // quiet time needed to declare a gap
  ratio: number; // threshold above the adaptive noise floor
  minRms: number; // absolute floor so near-silence never counts
};

export const DEFAULT_VAD: VadOptions = { minSpeechMs: 120, hangoverMs: 350, ratio: 3, minRms: 0.012 };

export class EnergyVad {
  speaking = false;
  noiseFloor = 0.005;
  // Raised while cue audio plays so residual echo is less likely to read as the speaker.
  boost = 1;
  private aboveSince: number | null = null;
  private belowSince: number | null = null;

  constructor(private options: VadOptions = DEFAULT_VAD) {}

  // Time of the first loud frame of the current speech burst, for latency measurement.
  get onsetMs(): number | null {
    return this.aboveSince;
  }

  threshold(): number {
    return Math.max(this.options.minRms, this.noiseFloor * this.options.ratio) * this.boost;
  }

  // Feed one frame's RMS. Returns "start" or "end" when the speaking state changes.
  update(rms: number, nowMs: number): "start" | "end" | null {
    const loud = rms > this.threshold();
    if (!loud) {
      // Track the noise floor only from quiet frames: fall fast, rise slowly.
      this.noiseFloor = rms < this.noiseFloor ? rms * 0.5 + this.noiseFloor * 0.5 : this.noiseFloor * 0.995 + rms * 0.005;
      this.noiseFloor = Math.max(this.noiseFloor, 0.001);
    }
    if (loud) {
      this.belowSince = null;
      this.aboveSince ??= nowMs;
      if (!this.speaking && nowMs - this.aboveSince >= this.options.minSpeechMs) {
        this.speaking = true;
        return "start";
      }
    } else {
      this.aboveSince = null;
      this.belowSince ??= nowMs;
      if (this.speaking && nowMs - this.belowSince >= this.options.hangoverMs) {
        this.speaking = false;
        return "end";
      }
    }
    return null;
  }
}
