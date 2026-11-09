import type { Route } from "../http.js";
import { SessionError } from "../session.js";
import { ExtractError, MAX_UPLOAD_BYTES, readUpload } from "./extract.js";
import { toIdeaCards, type OutlineGenerator } from "./generator.js";

// Base64 inflates uploads by ~4/3; leave room for the JSON wrapper.
export const OUTLINE_UPLOAD_PATH = "/api/outline/generate";
export const MAX_OUTLINE_UPLOAD_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 1.4);
const MAX_CONCURRENT_GENERATIONS = 3;

export function outlineRoutes(outline: OutlineGenerator): Route[] {
  let generating = 0;

  return [
    // Draft idea cards from uploaded slides/docs or pasted notes. Nothing is stored:
    // the file lives only for this request, and the cards return to the client as an
    // unapproved draft for the speaker to review.
    ["POST", /^\/api\/outline\/generate$/, async ({ res, body }) => {
      if (generating >= MAX_CONCURRENT_GENERATIONS) throw new SessionError("Thread is busy reading other files; try again shortly", 429);
      generating++;
      const abort = new AbortController();
      // Stop paying for generation if the client gives up (closes before we respond).
      const onClose = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.on("close", onClose);
      try {
        const source = readUpload(body ?? {});
        let drafts;
        try {
          drafts = await outline.generate(source, abort.signal);
        } catch (err) {
          if (err instanceof ExtractError) throw err;
          console.error("Outline generation failed:", err instanceof Error ? err.message : err);
          throw new SessionError("Couldn't create talking points from that file. Try again, or paste your notes instead.", 502);
        }
        const cards = toIdeaCards(drafts);
        if (!cards.length) throw new SessionError("No talking points were found in that file. Try pasting your notes instead.", 422);
        return {
          outline: cards,
          source: { name: source.name, kind: source.kind === "pdf" ? "pdf" : source.format },
          provider: outline.name,
          simulated: outline.simulated,
        };
      } catch (err) {
        if (err instanceof ExtractError) throw new SessionError(err.message, err.status);
        throw err;
      } finally {
        generating--;
        res.off("close", onClose);
      }
    }],
  ];
}
