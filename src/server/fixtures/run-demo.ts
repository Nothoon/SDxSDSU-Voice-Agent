// Drives a running backend through the demo flow with transcript fixtures.
// Usage: npm run demo:fixtures [-- http://localhost:3000]

import { demoOutline, transcripts } from "./outline.js";

const base = process.argv[2] ?? process.env.THREAD_URL ?? "http://localhost:3000";

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const session = await call("POST", "/api/sessions", { outline: demoOutline, targetDurationSec: 180 });
const id = session.id;
console.log(`session ${id}`);
await call("POST", `/api/sessions/${id}/approve`);
await call("POST", `/api/sessions/${id}/start`);

for (const segment of transcripts.reordered) {
  await call("POST", `/api/sessions/${id}/segments`, { segment });
  console.log(`said: "${segment.text}"`);
}
// Coverage runs asynchronously; give the provider a moment.
await wait(process.env.COVERAGE_WAIT_MS ? Number(process.env.COVERAGE_WAIT_MS) : 500);

const state = await call("GET", `/api/sessions/${id}`);
for (const card of demoOutline) {
  const c = state.coverage[card.id];
  console.log(`  ${card.title.padEnd(15)} ${c.status.padEnd(9)} evidence=${c.evidenceSegmentIds.join(",") || "-"}`);
}
console.log(`tracking: ${state.trackingStatus}`);

const cue = await call("POST", `/api/sessions/${id}/cue`, { level: "short" });
console.log(`Cue  → [${cue.cardId}] "${cue.text}"`);
const more = await call("POST", `/api/sessions/${id}/cue`, { level: "expanded" });
console.log(`More → [${more.cardId}] "${more.text}"`);

await call("POST", `/api/sessions/${id}/end`);
console.log("recap:", await call("GET", `/api/sessions/${id}/recap`));
