import type { TranscriptSegment } from "../../shared/types.js";

// A span of time when cue audio was playing, on the same clock as transcript segments.
export type PlaybackInterval = { startMs: number; endMs: number | null; text: string };

// Recognition can commit an echoed cue well after the audio ends.
const ECHO_TAIL_MS = 1500;

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

// Second line of defense after browser echo cancellation and the earbud: removes cue
// audio that leaked into the microphone so it never counts as speaker evidence, while
// keeping anything else the speaker said (an interruption during the cue stays).
// Returns null when the whole segment is echo.
export function stripEcho(segment: TranscriptSegment, intervals: PlaybackInterval[]): TranscriptSegment | null {
  const overlapping = intervals.filter(
    (p) => segment.endMs >= p.startMs && segment.startMs <= (p.endMs ?? Infinity) + ECHO_TAIL_MS,
  );
  if (overlapping.length === 0) return segment;

  const cueWords = new Set(overlapping.flatMap((p) => words(p.text)));
  const segWords = words(segment.text);
  if (segWords.length === 0) return segment;

  // Mostly cue words: treat the whole segment as echo.
  const matching = segWords.filter((w) => cueWords.has(w)).length;
  if (matching / segWords.length >= 0.8) return null;

  // Leading cue words followed by speaker words: drop the echoed prefix only.
  const raw = segment.text.trim().split(/\s+/);
  let drop = 0;
  while (drop < raw.length && words(raw[drop]).every((w) => cueWords.has(w))) drop++;
  if (drop < 2) return segment; // One shared word is not evidence of echo.
  const rest = raw.slice(drop).join(" ");
  return rest ? { ...segment, text: rest } : null;
}
