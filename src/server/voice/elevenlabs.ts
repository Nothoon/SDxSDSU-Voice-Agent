import { VoiceProviderError, type SttToken, type SynthesizedAudio, type VoiceProvider } from "./provider.js";

// Endpoints and parameters checked against @elevenlabs/client 1.35.0 and
// @elevenlabs/elevenlabs-js 2.77.0 source (the docs site was unreachable from the sandbox).
const API = "https://api.elevenlabs.io";
const WS = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

export type ElevenLabsOptions = {
  apiKey: string;
  voiceId: string;
  ttsModel: string; // e.g. eleven_flash_v2_5 (low latency)
  outputFormat: string; // e.g. mp3_44100_128
  sttModel: string; // e.g. scribe_v2_realtime
  vadSilenceSecs: number; // 0.3–3.0; how long a pause commits a final segment
};

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly name = "elevenlabs";
  readonly simulated = false;
  readonly sttAvailable = true;
  readonly voiceKey: string;

  constructor(private options: ElevenLabsOptions) {
    this.voiceKey = `elevenlabs:${options.voiceId}:${options.ttsModel}:${options.outputFormat}`;
  }

  async createSttToken(signal?: AbortSignal): Promise<SttToken> {
    const res = await this.call("/v1/single-use-token/realtime_scribe", { method: "POST", signal });
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== "string") throw new VoiceProviderError("ElevenLabs token response had no token");
    const params = new URLSearchParams({
      model_id: this.options.sttModel,
      audio_format: "pcm_16000",
      commit_strategy: "vad",
      vad_silence_threshold_secs: String(this.options.vadSilenceSecs),
    });
    return { token: body.token, wsUrl: `${WS}?${params}` };
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<SynthesizedAudio> {
    const path = `/v1/text-to-speech/${encodeURIComponent(this.options.voiceId)}?output_format=${encodeURIComponent(this.options.outputFormat)}`;
    const res = await this.call(path, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: this.options.ttsModel }),
    });
    return {
      audio: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "audio/mpeg",
    };
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(API + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), "xi-api-key": this.options.apiKey },
        signal: init.signal ?? AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new VoiceProviderError(`ElevenLabs unreachable: ${err instanceof Error ? err.message : err}`);
    }
    if (!res.ok) {
      // Short, key-free summary; never log request bodies (they contain speaker content).
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new VoiceProviderError(`ElevenLabs ${res.status}: ${detail}`);
    }
    return res;
  }
}
