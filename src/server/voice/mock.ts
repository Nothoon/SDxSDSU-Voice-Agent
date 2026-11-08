import { VoiceProviderError, type SttToken, type SynthesizedAudio, type VoiceProvider } from "./provider.js";

// SIMULATED voice provider for running without ElevenLabs credentials. Synthesis returns
// a short two-tone WAV (length scales with word count) so routing, cancellation, and
// overlap behavior can be exercised. It is not speech. Live STT is unavailable; the voice
// test page falls back to typed, clearly labeled simulated transcript input.
export class MockVoiceProvider implements VoiceProvider {
  readonly name = "mock";
  readonly simulated = true;
  readonly sttAvailable = false;
  readonly voiceKey = "mock:tone";
  synthesizeCalls = 0;

  async createSttToken(): Promise<SttToken> {
    throw new VoiceProviderError("Live transcription needs ELEVENLABS_API_KEY (VOICE_PROVIDER=elevenlabs)", 503);
  }

  async synthesize(text: string): Promise<SynthesizedAudio> {
    this.synthesizeCalls++;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return { audio: toneWav(Math.min(4000, 350 + words * 250)), contentType: "audio/wav" };
  }
}

function toneWav(durationMs: number, sampleRate = 16000): Buffer {
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const freq = i < samples / 2 ? 660 : 880;
    const fade = Math.min(1, i / 400, (samples - i) / 400);
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * t) * 0.25 * fade * 32767), 44 + i * 2);
  }
  return buf;
}
