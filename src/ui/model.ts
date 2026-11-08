import type { IdeaCard, SessionState } from "../shared/types.js";

export function nextIdea(state: SessionState, currentId: string | null) {
  const cards = [...state.outline].sort((a, b) => a.order - b.order);
  const index = cards.findIndex((c) => c.id === currentId);
  const card = cards
    .slice(index + 1)
    .find((c) => state.coverage[c.id]?.status !== "covered");
  return {
    card: card ?? null,
    message: card
      ? ""
      : state.allCovered
        ? "All points covered."
        : "End of outline — earlier ideas remain. Choose one below to revisit it.",
  };
}
export function validateCard(card: IdeaCard): string {
  if (
    ![card.title, card.meaning, card.cue, card.expandedCue].every((t) =>
      t.trim(),
    )
  )
    return "Fill in each field so Thread knows what to listen for.";
  const words = card.cue.trim().split(/\s+/).length;
  if (words < 2 || words > 5) return "Keep the short hint to 2–5 words.";
  return "";
}
export function formatTime(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function canShortcut(
  event: {
    repeat: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  },
  editable: boolean,
) {
  return (
    !editable &&
    !event.repeat &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}
