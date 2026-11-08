import type { CardCoverage, IdeaCard } from "../shared/types.js";

export type CueChoice =
  | { kind: "card"; card: IdeaCard; reason: "manual" | "partial" | "mustMention" | "next" }
  | { kind: "allCovered" };

export type CueSelectInput = {
  outline: IdeaCard[];
  coverage: Record<string, CardCoverage>;
  selectedCardId: string | null;
  // Card the speaker was most recently working on (latest evidence), if any.
  currentCardId: string | null;
  elapsedMs: number;
  targetDurationSec: number | null;
};

const FINAL_STRETCH = 0.8;

// Deterministic: the same coverage snapshot always selects the same card.
export function selectCue(input: CueSelectInput): CueChoice {
  const ordered = [...input.outline].sort((a, b) => a.order - b.order);
  const status = (id: string) => input.coverage[id]?.status ?? "uncovered";

  // Explicit manual selection wins, even for a covered idea.
  if (input.selectedCardId) {
    const card = ordered.find((c) => c.id === input.selectedCardId);
    if (card) return { kind: "card", card, reason: "manual" };
  }

  // Help finish the idea the speaker is in the middle of.
  if (input.currentCardId && status(input.currentCardId) === "partial") {
    const card = ordered.find((c) => c.id === input.currentCardId);
    if (card) return { kind: "card", card, reason: "partial" };
  }

  const remaining = ordered.filter((c) => status(c.id) !== "covered");
  if (remaining.length === 0) return { kind: "allCovered" };

  if (input.targetDurationSec && input.elapsedMs >= input.targetDurationSec * 1000 * FINAL_STRETCH) {
    const essential = remaining.find((c) => c.mustMention);
    if (essential) return { kind: "card", card: essential, reason: "mustMention" };
  }

  // Next not-yet-covered idea in approved order; ideas covered early are skipped.
  return { kind: "card", card: remaining[0], reason: "next" };
}
