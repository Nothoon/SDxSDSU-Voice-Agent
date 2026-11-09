import type { CueResponse, ProviderStatus, TranscriptSegment } from "../../shared/types.js";
import { AutoHintScheduler, DEFAULT_AUTO_HINT, type AutoHintOptions, type AutoHintStatus } from "../core/autohint.js";
import { stripEcho, type PlaybackInterval } from "../core/echo.js";
import { SCRIBE_ERROR_TYPES, TranscriptNormalizer, type ScribeMessage } from "../core/transcript.js";
import { EnergyVad } from "../core/vad.js";
import type { PlaybackEvent, PlaybackStopReason, PlayOptions, VoiceController, VoiceEvents } from "../types.js";
import { MicCapture, pcmToBase64, type MicFrame } from "./mic.js";

export type VoiceOptions = {
  apiBase?: string; // Backend origin; defaults to the page origin
  inputDeviceId?: string;
  // SIMULATED input: no microphone or ElevenLabs STT. Speech comes from simulateSpeech().
  // Playback is unchanged. Use for UI work and demos without credentials.
  simulated?: boolean;
  maxGapWaitMs?: number; // how long a requested cue waits for the speaker to pause
  autoHint?: Partial<AutoHintOptions>; // timing for opt-in Auto Hint (starting values, tune in rehearsal)
};

type Job = {
  cue: CueResponse;
  abort: AbortController;
  resolve: (reason: PlaybackStopReason) => void;
  playing: boolean;
  interval: PlaybackInterval | null;
  auto: boolean;
};

const PREVIEW_TEXT = "This is your Thread cue.";
const MAX_PENDING_FRAMES = 40; // 2 s of audio buffered while the STT socket connects
const MAX_RECONNECTS = 3;
const PARTIAL_THROTTLE_MS = 300;
const AUTO_TICK_MS = 200;

export function createVoiceController(options: VoiceOptions = {}): ThreadVoiceController {
  return new ThreadVoiceController(options);
}

export class ThreadVoiceController implements VoiceController {
  readonly simulated: boolean;
  private api: string;
  private listeners = new Map<keyof VoiceEvents, Set<(...args: any[]) => void>>();
  private sessionId: string | null = null;
  private mode: "idle" | "listening" | "paused" = "idle";
  private mic = new MicCapture();
  private vad = new EnergyVad();
  private origin = performance.now();
  private runId = Math.random().toString(36).slice(2, 8);
  private connections = 0;
  private reconnects = 0;
  private ws: WebSocket | null = null;
  private wsReady = false;
  private pendingFrames: string[] = [];
  private normalizer: TranscriptNormalizer | null = null;
  private intervals: PlaybackInterval[] = [];
  private audio = new Audio();
  private audioCache = new Map<string, Promise<string>>();
  private job: Job | null = null;
  private lastRevision = -1;
  private gapWaiters = new Set<() => void>();
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPartial: TranscriptSegment | null = null;
  private lastPartialAt = 0;
  private posting: Promise<unknown> = Promise.resolve();
  private scheduler: AutoHintScheduler;
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private autoStatus: AutoHintStatus = "off";
  private lastSpeechStartAt = -1;

  constructor(private options: VoiceOptions = {}) {
    this.simulated = !!options.simulated;
    this.api = (options.apiBase ?? "").replace(/\/$/, "");
    this.audio.preload = "auto";
    this.scheduler = new AutoHintScheduler({ ...DEFAULT_AUTO_HINT, ...options.autoHint });
  }

  on<E extends keyof VoiceEvents>(event: E, listener: VoiceEvents[E]): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  private emit<E extends keyof VoiceEvents>(event: E, ...args: Parameters<VoiceEvents[E]>) {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }

  // Controller clock shared by transcripts and playback intervals.
  private now = () => Math.round(performance.now() - this.origin);

  // ---- Lifecycle ----

  async start(sessionId: string): Promise<void> {
    if (this.mode !== "idle") throw new Error("Voice is already started; call end() first");
    this.sessionId = sessionId;
    this.mode = "listening";
    try {
      await this.openInput();
    } catch (err) {
      this.end();
      throw err;
    }
  }

  pause() {
    if (this.mode !== "listening") return;
    this.mode = "paused";
    this.closeInput();
    this.stopPlayback();
  }

  async resume(): Promise<void> {
    if (this.mode !== "paused") return;
    this.mode = "listening";
    try {
      await this.openInput();
    } catch (err) {
      this.mode = "paused";
      this.closeInput();
      throw err;
    }
  }

