import type { CoverageUpdate } from "../../shared/types.js";
import type { CoverageAdapter, CoverageRequest } from "./adapter.js";

// SIMULATED. Offline stand-in for the semantic model so the UI and voice adapter can
// develop without credentials. It matches content-word overlap against each card's
// meaning; it does not understand paraphrase the way the real model does.

const STOPWORDS = new Set(
  "a an and are as at be but by can do even for from has have i in is it its know lose of on or our so that the their them they this to us we what when with you your".split(
    " ",
  ),
);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map((w) => w.replace(/(ing|ed|s)$/, "")),
  );
}

export class MockCoverageAdapter implements CoverageAdapter {
  readonly name = "mock";
  readonly simulated = true;

  async evaluate(request: CoverageRequest): Promise<CoverageUpdate[]> {
    const updates: CoverageUpdate[] = [];
    for (const card of request.outline) {
      const target = contentWords(card.meaning);
      if (target.size === 0) continue;
      let best = 0;
      const evidence: string[] = [];
      for (const seg of request.segments) {
        const words = contentWords(seg.text);
        const hits = [...target].filter((w) => words.has(w)).length;
        const ratio = hits / target.size;
        if (ratio >= 0.25) evidence.push(seg.id);
        best = Math.max(best, ratio);
      }
      // A single shared word is never enough.
      if (best >= 0.5) {
        updates.push({ cardId: card.id, status: "covered", confidence: best, evidenceSegmentIds: evidence });
      } else if (best >= 0.25) {
        updates.push({
          cardId: card.id,
          status: "partial",
          confidence: best,
          evidenceSegmentIds: evidence,
          missingMeaning: card.meaning,
        });
      }
    }
    return updates;
  }
}
