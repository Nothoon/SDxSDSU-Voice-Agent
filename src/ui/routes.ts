// Product assets only. Backend and voice routes remain owned by their existing modules.
import { readFile } from "node:fs/promises";
import type { Route } from "../server/http.js";
import { STREAMING } from "../server/http.js";
const files = new Map([
  ["/", ["src/ui/index.html", "text/html; charset=utf-8"]],
  ["/ui/app.js", ["dist/ui/app.js", "text/javascript; charset=utf-8"]],
  ["/ui/styles.css", ["src/ui/styles.css", "text/css; charset=utf-8"]],
]);
export const uiRoutes: Route[] = [
  [
    "GET",
    /^(?:\/|\/ui\/(?:app\.js|styles\.css))$/,
    async ({ req, res }) => {
      const asset = files.get(
        new URL(req.url ?? "/", "http://localhost").pathname,
      )!;
      try {
        const body = await readFile(
          new URL("../../" + asset[0], import.meta.url),
        );
        res
          .writeHead(200, {
            "Content-Type": asset[1],
            "Cache-Control": "no-cache",
          })
          .end(body);
      } catch {
        res
          .writeHead(503, { "Content-Type": "text/plain" })
          .end("Frontend build unavailable. Run npm run build:ui.");
      }
      return STREAMING;
    },
  ],
];
