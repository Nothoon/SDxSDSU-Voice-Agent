import { openaiStructured } from "../openai.js";
import { OUTPUT_JSON_SCHEMA, OutputSchema, SYSTEM_PROMPT } from "./claude.js";
import type { SourceDocument } from "./extract.js";
import type { DraftIdea, OutlineGenerator } from "./generator.js";

// Same prompt and output schema as the Claude generator, so both produce the same card contract.
export class OpenAIOutlineGenerator implements OutlineGenerator {
  readonly name = "openai";
  readonly simulated = false;

  constructor(
    private model: string,
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(source: SourceDocument, signal?: AbortSignal): Promise<DraftIdea[]> {
    const content =
      source.kind === "pdf"
        ? [
            { type: "input_file", filename: source.name, file_data: `data:application/pdf;base64,${source.base64}` },
            { type: "input_text", text: "Create the idea cards from the attached presentation." },
          ]
        : [
            {
              type: "input_text",
              text: `<material format="${source.format}">\n${source.text}\n</material>\n\nCreate the idea cards from this material.`,
            },
          ];
    let text: string;
    try {
      text = await openaiStructured(
        { apiKey: this.apiKey, model: this.model, fetchImpl: this.fetchImpl },
        {
          instructions: SYSTEM_PROMPT,
          content,
          schemaName: "idea_cards",
          schema: OUTPUT_JSON_SCHEMA,
          maxOutputTokens: 16000,
          signal,
          timeoutMs: 110_000,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/declined/.test(message)) throw new Error("The outline model declined this material");
      if (/ran out of room/.test(message)) throw new Error("The outline model ran out of room; try a shorter file");
      throw err;
    }
    return OutputSchema.parse(JSON.parse(text)).ideas;
  }
}
