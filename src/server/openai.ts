// Minimal OpenAI Responses API client shared by the outline and coverage adapters.
// Called with fetch so no SDK dependency is needed; request and response shapes checked
// against the openai 7.53.0 SDK types.
const ENDPOINT = "https://api.openai.com/v1/responses";

export type OpenAIConfig = {
  apiKey: string; // Read server-side only; never sent to the browser or logged.
  model: string;
  fetchImpl?: typeof fetch;
};

export type StructuredRequest = {
  instructions: string;
  content: Array<Record<string, unknown>>; // input_text / input_file parts for one user message
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  signal?: AbortSignal;
  timeoutMs: number;
};

type ResponsesOutput = {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
};

// Returns the model's JSON text for a strict json_schema response.
export async function openaiStructured(config: OpenAIConfig, req: StructuredRequest): Promise<string> {
  let res: Response;
  try {
    res = await (config.fetchImpl ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        instructions: req.instructions,
        input: [{ role: "user", content: req.content }],
        text: { format: { type: "json_schema", name: req.schemaName, schema: req.schema, strict: true } },
        max_output_tokens: req.maxOutputTokens,
        ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort } } : {}),
        store: false, // Don't keep the speaker's material in OpenAI's stored responses.
      }),
      signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]) : AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    if (req.signal?.aborted) throw err;
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
        ? "The model ran out of room; try a shorter file"
        : `The model stopped early (${reason ?? "incomplete"})`,
    );
  }
  const parts = (body.output ?? []).flatMap((item) => (item.type === "message" ? (item.content ?? []) : []));
  if (parts.some((p) => p.type === "refusal")) throw new Error("The model declined this request");
  const text = parts.flatMap((p) => (p.type === "output_text" && p.text ? [p.text] : [])).join("");
  if (!text) throw new Error("The model returned no output");
  return text;
}
