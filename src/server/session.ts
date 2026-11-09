import { randomUUID } from "node:crypto";
import type {
  CueSource,
  CardCoverage,
  CoverageStatus,
  CoverageUpdate,
  CueLevel,
  CueResponse,
  IdeaCard,
  ProviderName,
  ProviderStatus,
  SessionEvent,
  SessionLifecycle,
  SessionRecap,
  SessionState,
  TranscriptSegment,
  TrackingStatus,
} from "../shared/types.js";
import type { CoverageAdapter } from "./coverage/adapter.js";
import { selectCue } from "./cue.js";

export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 422 | 429 | 502 | 503 = 400,
  ) {
    super(message);
  }
}

const AUTO_HINT_COOLDOWN_MS = 10_000;
const AUTO_HINT_SETTLE_MS = 2_500;

// Below this, a "covered" judgment is held at "partial" until more speech confirms it.
const COVERED_MIN_CONFIDENCE = 0.6;
const ALL_COVERED_TEXT = "All points covered.";
const STATUS_RANK: Record<CoverageStatus, number> = { uncovered: 0, partial: 1, covered: 2 };

export function validateOutline(cards: unknown): IdeaCard[] {
  if (!Array.isArray(cards) || cards.length === 0 || cards.length > 12) {
    throw new SessionError("Outline must contain between 1 and 12 cards");
  }
  const ids = new Set<string>();
  return cards.map((raw, index) => {
    const c = raw as Partial<IdeaCard>;
    const str = (v: unknown, field: string) => {
      if (typeof v !== "string" || !v.trim()) throw new SessionError(`Card ${index}: ${field} is required`);
      return v.trim();
    };
    const id = typeof c.id === "string" && c.id.trim() ? c.id.trim() : `card-${index + 1}`;
    if (ids.has(id)) throw new SessionError(`Duplicate card id ${id}`);
    ids.add(id);
    const cue = str(c.cue, "cue");
    if (cue.split(/\s+/).length > 5) throw new SessionError(`Card ${id}: cue must be at most 5 words`);
    return {
      id,
      title: str(c.title, "title"),
      meaning: str(c.meaning, "meaning"),
      cue,
      expandedCue: str(c.expandedCue, "expandedCue"),
      mustMention: Boolean(c.mustMention),
      order: typeof c.order === "number" ? c.order : index,
    };
  });
}

export class Session {
  readonly id = randomUUID();
  private lifecycle: SessionLifecycle = "draft";
  private outline: IdeaCard[] = [];
  private outlineApproved = false;
  private targetDurationSec: number | null = null;
  private coverage: Record<string, CardCoverage> = {};
  private segments: TranscriptSegment[] = [];
  private seenSegmentIds = new Set<string>();
  private selectedCardId: string | null = null;
  private currentCardId: string | null = null;
  private lastCue: CueResponse | null = null;
  private lastCueContext = -1;
  private trackingStatus: TrackingStatus = "ok";
  private providers: Record<ProviderName, ProviderStatus> = {
    stt: "disconnected",
    tts: "disconnected",
    coverage: "connected",
  };
  private stateRevision = 0;
  private transcriptRevision = 0;
  // Bumps on new speech or manual selection; repeated Cue requests within one context reuse the cue.
  private cueContext = 0;
  private appliedCoverageRevision = 0;
  private coverageInFlight: AbortController | null = null;
  private coverageDirty = false;
  private accumulatedMs = 0;
  private listeningSince: number | null = null;
  private cueRequests = 0;
  private autoHints = 0;
  private lastAutoHintAt: number | null = null;
  private expandedRequests = 0;
  private listeners = new Set<(event: SessionEvent) => void>();

  constructor(
    private adapter: CoverageAdapter,
    private now: () => number = Date.now,
  ) {
    if (adapter.simulated) this.providers.coverage = "degraded";
  }

  // ---- Observation ----

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SessionEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private changed(event?: (state: SessionState) => SessionEvent) {
    this.stateRevision++;
    const state = this.state();
    this.emit(event ? event(state) : { type: "state", state });
  }

  private elapsedMs(): number {
    return this.accumulatedMs + (this.listeningSince === null ? 0 : this.now() - this.listeningSince);
  }

  private allCovered(): boolean {
    return this.outline.length > 0 && this.outline.every((c) => this.coverage[c.id]?.status === "covered");
  }

