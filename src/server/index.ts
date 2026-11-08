import { createApp } from "./app.js";
import type { CoverageAdapter } from "./coverage/adapter.js";
import { ClaudeCoverageAdapter } from "./coverage/claude.js";
import { MockCoverageAdapter } from "./coverage/mock.js";
import { ElevenLabsVoiceProvider } from "./voice/elevenlabs.js";
import { MockVoiceProvider } from "./voice/mock.js";
import type { VoiceProvider } from "./voice/provider.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const provider = process.env.COVERAGE_PROVIDER ?? "mock";
const model = process.env.COVERAGE_MODEL ?? "claude-opus-5-5";

let adapter: CoverageAdapter;
if (provider === "claude") {
  adapter = new ClaudeCoverageAdapter(model);
} else if (provider === "mock") {
  adapter = new MockCoverageAdapter();
} else {
  throw new Error(`Unknown COVERAGE_PROVIDER "${provider}" (expected claude or mock)`);
}

// Voice defaults to ElevenLabs when a key is configured, otherwise the SIMULATED mock.
const voiceProvider = process.env.VOICE_PROVIDER || (process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "mock");
let voice: VoiceProvider;
if (voiceProvider === "elevenlabs") {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error("VOICE_PROVIDER=elevenlabs requires ELEVENLABS_API_KEY");
  voice = new ElevenLabsVoiceProvider({
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb",
    ttsModel: process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5",
    outputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128",
    sttModel: process.env.ELEVENLABS_STT_MODEL || "scribe_v2_realtime",
    vadSilenceSecs: Number(process.env.ELEVENLABS_VAD_SILENCE_SECS || 0.8),
  });
} else if (voiceProvider === "mock") {
  voice = new MockVoiceProvider();
} else {
  throw new Error(`Unknown VOICE_PROVIDER "${voiceProvider}" (expected elevenlabs or mock)`);
}

const { server } = createApp({ adapter: () => adapter, voice, allowedOrigin: process.env.ALLOWED_ORIGIN });

server.listen(port, host, () => {
  const label = adapter.simulated ? "mock (SIMULATED coverage)" : `${adapter.name} (${model})`;
  console.log(`Thread backend listening on http://${host}:${port} — coverage: ${label}`);
  console.log(`Voice: ${voice.simulated ? "mock (SIMULATED tones, no live STT)" : voice.name} — test page at /voice-demo/`);
  if (process.env.DAYTONA_SANDBOX_ID) {
    console.log(`Daytona preview (expected): https://${port}-${process.env.DAYTONA_SANDBOX_ID}.proxy.daytona.works`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
