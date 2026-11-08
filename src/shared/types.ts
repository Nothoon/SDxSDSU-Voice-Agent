// Shared contracts between the backend (Nathan), UI (Ali), and voice adapter (Vineet).
// Changes here are coordinated through Nathan and reviewed with both other owners.

export type IdeaCard = {
  id: string;
  title: string;
  meaning: string;
  cue: string; // Approved, 2–5 words
  expandedCue: string; // Approved, one short sentence
  mustMention: boolean;
  order: number;
};

export type TranscriptSegment = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
};

export type CoverageStatus = "uncovered" | "partial" | "covered";

export type CoverageUpdate = {
  cardId: string;
  status: CoverageStatus;
  confidence: number; // Model estimate; tune against test cases
  evidenceSegmentIds: string[];
  missingMeaning?: string;
};

export type CueLevel = "short" | "expanded";

export type CueResponse = {
  requestId: string;
  cardId: string | null; // null when every idea is covered
  level: CueLevel;
  text: string;
  audioUrl?: string; // Text remains usable if audio is unavailable
  stateRevision: number; // Reject stale results before playback
};

// Session lifecycle is separate from provider connectivity, so a dropped
// connection never erases coverage.
export type SessionLifecycle = "draft" | "ready" | "listening" | "paused" | "ended";

export type ProviderName = "stt" | "tts" | "coverage";
export type ProviderStatus = "connected" | "degraded" | "disconnected";

// "ok": coverage reflects the latest finalized speech.
// "uncertain": the last update was low confidence or rejected; showing last reliable state.
// "unavailable": the coverage provider failed; use manual card selection.
export type TrackingStatus = "ok" | "uncertain" | "unavailable";

export type CardCoverage = {
  cardId: string;
  status: CoverageStatus;
  confidence: number;
  evidenceSegmentIds: string[];
  missingMeaning?: string;
  manual: boolean; // true when the speaker set this state by hand
};

export type SessionState = {
  id: string;
  lifecycle: SessionLifecycle;
  outline: IdeaCard[];
  outlineApproved: boolean;
  targetDurationSec: number | null;
  elapsedMs: number; // Excludes paused time
  coverage: Record<string, CardCoverage>;
  // Card the speaker manually selected; overrides automatic next-idea choice for Cue.
  selectedCardId: string | null;
  lastCue: CueResponse | null;
  allCovered: boolean;
  trackingStatus: TrackingStatus;
  providers: Record<ProviderName, ProviderStatus>;
  // Monotonic counters. stateRevision bumps on any change; transcriptRevision on each
  // newly accepted finalized segment.
  stateRevision: number;
  transcriptRevision: number;
};

export type SessionRecap = {
  sessionId: string;
  covered: string[];
  partial: string[];
  missedMustMention: string[];
  missed: string[];
  cueRequests: number;
  expandedRequests: number;
  durationMs: number;
};

// Server-sent events on GET /api/sessions/:id/events. Every event carries the full
// state so clients never need to merge partial updates.
export type SessionEvent =
  | { type: "state"; state: SessionState }
  | { type: "coverage"; state: SessionState; updates: CoverageUpdate[] }
  | { type: "cue"; state: SessionState; cue: CueResponse }
  | { type: "partialTranscript"; segment: TranscriptSegment }
  | { type: "error"; message: string };