  state(): SessionState {
    return {
      id: this.id,
      lifecycle: this.lifecycle,
      outline: this.outline,
      outlineApproved: this.outlineApproved,
      targetDurationSec: this.targetDurationSec,
      elapsedMs: this.elapsedMs(),
      coverage: this.coverage,
      selectedCardId: this.selectedCardId,
      lastCue: this.lastCue,
      allCovered: this.allCovered(),
      trackingStatus: this.trackingStatus,
      providers: { ...this.providers },
      stateRevision: this.stateRevision,
      transcriptRevision: this.transcriptRevision,
    };
  }

  // Full transcript stays out of the main state; it is for the separate debug view.
  transcript(): TranscriptSegment[] {
    return [...this.segments];
  }

  // ---- Preparation ----

  setOutline(cards: unknown, targetDurationSec?: number | null) {
    if (this.lifecycle !== "draft" && this.lifecycle !== "ready") {
      throw new SessionError("Outline can only change before the session starts", 409);
    }
    this.outline = validateOutline(cards);
    if (targetDurationSec !== undefined) this.targetDurationSec = targetDurationSec;
    this.coverage = Object.fromEntries(this.outline.map((c) => [c.id, emptyCoverage(c.id)]));
    this.outlineApproved = false;
    this.lifecycle = "draft";
    this.changed();
  }

  approve() {
    if (this.lifecycle !== "draft" || this.outline.length === 0) {
      throw new SessionError("Add an outline before approving", 409);
    }
    this.outlineApproved = true;
    this.lifecycle = "ready";
    this.changed();
  }

  // ---- Lifecycle ----

  start() {
    if (this.lifecycle !== "ready") throw new SessionError("Approve the outline before starting", 409);
    this.lifecycle = "listening";
    this.listeningSince = this.now();
    this.changed();
  }

  pause() {
    if (this.lifecycle !== "listening") throw new SessionError("Session is not listening", 409);
    this.accumulatedMs = this.elapsedMs();
    this.listeningSince = null;
    this.lifecycle = "paused";
    this.coverageInFlight?.abort();
    this.changed();
  }

  resume() {
    if (this.lifecycle !== "paused") throw new SessionError("Session is not paused", 409);
    this.lifecycle = "listening";
    this.listeningSince = this.now();
    this.changed();
  }

  end() {
    if (this.lifecycle === "ended") return;
    this.accumulatedMs = this.elapsedMs();
    this.listeningSince = null;
    this.lifecycle = "ended";
    this.coverageInFlight?.abort();
    this.coverageInFlight = null;
    // Clear application session buffers. Coverage and counters remain for the recap.
    this.segments = [];
    this.seenSegmentIds.clear();
    this.changed();
  }

  setProviderStatus(provider: ProviderName, status: ProviderStatus) {
    if (this.providers[provider] === status) return;
    this.providers[provider] = status;
    this.changed();
  }

  // ---- Speech ----

  addSegments(input: TranscriptSegment[]): { accepted: number; ignored: number } {
    if (this.lifecycle !== "listening") {
      // Pause suspends tracking; late segments after pause/end are dropped.
      return { accepted: 0, ignored: input.length };
    }
    let accepted = 0;
    for (const seg of input) {
      if (!isSegment(seg)) throw new SessionError("Invalid transcript segment");
      if (!seg.isFinal) {
        // Partial transcripts may update a preview but never coverage.
        this.emit({ type: "partialTranscript", segment: seg });
        continue;
      }
      if (this.seenSegmentIds.has(seg.id) || !seg.text.trim()) continue;
      this.seenSegmentIds.add(seg.id);
      this.segments.push(seg);
      accepted++;
    }
    if (accepted > 0) {
      this.segments.sort((a, b) => a.startMs - b.startMs);
      this.transcriptRevision++;
      this.cueContext++;
      this.changed();
      this.scheduleCoverage();
    }
    return { accepted, ignored: input.length - accepted };
  }