  end() {
    if (this.mode === "idle") return;
    this.mode = "idle";
    this.closeInput();
    this.stopPlayback();
    void this.reportStt("disconnected");
    this.intervals = [];
    this.sessionId = null;
    for (const url of this.audioCache.values()) void url.then(URL.revokeObjectURL, () => {});
    this.audioCache.clear();
  }

  // Asks the server to synthesize every approved cue now so Cue presses hit the cache.
  async prepare(sessionId: string): Promise<{ prepared: number; failed: unknown[]; simulated: boolean }> {
    return this.request(`/api/sessions/${sessionId}/voice/prepare`, { method: "POST" });
  }

  private async openInput() {
    this.reconnects = 0;
    this.scheduler.reset();
    this.autoTimer ??= setInterval(() => this.autoTick(), AUTO_TICK_MS);
    this.emitAutoStatus();
    if (this.simulated) {
      this.emit("connection", "degraded", "SIMULATED input: typed speech, no microphone");
      void this.reportStt("degraded");
      return;
    }
    try {
      await this.mic.start((frame) => this.onFrame(frame), this.options.inputDeviceId);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      const message =
        name === "NotAllowedError"
          ? "Microphone permission was denied"
          : name === "NotFoundError"
            ? "No microphone found"
            : `Microphone unavailable: ${errorText(err)}`;
      this.emit("error", message);
      throw new Error(message);
    }
    await this.connectStt();
  }

  private closeInput() {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    this.scheduler.reset();
    this.emitAutoStatus();
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = null;
    this.pendingPartial = null;
    const ws = this.ws;
    this.ws = null; // Detach first so onclose does not reconnect.
    this.wsReady = false;
    this.pendingFrames = [];
    ws?.close();
    this.mic.stop();
    if (this.vad.speaking) {
      this.vad = new EnergyVad();
      this.emit("speaking", false);
    }
    this.flushGapWaiters();
  }

  // ---- Live transcription (ElevenLabs Scribe realtime) ----

