import type { CoverageUpdate } from "../../shared/types.js";
import { openaiStructured } from "../openai.js";
import type { CoverageAdapter, CoverageRequest } from "./adapter.js";
import { OUTPUT_JSON_SCHEMA, OutputSchema, SYSTEM_PROMPT } from "./claude.js";

// Same prompt and output schema as the Claude adapter. The session validates every update
// (known cards, real segment IDs, confidence threshold, stale revisions) before applying it.
export class OpenAICoverageAdapter implements CoverageAdapter {
  readonly name = "openai";
  readonly simulated = false;

  constructor(
    private model: string,
    private apiKey: string,
    private reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" = "low",
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async evaluate(request: CoverageRequest, signal?: AbortSignal): Promise<CoverageUpdate[]> {
    const cards = request.outline.map((c) => ({
      id: c.id,
      title: c.title,
      meaning: c.meaning,
      order: c.order,
      currentStatus: request.current[c.id]?.status ?? "uncovered",
    }));
    const transcript = request.segments.map((s) => ({ id: s.id, text: s.text }));
    const text = await openaiStructured(
      { apiKey: this.apiKey, model: this.model, fetchImpl: this.fetchImpl },
      {
        instructions: SYSTEM_PROMPT,
        content: [
          {
            type: "input_text",
            text: `<idea_cards>\n${JSON.stringify(cards)}\n</idea_cards>\n\n<speaker_transcript>\n${JSON.stringify(transcript)}\n</speaker_transcript>`,
          },
        ],
        schemaName: "coverage_updates",
        // Strict mode requires every property to be listed in `required`, so missingMeaning
        // is nullable here instead of optional.
        schema: STRICT_SCHEMA,
        maxOutputTokens: 4000,
        // Low effort keeps per-segment latency down; coverage is a short classification.
        reasoningEffort: this.reasoningEffort,
        signal,
        timeoutMs: 30_000,
      },
    );
    const parsed = JSON.parse(text) as { updates: Array<Record<string, unknown>> };
    for (const u of parsed.updates ?? []) if (u.missingMeaning === null) delete u.missingMeaning;
    return OutputSchema.parse(parsed).updates;
  }
}

const item = OUTPUT_JSON_SCHEMA.properties.updates.items;
const STRICT_SCHEMA = {
  ...OUTPUT_JSON_SCHEMA,
  properties: {
    updates: {
      ...OUTPUT_JSON_SCHEMA.properties.updates,
      items: {
        ...item,
        properties: { ...item.properties, missingMeaning: { type: ["string", "null"] } },
        required: [...item.required, "missingMeaning"],
      },
    },
  },
};
