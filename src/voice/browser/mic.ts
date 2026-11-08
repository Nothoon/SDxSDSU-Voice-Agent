// Microphone capture: mono 16 kHz PCM16 frames of 50 ms plus their RMS level.
// Browser echo cancellation stays on so cue audio is suppressed before transcription.

const FRAME_SAMPLES = 800; // 50 ms at 16 kHz

// Resamples to 16 kHz (linear) when the context runs at another rate, and posts
// PCM16 frames with their RMS. Runs on the audio thread.
const WORKLET = `
class ThreadPcm16 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.buf = new Int16Array(${FRAME_SAMPLES});
    this.n = 0;
    this.sum = 0;
    this.count = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const a = ch[i];
      const b = i + 1 < ch.length ? ch[i + 1] : a;
      const v = Math.max(-1, Math.min(1, a + (b - a) * (this.pos - i)));
      this.sum += v * v;
      this.count++;
      this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.buffer, rms: Math.sqrt(this.sum / this.count) }, [this.buf.buffer]);
        this.buf = new Int16Array(${FRAME_SAMPLES});
        this.n = 0;
        this.sum = 0;
        this.count = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor("thread-pcm16", ThreadPcm16);
`;

export type MicFrame = { pcm: ArrayBuffer; rms: number };

export class MicCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;

  async start(onFrame: (frame: MicFrame) => void, deviceId?: string): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    try {
      // Prefer a native 16 kHz context (browser resampler); Firefox rejects mixing
      // rates with a mic source, so fall back to the default rate and resample in the worklet.
      let source: MediaStreamAudioSourceNode;
      try {
        this.context = new AudioContext({ sampleRate: 16000 });
        source = this.context.createMediaStreamSource(this.stream);
      } catch {
        await this.context?.close();
        this.context = new AudioContext();
        source = this.context.createMediaStreamSource(this.stream);
      }
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      try {
        await this.context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(this.context, "thread-pcm16", { numberOfOutputs: 1 });
      node.port.onmessage = (e: MessageEvent<MicFrame>) => onFrame(e.data);
      source.connect(node);
      // The worklet writes no output, so this is silent; it keeps the node processing.
      node.connect(this.context.destination);
      if (this.context.state === "suspended") await this.context.resume();
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}

export function pcmToBase64(pcm: ArrayBuffer): string {
  const bytes = new Uint8Array(pcm);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
