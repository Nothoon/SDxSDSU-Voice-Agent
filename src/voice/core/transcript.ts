import type { TranscriptSegment } from "../../shared/types.js";

// Subset of ElevenLabs Scribe realtime server messages that Thread uses
// (message_type strings from @elevenlabs/types 0.29.0).
export type ScribeMessage =
  | { message_type: "session_started"; session_id: string }
  | { message_type: "partial_transcript"; text: string }
  | { message_type: "committed_transcript"; text: string }
  | { message_type: string; text?: string; error?: string };

export const SCRIBE_ERROR_TYPES = new Set([
  "error",
  "auth_error",
  "quota_exceeded",
  "commit_throttled",
  "transcriber_error",
  "unaccepted_terms",
  "rate_limited",
  "input_error",
  "invalid_request",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
]);

// Turns Scribe partial/committed messages into Thread transcript segments.
// A partial and the committed result for the same utterance share one stable ID.
// Times are milliseconds on the voice controller's clock (time since voice start,
// including paused time), observed when messages arrive. They lag the true speech
// onset by the recognition delay; they are ordering hints, not word timestamps.
export class TranscriptNormalizer {
  private utterance = 0;
  private utteranceStartMs: number | null = null;

  constructor(
    private prefix: string,
    private now: () => number,
  ) {}

  handle(message: ScribeMessage): TranscriptSegment | null {
    if (message.message_type === "partial_transcript") {
      const text = (message.text ?? "").trim();
      if (!text) return null;
      const now = this.now();
      this.utteranceStartMs ??= now;
      return { id: this.currentId(), text, startMs: this.utteranceStartMs, endMs: now, isFinal: false };
    }
    if (message.message_type === "committed_transcript") {
      const text = (message.text ?? "").trim();
      const now = this.now();
      const startMs = this.utteranceStartMs ?? now;
      const id = this.currentId();
      this.utterance++;
      this.utteranceStartMs = null;
      return text ? { id, text, startMs, endMs: now, isFinal: true } : null;
    }
    return null;
  }

  private currentId() {
    return `${this.prefix}-${this.utterance}`;
  }
}
