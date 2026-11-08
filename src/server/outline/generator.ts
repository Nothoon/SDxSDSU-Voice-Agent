import type { IdeaCard } from "../../shared/types.js";
import type { SourceDocument } from "./extract.js";

// Draft cards straight from a generator, before normalization.
export type DraftIdea = {
  title: string;
  meaning: string;
  cue: string;
  expandedCue: string;
  mustMention: boolean;
};

export interface OutlineGenerator {
  readonly name: string;
  readonly simulated: boolean; // true for the heuristic stand-in; surfaced so it is never presented as AI
  generate(source: SourceDocument, signal?: AbortSignal): Promise<DraftIdea[]>;
}

export const MIN_IDEAS = 3;
export const MAX_IDEAS = 7;

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
};
const words = (s: string) => s.replace(/[“”"]/g, "").trim().split(/\s+/).filter(Boolean);

// Generated cards are drafts: the speaker still reviews, edits, and approves them.
// Normalization only guarantees they fit the IdeaCard contract and the UI's limits.
export function toIdeaCards(drafts: DraftIdea[]): IdeaCard[] {
  return drafts
    .filter((d) => d.title?.trim() && d.meaning?.trim())
    .slice(0, MAX_IDEAS)
    .map((d, order) => {
      const title = clip(d.title, 80);
      let cue = words(d.cue || "").slice(0, 5);
      if (cue.length < 2) cue = words(title).slice(0, 5);
      if (cue.length < 2) cue = [...cue, ...words(d.meaning)].slice(0, 3);
      return {
        id: `idea-${order + 1}`,
        title,
        meaning: clip(d.meaning, 700),
        cue: clip(cue.join(" ").replace(/[.,;:]+$/, ""), 100),
        expandedCue: clip(d.expandedCue?.trim() || d.meaning, 350),
        mustMention: Boolean(d.mustMention),
        order,
      };
    });
}