  // Resolves once no coverage evaluation is pending, or after timeoutMs. Returns whether it settled.
  async settled(timeoutMs = Infinity): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.coverageInFlight || this.coverageDirty) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 5));
    }
    return true;
  }

  private scheduleCoverage() {
    if (this.coverageInFlight) {
      // Coalesce: one evaluation in flight, at most one queued with the latest transcript.
      this.coverageDirty = true;
      return;
    }
    void this.runCoverage();
  }

  private async runCoverage() {
    this.coverageDirty = false;
    const controller = new AbortController();
    this.coverageInFlight = controller;
    const revision = this.transcriptRevision;
    try {
      const updates = await this.adapter.evaluate(
        {
          outline: this.outline,
          segments: [...this.segments],
          current: structuredClone(this.coverage),
          transcriptRevision: revision,
        },
        controller.signal,
      );
      if (!controller.signal.aborted) this.applyCoverage(updates, revision);
    } catch (err) {
      if (!controller.signal.aborted) {
        this.trackingStatus = "unavailable";
        this.providers.coverage = "disconnected";
        this.changed();
        this.emit({ type: "error", message: `Coverage tracking failed: ${errorMessage(err)}` });
      }
    } finally {
      if (this.coverageInFlight === controller) this.coverageInFlight = null;
      if (this.coverageDirty && this.lifecycle === "listening") void this.runCoverage();
      else this.coverageDirty = false;
    }
  }

  // Validates model output and applies it. Returns the updates that were applied.
  applyCoverage(updates: CoverageUpdate[], revision: number): CoverageUpdate[] {
    if (revision <= this.appliedCoverageRevision || this.lifecycle === "ended") {
      return []; // Stale: a newer transcript revision has already been applied.
    }
    this.appliedCoverageRevision = revision;
    const segmentIds = new Set(this.segments.map((s) => s.id));
    const segmentEnd = new Map(this.segments.map((s) => [s.id, s.endMs]));
    const applied: CoverageUpdate[] = [];
    let rejected = 0;
    let latestEvidence = { endMs: -1, cardId: null as string | null };

    for (const update of updates) {
      const existing = this.coverage[update.cardId];
      if (!existing || !(update.status in STATUS_RANK)) {
        rejected++;
        continue;
      }
      const evidence = (update.evidenceSegmentIds ?? []).filter((id) => segmentIds.has(id));
      if (update.status !== "uncovered" && evidence.length === 0) {
        rejected++; // Coverage must cite transcript evidence.
        continue;
      }
      const confidence = clamp01(update.confidence);
      let status = update.status;
      if (status === "covered" && confidence < COVERED_MIN_CONFIDENCE) status = "partial";

      for (const id of evidence) {
        const end = segmentEnd.get(id) ?? -1;
        if (end > latestEvidence.endMs) latestEvidence = { endMs: end, cardId: update.cardId };
      }

      // Coverage only moves forward, and never overrides the speaker's manual correction.
      if (existing.manual || STATUS_RANK[status] < STATUS_RANK[existing.status]) continue;
      if (STATUS_RANK[status] === STATUS_RANK[existing.status] && status === "covered") continue;

      this.coverage[update.cardId] = {
        cardId: update.cardId,
        status,
        confidence,
        evidenceSegmentIds: evidence,
        missingMeaning: status === "partial" ? update.missingMeaning : undefined,
        manual: false,
      };
      applied.push({ ...update, status, confidence, evidenceSegmentIds: evidence });
    }

    if (latestEvidence.cardId) this.currentCardId = latestEvidence.cardId;
    // A manual selection lasts until the speaker actually covers that idea.
    if (this.selectedCardId && applied.some((u) => u.cardId === this.selectedCardId && u.status === "covered")) {
      this.selectedCardId = null;
    }
    this.trackingStatus = rejected > 0 ? "uncertain" : "ok";
    if (this.providers.coverage === "disconnected") {
      this.providers.coverage = this.adapter.simulated ? "degraded" : "connected";
    }
    this.changed((state) => ({ type: "coverage", state, updates: applied }));
    return applied;
  }

  // ---- Speaker control ----

  selectCard(cardId: string | null) {
    if (cardId !== null && !this.coverage[cardId]) throw new SessionError(`Unknown card ${cardId}`, 404);
    this.selectedCardId = cardId;
    this.cueContext++;
    this.changed();
  }

  // Manual correction from the speaker; tracking will not override it.
  setCoverage(cardId: string, status: CoverageStatus) {
    if (!this.coverage[cardId]) throw new SessionError(`Unknown card ${cardId}`, 404);
    if (!(status in STATUS_RANK)) throw new SessionError("Invalid status");
    this.coverage[cardId] = { ...emptyCoverage(cardId), status, confidence: 1, manual: true };
    this.cueContext++;
    this.changed();
  }

  requestCue(level: CueLevel, source: CueSource = "manual"): CueResponse {
    if (this.lifecycle !== "listening") throw new SessionError("Cues are available only while listening", 409);
    if (source === "auto") this.autoHints++;
    else this.cueRequests++;
    if (level === "expanded") this.expandedRequests++;

    // More expands the last delivered cue; it never advances to another card.
    if (level === "expanded" && this.lastCue) {
      return this.deliverCue(this.lastCue.cardId, "expanded", source);
    }
    // Repeated Cue reuses the current cue until new speech or a manual selection.
    if (level === "short" && this.lastCue && this.lastCueContext === this.cueContext) {
      return this.deliverCue(this.lastCue.cardId, "short", source);
    }

    const choice = selectCue({
      outline: this.outline,
      coverage: this.coverage,
      selectedCardId: this.selectedCardId,
      currentCardId: this.currentCardId,
      elapsedMs: this.elapsedMs(),
      targetDurationSec: this.targetDurationSec,
    });
    return this.deliverCue(choice.kind === "card" ? choice.card.id : null, level, source);
  }

  // Opt-in Auto Hint. The voice controller decides *when* (a pause after real speech); the
  // server decides *whether*: only from settled, reliable tracking, and never more often than
  // the cooldown. Refusals are 409s the client shows as a quiet status, not an error.
  async requestAutoCue(): Promise<CueResponse> {
    if (this.lifecycle !== "listening") throw new SessionError("Cues are available only while listening", 409);
    if (this.lastAutoHintAt !== null && this.now() - this.lastAutoHintAt < AUTO_HINT_COOLDOWN_MS) {
      throw new SessionError("Auto hint skipped: one plays at most every 10 seconds", 409);
    }
    // Wait briefly for the latest speech to be evaluated so the hint reflects it.
    const settled = await this.settled(AUTO_HINT_SETTLE_MS);
    if (this.lifecycle !== "listening") throw new SessionError("Cues are available only while listening", 409);
    if (!settled) throw new SessionError("Auto hint skipped: tracking is still catching up", 409);
    if (
      this.trackingStatus !== "ok" ||
      this.providers.coverage === "disconnected" ||
      this.providers.stt === "disconnected"
    ) {
      throw new SessionError("Auto hint skipped: tracking is uncertain. Ask for a hint or pick an idea", 409);
    }
    this.lastAutoHintAt = this.now();
    return this.requestCue("short", "auto");
  }

  private deliverCue(cardId: string | null, level: CueLevel, source: CueSource = "manual"): CueResponse {
    const card = cardId ? this.outline.find((c) => c.id === cardId) : undefined;
    // Cue text always comes from approved card fields, never from the model.
    const text = !card ? ALL_COVERED_TEXT : level === "short" ? card.cue : card.expandedCue;
    this.stateRevision++;
    const cue: CueResponse = {
      requestId: randomUUID(),
      cardId: card?.id ?? null,
      level,
      text,
      stateRevision: this.stateRevision,
      source,
    };
    this.lastCue = cue;
    this.lastCueContext = this.cueContext;
    // stateRevision was bumped above, so emit directly instead of via changed().
    this.emit({ type: "cue", state: this.state(), cue });
    return cue;
  }

  recap(): SessionRecap {
    const ordered = [...this.outline].sort((a, b) => a.order - b.order);
    const by = (s: CoverageStatus) => ordered.filter((c) => this.coverage[c.id]?.status === s);
    return {
      sessionId: this.id,
      covered: by("covered").map((c) => c.id),
      partial: by("partial").map((c) => c.id),
      missedMustMention: ordered.filter((c) => c.mustMention && this.coverage[c.id]?.status !== "covered").map((c) => c.id),
      missed: by("uncovered").map((c) => c.id),
      cueRequests: this.cueRequests,
      expandedRequests: this.expandedRequests,
      autoHints: this.autoHints,
      durationMs: this.elapsedMs(),
    };
  }
}

function emptyCoverage(cardId: string): CardCoverage {
  return { cardId, status: "uncovered", confidence: 0, evidenceSegmentIds: [], manual: false };
}

function isSegment(v: unknown): v is TranscriptSegment {
  const s = v as TranscriptSegment;
  return (
    !!s &&
    typeof s.id === "string" &&
    typeof s.text === "string" &&
    typeof s.startMs === "number" &&
    typeof s.endMs === "number" &&
    typeof s.isFinal === "boolean"
  );
}

function clamp01(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
