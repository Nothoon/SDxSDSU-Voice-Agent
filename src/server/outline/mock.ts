import { ExtractError, type SourceDocument, type SourceSection } from "./extract.js";
import { MAX_IDEAS, type DraftIdea, type OutlineGenerator } from "./generator.js";

// SIMULATED. Offline stand-in for the outline model so import works without credentials.
// It splits the material by slide or heading and lifts words from it; it does not
// understand the material, merge related slides, or judge what is essential.

const FILLER = new Set("a an and the of to in on for with our your my we is are this that".split(" "));
const SKIP = /^(agenda|outline|contents|table of contents|thank you|thanks|questions\??|q\s*&\s*a)$/i;

export class MockOutlineGenerator implements OutlineGenerator {
  readonly name = "mock";
  readonly simulated = true;

  async generate(source: SourceDocument): Promise<DraftIdea[]> {
    if (source.kind === "pdf") {
      throw new ExtractError(
        "Practice import can't read PDFs. Upload .pptx, .docx, or .txt, or paste your notes. (Server: set OPENAI_API_KEY or ANTHROPIC_API_KEY for AI import.)",
      );
    }
    let sections = source.sections.filter((s) => !SKIP.test(s.heading.trim()) && (s.lines.length || s.notes || s.heading));
    if (sections.length > MAX_IDEAS) sections = group(sections, MAX_IDEAS);
    return sections.map((s) => {
      const body = [...s.lines, s.notes ?? ""].join(" ").trim();
      const title = s.heading || firstWords(body, 6);
      const sentence = firstSentence(body) || title;
      return {
        title,
        meaning: sentence,
        cue: hintFrom(s.heading || body),
        expandedCue: firstSentence(s.notes ?? "") || sentence,
        mustMention: false,
      };
    });
  }
}

// Evenly merge consecutive sections so a long deck becomes at most `n` cards.
function group(sections: SourceSection[], n: number): SourceSection[] {
  const size = Math.ceil(sections.length / n);
  const out: SourceSection[] = [];
  for (let i = 0; i < sections.length; i += size) {
    const chunk = sections.slice(i, i + size);
    out.push({
      heading: chunk.find((s) => s.heading)?.heading ?? "",
      lines: chunk.flatMap((s) => (s === chunk[0] ? s.lines : [s.heading, ...s.lines].filter(Boolean))),
      notes: chunk.map((s) => s.notes).filter(Boolean).join(" ") || undefined,
    });
  }
  return out;
}

const firstSentence = (text: string) => text.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0].trim() ?? text.trim().slice(0, 200);
const firstWords = (text: string, n: number) => text.split(/\s+/).slice(0, n).join(" ");

function hintFrom(text: string) {
  const all = text.replace(/[^\p{L}\p{N}'’\s-]/gu, " ").split(/\s+/).filter(Boolean);
  // Drop leading filler so the hint starts on a content word.
  while (all.length > 2 && FILLER.has(all[0].toLowerCase())) all.shift();
  return all.slice(0, 4).join(" ");
}
