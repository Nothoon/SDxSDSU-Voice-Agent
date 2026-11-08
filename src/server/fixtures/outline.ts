import type { IdeaCard, TranscriptSegment } from "../../shared/types.js";

// The README example outline, used for fixtures, tests, and the mock-mode demo.
export const demoOutline: IdeaCard[] = [
  {
    id: "problem",
    title: "Problem",
    meaning: "Speakers can lose their place even when they know their material",
    cue: "That blank moment",
    expandedCue: "Even when you know your material, you can suddenly lose your place.",
    mustMention: true,
    order: 0,
  },
  {
    id: "story",
    title: "Personal story",
    meaning: "The speaker's approved example of losing their place during a pitch",
    cue: "Your pitch story",
    expandedCue: "Tell them about the pitch where you lost your place.",
    mustMention: false,
    order: 1,
  },
  {
    id: "solution",
    title: "Solution",
    meaning: "Thread follows ideas and offers a brief reminder",
    cue: "A quiet cue",
    expandedCue: "Thread follows your ideas and gives you a short reminder when you ask.",
    mustMention: true,
    order: 2,
  },
  {
    id: "demo",
    title: "Demo",
    meaning: "Show recovery and recognition of reordered points",
    cue: "Show the recovery",
    expandedCue: "Show how Thread helps you recover and handles points said out of order.",
    mustMention: true,
    order: 3,
  },
  {
    id: "closing",
    title: "Closing",
    meaning: "Ask the audience to try Thread",
    cue: "Invite them to try",
    expandedCue: "Close by inviting the audience to try Thread themselves.",
    mustMention: true,
    order: 4,
  },
];

let clock = 0;
function seg(id: string, text: string, durationMs = 4000): TranscriptSegment {
  const startMs = clock;
  clock += durationMs;
  return { id, text, startMs, endMs: clock, isFinal: true };
}

// Transcript fixtures for the README acceptance cases.
export const transcripts = {
  paraphrasedProblem: [
    seg("p1", "You can practice a talk for weeks and still have your mind go totally empty halfway through."),
    seg("p2", "You know the material, but in that moment you can't find where you were."),
  ],
  keywordOnly: [seg("k1", "So, the problem.")],
  reordered: [
    seg("r1", "Speakers lose their place even when they know their material cold."),
    seg("r2", "Let me just show you the demo: watch it recover when I skip around and say points out of order."),
  ],
  halfwayStory: [seg("h1", "A few months ago I was pitching to investors, and")],
};
