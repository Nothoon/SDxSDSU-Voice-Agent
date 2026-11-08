import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CoverageStatus, CueLevel, ProviderName, ProviderStatus } from "../shared/types.js";
import type { CoverageAdapter } from "./coverage/adapter.js";
import { demoOutline } from "./fixtures/outline.js";
import { ExtractError, MAX_UPLOAD_BYTES, readUpload } from "./outline/extract.js";
import { toIdeaCards, type OutlineGenerator } from "./outline/generator.js";
import { MockOutlineGenerator } from "./outline/mock.js";
import { STREAMING, type Route } from "./http.js";
import { Session, SessionError } from "./session.js";
import { MockVoiceProvider } from "./voice/mock.js";
import type { VoiceProvider } from "./voice/provider.js";
import { voiceRoutes } from "./voice/routes.js";

import { uiRoutes } from "../ui/routes.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SESSIONS = 50;
// Base64 inflates uploads by ~4/3; leave room for the JSON wrapper.
const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 1.4);
const UPLOAD_PATH = "/api/outline/generate";
const MAX_CONCURRENT_GENERATIONS = 3;

export function createApp(options: {
  adapter: () => CoverageAdapter;
  voice?: VoiceProvider;
  outline?: OutlineGenerator;
  allowedOrigin?: string;
}) {
  const sessions = new Map<string, Session>();
  const voice = options.voice ?? new MockVoiceProvider();
  const outline = options.outline ?? new MockOutlineGenerator();
  let generating = 0;

  const get = (id: string) => {
    const session = sessions.get(id);
    if (!session) throw new SessionError("Session not found", 404);
    return session;
  };

  const routes: Route[] = [
    ["GET", /^\/api\/health$/, () => ({
      ok: true,
      coverage: options.adapter().name,
      voice: { provider: voice.name, simulated: voice.simulated, stt: voice.sttAvailable },
      outline: { provider: outline.name, simulated: outline.simulated },
    })],
    ["GET", /^\/api\/fixtures\/outline$/, () => ({ outline: demoOutline })],

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

    ["POST", /^\/api\/sessions$/, ({ body }) => {
      if (sessions.size >= MAX_SESSIONS) {
        // Session memory only: drop the oldest ended session first.
        const ended = [...sessions.values()].find((s) => s.state().lifecycle === "ended");
        if (!ended) throw new SessionError("Too many active sessions", 409);
        sessions.delete(ended.id);
      }
      const session = new Session(options.adapter());
      if (body?.outline) session.setOutline(body.outline, body.targetDurationSec ?? null);
      sessions.set(session.id, session);
      return session.state();
    }],
    ["GET", /^\/api\/sessions\/([\w-]+)$/, ({ params }) => get(params[0]).state()],
    ["PUT", /^\/api\/sessions\/([\w-]+)\/outline$/, ({ params, body }) => {
      const s = get(params[0]);
      s.setOutline(body?.outline, body?.targetDurationSec);
      return s.state();
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/(approve|start|pause|resume|end)$/, ({ params }) => {
      const s = get(params[0]);
      ({ approve: () => s.approve(), start: () => s.start(), pause: () => s.pause(), resume: () => s.resume(), end: () => s.end() })[
        params[1] as "approve"
      ]();
      return s.state();
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/segments$/, ({ params, body }) => {
      const segments = Array.isArray(body?.segments) ? body.segments : body?.segment ? [body.segment] : null;
      if (!segments) throw new SessionError("Provide segment or segments");
      return get(params[0]).addSegments(segments);
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/cue$/, ({ params, body }) => {
      const level: CueLevel = body?.level === "expanded" ? "expanded" : "short";
      return get(params[0]).requestCue(level);
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/select$/, ({ params, body }) => {
      const s = get(params[0]);
      s.selectCard(typeof body?.cardId === "string" ? body.cardId : null);
      return s.state();
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/coverage$/, ({ params, body }) => {
      const s = get(params[0]);
      s.setCoverage(String(body?.cardId), body?.status as CoverageStatus);
      return s.state();
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/providers$/, ({ params, body }) => {
      const s = get(params[0]);
      const provider = body?.provider as ProviderName;
      const status = body?.status as ProviderStatus;
      if (!["stt", "tts"].includes(provider) || !["connected", "degraded", "disconnected"].includes(status)) {
        throw new SessionError("provider must be stt|tts; status connected|degraded|disconnected");
      }
      s.setProviderStatus(provider, status);
      return s.state();
    }],
    ["GET", /^\/api\/sessions\/([\w-]+)\/recap$/, ({ params }) => get(params[0]).recap()],
    ["GET", /^\/api\/sessions\/([\w-]+)\/transcript$/, ({ params }) => ({ segments: get(params[0]).transcript() })],
    ["GET", /^\/api\/sessions\/([\w-]+)\/events$/, ({ req, res, params }) => {
      const s = get(params[0]);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ type: "state", state: s.state() });
      const unsubscribe = s.subscribe(send);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      return STREAMING;
    }],
    ...voiceRoutes(get, voice),
    ...uiRoutes,
  ];

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", options.allowedOrigin ?? "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(path);
        if (!match || method !== req.method) continue;
        const body = req.method === "GET" ? undefined : await readJson(req, path === UPLOAD_PATH ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES);
        const result = await handler({ req, res, params: match.slice(1), body });
        if (result !== STREAMING) json(res, 200, result);
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof SessionError) json(res, err.status, { error: err.message });
      else {
        console.error("Unhandled error:", err instanceof Error ? err.message : err);
        json(res, 500, { error: "Internal error" });
      }
    }
  });

  return { server, sessions };
}

function json(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new SessionError("Request body too large", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SessionError("Invalid JSON body");
  }
}
