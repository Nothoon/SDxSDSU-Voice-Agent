import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { IdeaCard } from "../../shared/types.js";
import { STREAMING, type Route } from "../http.js";
import { SessionError, type Session } from "../session.js";
import { CueAudioCache } from "./cache.js";
import { VoiceProviderError, type SynthesizedAudio, type VoiceProvider } from "./provider.js";

const PREVIEW_TEXT = "This is your Thread cue.";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function voiceRoutes(get: (id: string) => Session, provider: VoiceProvider): Route[] {
  const cache = new CueAudioCache(provider);

  // Only approved card text can be synthesized, so this is not an open TTS proxy.
  const cardText = (session: Session, cardId: string | null, level: string | null): string => {
    const state = session.state();
    if (!state.outlineApproved) throw new SessionError("Approve the outline before preparing cue audio", 409);
    const card = state.outline.find((c) => c.id === cardId);
    if (!card) throw new SessionError(`Unknown card ${cardId}`, 404);
    // "title" is spoken when the speaker finishes an idea and Thread announces the next one.
    if (level === "title") return card.title;
    if (level !== "short" && level !== "expanded") throw new SessionError("level must be short, expanded, or title");
    return level === "short" ? card.cue : card.expandedCue;
  };

  const synthesize = async (session: Session | null, text: string): Promise<SynthesizedAudio> => {
    try {
      const audio = await cache.get(text);
      session?.setProviderStatus("tts", provider.simulated ? "degraded" : "connected");
      return audio;
    } catch (err) {
      session?.setProviderStatus("tts", "disconnected");
      throw asSessionError(err);
    }
  };

  return [
    ["POST", /^\/api\/sessions\/([\w-]+)\/voice\/stt-token$/, async ({ params }) => {
      const session = get(params[0]);
      const { lifecycle } = session.state();
      if (!["ready", "listening", "paused"].includes(lifecycle)) {
        throw new SessionError("Transcription is available only for an approved, active session", 409);
      }
      try {
        return { ...(await provider.createSttToken()), simulated: provider.simulated };
      } catch (err) {
        session.setProviderStatus("stt", "disconnected");
        throw asSessionError(err);
      }
    }],

    // Synthesize every approved cue after approval so a Cue press never waits on generation.
    ["POST", /^\/api\/sessions\/([\w-]+)\/voice\/prepare$/, async ({ params }) => {
      const session = get(params[0]);
      const { outline } = session.state();
      const jobs = outline.flatMap((card: IdeaCard) => [
        { cardId: card.id, level: "short", text: cardText(session, card.id, "short") },
        { cardId: card.id, level: "expanded", text: cardText(session, card.id, "expanded") },
        { cardId: card.id, level: "title", text: cardText(session, card.id, "title") },
      ]);
      const failed: Array<{ cardId: string; level: string; error: string }> = [];
      for (let i = 0; i < jobs.length; i += 3) {
        await Promise.all(
          jobs.slice(i, i + 3).map((job) =>
            synthesize(session, job.text).catch((err: Error) => {
              failed.push({ cardId: job.cardId, level: job.level, error: err.message });
            }),
          ),
        );
      }
      return { prepared: jobs.length - failed.length, failed, simulated: provider.simulated };
    }],

    ["GET", /^\/api\/sessions\/([\w-]+)\/voice\/cue-audio$/, async ({ req, res, params }) => {
      const session = get(params[0]);
      const query = new URL(req.url ?? "/", "http://localhost").searchParams;
      const text = cardText(session, query.get("cardId"), query.get("level"));
      sendAudio(res, await synthesize(session, text), provider.simulated);
      return STREAMING;
    }],

    // Fixed phrase for the earbud routing and volume check.
    ["GET", /^\/api\/voice\/preview-audio$/, async ({ res }) => {
      sendAudio(res, await synthesize(null, PREVIEW_TEXT), provider.simulated);
      return STREAMING;
    }],

    // Developer test page for the voice adapter. Not the product UI (Ali owns that).
    ["GET", /^\/voice-demo\/?$/, async ({ res }) => {
      await sendFile(res, "src/voice/demo/index.html", "text/html; charset=utf-8");
      return STREAMING;
    }],
    ["GET", /^\/voice-demo\/main\.js$/, async ({ res }) => {
      await sendFile(res, "dist/voice-demo/main.js", "text/javascript; charset=utf-8");
      return STREAMING;
    }],
  ];
}

function sendAudio(res: ServerResponse, { audio, contentType }: SynthesizedAudio, simulated: boolean) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": audio.length,
    "Cache-Control": "private, max-age=3600",
    "X-Thread-Simulated": simulated ? "true" : "false",
  });
  res.end(audio);
}

async function sendFile(res: ServerResponse, path: string, contentType: string) {
  try {
    const body = await readFile(ROOT + path);
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" }).end(body);
  } catch {
    throw new SessionError(`${path} not found; run npm run build:voice`, 404);
  }
}

function asSessionError(err: unknown): SessionError {
  if (err instanceof SessionError) return err;
  const status = err instanceof VoiceProviderError ? err.status : (502 as const);
  return new SessionError(err instanceof Error ? err.message : String(err), status);
}
