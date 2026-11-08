// Voice provider boundary (Vineet). Keys and provider calls stay on the server; the
// browser only receives single-use STT tokens and synthesized audio for approved cue text.

export type SttToken = {
  token: string; // Single-use; ElevenLabs documents a 15-minute expiry
  wsUrl: string; // Full WebSocket URL without the token; the client appends &token=
};

export type SynthesizedAudio = {
  audio: Buffer;
  contentType: string;
};

export interface VoiceProvider {
  readonly name: string;
  readonly simulated: boolean; // true for the mock provider; surfaced so mocks are never presented as live
  readonly sttAvailable: boolean;
  // Changes whenever the voice, model, or format changes, so cached audio is invalidated.
  readonly voiceKey: string;
  createSttToken(signal?: AbortSignal): Promise<SttToken>;
  synthesize(text: string, signal?: AbortSignal): Promise<SynthesizedAudio>;
}

export class VoiceProviderError extends Error {
  constructor(
    message: string,
    readonly status: 502 | 503 = 502,
  ) {
    super(message);
  }
}
