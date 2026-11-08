import type { SynthesizedAudio, VoiceProvider } from "./provider.js";

// Synthesized cue audio, keyed by voice + text. Editing a card's text or changing the
// voice produces a new key, so stale audio is never served. Concurrent requests for the
// same text share one provider call. Holds approved cue text only, never transcripts.
export class CueAudioCache {
  private entries = new Map<string, Promise<SynthesizedAudio>>();

  constructor(
    private provider: VoiceProvider,
    private maxEntries = 200,
  ) {}

  get(text: string): Promise<SynthesizedAudio> {
    const key = `${this.provider.voiceKey}|${text}`;
    const hit = this.entries.get(key);
    if (hit) {
      // Refresh recency.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const pending = this.provider.synthesize(text);
    this.entries.set(key, pending);
    pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return pending;
  }
}