  private async connectStt() {
    const { token, wsUrl } = await this.request<{ token: string; wsUrl: string }>(
      `/api/sessions/${this.sessionId}/voice/stt-token`,
      { method: "POST" },
    ).catch((err) => {
      this.emit("connection", "disconnected", errorText(err));
      throw err;
    });
    if (this.mode !== "listening") return; // Paused or ended while fetching the token.

    const ws = new WebSocket(`${wsUrl}&token=${encodeURIComponent(token)}`);
    this.ws = ws;
    this.wsReady = false;
    this.normalizer = new TranscriptNormalizer(`${this.runId}-${this.connections++}`, this.now);

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let message: ScribeMessage;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.message_type === "session_started") {
        this.wsReady = true;
        this.reconnects = 0;
        for (const chunk of this.pendingFrames) this.sendAudio(chunk);
        this.pendingFrames = [];
        this.emit("connection", "connected");
        void this.reportStt("connected");
        return;
      }
      if (SCRIBE_ERROR_TYPES.has(message.message_type)) {
        this.emit("error", `Transcription ${message.message_type}: ${"error" in message ? message.error : ""}`);
        this.emit("connection", "degraded", message.message_type);
        void this.reportStt("degraded");
        return;
      }
      const segment = this.normalizer?.handle(message);
      if (segment) this.onSegment(segment);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // Closed on purpose.
      this.ws = null;
      this.wsReady = false;
      this.emit("connection", "disconnected", "Transcription stream closed");
      void this.reportStt("disconnected");
      if (this.mode === "listening" && this.reconnects < MAX_RECONNECTS) {
        this.reconnects++;
        setTimeout(() => {
          if (this.mode === "listening" && !this.ws) {
            this.connectStt().catch((err) => this.emit("error", `Reconnect failed: ${errorText(err)}`));
          }
        }, 1000 * this.reconnects);
      }
    };
  }

  private sendAudio(base64: string) {
    this.ws?.send(
      JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: base64, commit: false, sample_rate: 16000 }),
    );
  }

  private onFrame({ pcm, rms }: MicFrame) {
    if (this.mode !== "listening") return;
    this.emit("level", rms);
    const change = this.vad.update(rms, performance.now());
    if (change === "start") this.onSpeechStart();
    if (change === "end") this.onSpeechEnd();

    const chunk = pcmToBase64(pcm);
    if (this.wsReady) this.sendAudio(chunk);
    else if (this.ws) {
      this.pendingFrames.push(chunk);
      if (this.pendingFrames.length > MAX_PENDING_FRAMES) this.pendingFrames.shift();
    }
  }

  private onSegment(raw: TranscriptSegment) {
    // Drop cue audio that leaked into the mic so it is never coverage evidence.
    this.intervals = this.intervals.filter((p) => p.endMs === null || this.now() - p.endMs < 30000);
    const segment = stripEcho(raw, this.intervals);
    if (!segment) return;
    this.emit("transcript", segment);
    if (segment.isFinal) {
      if (this.partialTimer) clearTimeout(this.partialTimer);
      this.partialTimer = null;
      this.pendingPartial = null;
      this.postSegment(segment);
      return;
    }
    // Partials only preview speech in the UI; throttle what goes to the backend.
    this.pendingPartial = segment;
    const wait = PARTIAL_THROTTLE_MS - (Date.now() - this.lastPartialAt);
    if (wait <= 0) this.flushPartial();
    else this.partialTimer ??= setTimeout(() => this.flushPartial(), wait);
  }

  private flushPartial() {
    this.partialTimer = null;
    if (!this.pendingPartial) return;
    this.lastPartialAt = Date.now();
    this.postSegment(this.pendingPartial);
    this.pendingPartial = null;
  }

  private postSegment(segment: TranscriptSegment) {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    // Sequential, so the backend sees finals in order.
    this.posting = this.posting
      .then(() =>
        this.request(`/api/sessions/${sessionId}/segments`, { method: "POST", body: JSON.stringify({ segment }) }),
      )
      .catch((err) => this.emit("error", `Could not send transcript: ${errorText(err)}`));
  }

  private reportStt(status: ProviderStatus) {
    if (!this.sessionId) return;
    return this.request(`/api/sessions/${this.sessionId}/providers`, {
      method: "POST",
      body: JSON.stringify({ provider: "stt", status }),
    }).catch(() => {});
  }

  // ---- Speaker activity ----

  private onSpeechStart() {
    this.lastSpeechStartAt = this.now();
    this.scheduler.speechStart(this.now());
    this.emit("speaking", true);
    const job = this.job;
    if (job?.playing) {
      // Measured from the first loud mic frame; excludes device input/output buffering.
      const onset = this.vad.onsetMs;
      this.finishJob(job, "speaker-resumed", onset === null ? {} : { stopLatencyMs: Math.round(performance.now() - onset) });
    }
  }

  private onSpeechEnd() {
    this.scheduler.speechEnd(this.now());
    this.emitAutoStatus();
    this.emit("speaking", false);
    this.flushGapWaiters();
  }

  // ---- Opt-in Auto Hint ----

  setAutoHint(enabled: boolean) {
    this.scheduler.setEnabled(enabled);
    if (!enabled && this.job?.auto) this.finishJob(this.job, "stopped");
    this.emitAutoStatus();
  }

  markHintShown() {
    this.scheduler.delivered();
    this.emitAutoStatus();
  }

  private autoTick() {
    if (this.mode !== "listening") return;
    const fire = this.scheduler.tick(this.now(), this.normalizer?.pending ?? false);
    this.emitAutoStatus();
    if (fire) this.emit("autoHint", { at: this.now() });
  }

  private emitAutoStatus() {
    const status = this.scheduler.status();
    if (status === this.autoStatus) return;
    this.autoStatus = status;
    this.emit("autoHintStatus", status);
  }

  private flushGapWaiters() {
    for (const resolve of this.gapWaiters) resolve();
    this.gapWaiters.clear();
  }

  // SIMULATED input only: emits typed text as speech, including speaker activity, so
  // interruption and coverage can be exercised without a microphone.
  async simulateSpeech(text: string, durationMs = Math.max(900, text.trim().split(/\s+/).length * 250)): Promise<void> {
    if (!this.simulated) throw new Error("simulateSpeech requires simulated: true");
    if (this.mode !== "listening" || !text.trim()) return;
    const normalizer = (this.normalizer ??= new TranscriptNormalizer(`${this.runId}-sim`, this.now));
    this.vad.speaking = true;
    this.onSpeechStart();
    const partial = normalizer.handle({ message_type: "partial_transcript", text });
    if (partial) this.onSegment(partial);
    await new Promise((r) => setTimeout(r, durationMs));
    if (this.mode !== "listening") return;
    const final = normalizer.handle({ message_type: "committed_transcript", text });
    if (final) this.onSegment(final);
    this.vad.speaking = false;
    this.onSpeechEnd();
  }

  // ---- Cue playback ----

  async playCue(cue: CueResponse, options: PlayOptions = {}): Promise<PlaybackStopReason> {
    if (cue.stateRevision <= this.lastRevision) return this.report(cue, "stale");
    this.lastRevision = cue.stateRevision;
    if (this.mode === "paused") return this.report(cue, "not-listening");
    // An automatic cue is obsolete once the speaker has spoken again since the pause.
    if (options.auto && options.triggeredAt !== undefined && this.lastSpeechStartAt > options.triggeredAt) {
      return this.report(cue, "speaker-resumed");
    }
    if (cue.cardId) this.markHintShown();
    if (!cue.cardId || !this.sessionId) {
      this.cancelJob("superseded");
      return this.report(cue, "no-audio");
    }
    const url =
      `${this.api}/api/sessions/${this.sessionId}/voice/cue-audio?cardId=${encodeURIComponent(cue.cardId)}` +
      `&level=${cue.level}&v=${hash(cue.text)}`;
    return this.runJob(cue, url, !!options.auto);
  }

  async preview(): Promise<PlaybackStopReason> {
    if (this.mode === "paused") return "not-listening";
    const cue: CueResponse = {
      requestId: "preview",
      cardId: "preview",
      level: "short",
      text: PREVIEW_TEXT,
      stateRevision: this.lastRevision,
    };
    return this.runJob(cue, `${this.api}/api/voice/preview-audio`);
  }

  stopPlayback() {
    if (this.job) this.finishJob(this.job, "stopped");
  }

  private cancelJob(reason: PlaybackStopReason) {
    if (this.job) this.finishJob(this.job, reason);
  }

  private runJob(cue: CueResponse, url: string, auto = false): Promise<PlaybackStopReason> {
    const requestedAt = performance.now();
    this.cancelJob("superseded"); // Never overlap or queue cue audio.
    return new Promise((resolve) => {
      const job: Job = { cue, abort: new AbortController(), resolve, playing: false, interval: null, auto };
      this.job = job;
      void (async () => {
        try {
          const src = await this.loadAudio(url);
          if (this.job !== job) return;
          if (this.vad.speaking) {
            // The speaker is talking: show the text now (UI), play only after a gap.
            this.emitPlayback({ state: "waiting", cue });
            if (!(await this.waitForGap(job))) return this.finishJob(job, "speaker-continued");
            if (this.job !== job) return;
          }
          this.audio.onended = () => this.finishJob(job, "ended");
          this.audio.onerror = () => this.finishJob(job, "failed", { error: "Audio playback error" });
          this.audio.src = src;
          job.interval = { startMs: this.now(), endMs: null, text: cue.text };
          this.intervals.push(job.interval);
          await this.audio.play();
          if (this.job !== job) return;
          job.playing = true;
          this.vad.boost = 2;
          this.emitPlayback({ state: "playing", cue, startLatencyMs: Math.round(performance.now() - requestedAt) });
        } catch (err) {
          this.finishJob(job, "failed", { error: errorText(err) });
        }
      })();
    });
  }

  private finishJob(job: Job, reason: PlaybackStopReason, extra: { stopLatencyMs?: number; error?: string } = {}) {
    if (this.job !== job) return;
    this.job = null;
    job.abort.abort();
    this.audio.onended = null;
    this.audio.onerror = null;
    this.audio.pause();
    if (job.interval) job.interval.endMs = this.now();
    this.vad.boost = 1;
    this.emitPlayback({ state: "stopped", cue: job.cue, reason, ...extra });
    job.resolve(reason);
  }

  private waitForGap(job: Job): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.gapWaiters.delete(onGap);
        job.abort.signal.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const onGap = () => done(this.job === job);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), this.options.maxGapWaitMs ?? 3000);
      this.gapWaiters.add(onGap);
      job.abort.signal.addEventListener("abort", onAbort);
    });
  }

  private loadAudio(url: string): Promise<string> {
    let entry = this.audioCache.get(url);
    if (!entry) {
      entry = fetch(url).then(async (res) => {
        if (!res.ok) throw new Error(await errorBody(res));
        return URL.createObjectURL(await res.blob());
      });
      entry.catch(() => this.audioCache.delete(url));
      this.audioCache.set(url, entry);
    }
    return entry;
  }

  private report(cue: CueResponse, reason: PlaybackStopReason): PlaybackStopReason {
    this.emitPlayback({ state: "stopped", cue, reason });
    return reason;
  }

  private emitPlayback(event: PlaybackEvent) {
    this.emit("playback", event);
  }

  // ---- Output routing ----

  async listOutputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audiooutput");
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    const audio = this.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof audio.setSinkId !== "function") return false;
    await audio.setSinkId(deviceId);
    return true;
  }

  // ---- Backend ----

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(this.api + path, { ...init, headers: { "Content-Type": "application/json" } });
    if (!res.ok) throw new Error(await errorBody(res));
    return res.json() as Promise<T>;
  }
}

async function errorBody(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error ?? `HTTP ${res.status}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Short stable hash so client-cached audio is keyed by card, level, and text.
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
