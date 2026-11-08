import { OUTPUT_JSON_SCHEMA, OutputSchema, SYSTEM_PROMPT } from "./claude.js";
import type { SourceDocument } from "./extract.js";
import type { DraftIdea, OutlineGenerator } from "./generator.js";

// OpenAI Responses API, called with fetch so no SDK dependency is needed. Request and
// response shapes checked against the openai 7.53.0 SDK types. Uses the same prompt and
// output schema as the Claude generator, so both produce the same card contract.
const ENDPOINT = "https://api.openai.com/v1/responses";

type ResponsesOutput = {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
};

export class OpenAIOutlineGenerator implements OutlineGenerator {
  readonly name = "openai";
  readonly simulated = false;

  constructor(
    private model: string,
    // Read server-side only; never sent to the browser or logged.
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

    let res: Response;
    try {
      res = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          instructions: SYSTEM_PROMPT,
          input: [{ role: "user", content }],
          text: { format: { type: "json_schema", name: "idea_cards", schema: OUTPUT_JSON_SCHEMA, strict: true } },
          max_output_tokens: 16000,
          store: false, // Don't keep the speaker's material in OpenAI's stored responses.
        }),
        signal: signal ?? AbortSignal.timeout(110_000),
      });
    } catch (err) {
      throw new Error(`OpenAI unreachable: ${err instanceof Error ? err.message : err}`);
    }

    const body = (await res.json().catch(() => ({}))) as ResponsesOutput;
    if (!res.ok) {
      // Short, key-free summary; never log the request (it holds the speaker's material).
      throw new Error(`OpenAI ${res.status}: ${(body.error?.message ?? "request failed").slice(0, 200)}`);
    }
    if (body.status === "incomplete") {
      const reason = body.incomplete_details?.reason;
      throw new Error(
        reason === "max_output_tokens"
          ? "The outline model ran out of room; try a shorter file"
          : `The outline model stopped early (${reason ?? "incomplete"})`,
      );
    }
    const parts = (body.output ?? []).flatMap((item) => (item.type === "message" ? (item.content ?? []) : []));
    if (parts.some((p) => p.type === "refusal")) throw new Error("The outline model declined this material");
    const text = parts.flatMap((p) => (p.type === "output_text" && p.text ? [p.text] : [])).join("");
    if (!text) throw new Error("The outline model returned no cards");
    return OutputSchema.parse(JSON.parse(text)).ideas;
  }
}
