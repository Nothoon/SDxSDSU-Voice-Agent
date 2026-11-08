import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/server/app.js";
import { MockCoverageAdapter } from "../src/server/coverage/mock.js";
import { focusAfterCoverage, nextIdea, validateCard, canShortcut } from "../src/ui/model.js";
import { Session } from "../src/server/session.js";
import { demoOutline } from "../src/server/fixtures/outline.js";

function session() {
  const s = new Session(new MockCoverageAdapter());
  s.setOutline(demoOutline);
  s.approve();
  s.start();
  return s;
}
test("focus advances on the coverage result even without a new transcript revision", async () => {
  const s = session();
  s.addSegments([{
    id: "speech-1", text: demoOutline[0].meaning,
    startMs: 0, endMs: 1000, isFinal: true,
  }]);
  const pending = structuredClone(s.state());
  assert.equal(pending.coverage[demoOutline[0].id].status, "uncovered");
  await s.settled();
  const covered = s.state();
  assert.equal(covered.transcriptRevision, pending.transcriptRevision);
  assert.equal(covered.coverage[demoOutline[0].id].status, "covered");
  assert.equal(focusAfterCoverage(pending, covered, demoOutline[0].id), demoOutline[1].id);
});
test("automatic advancement skips covered ideas in approved order", () => {
  const s = session();
  s.setCoverage(demoOutline[1].id, "covered");
  const before = structuredClone(s.state());
  s.setCoverage(demoOutline[0].id, "covered");
  const after = s.state();
  after.outline = [...after.outline].reverse();
  assert.equal(focusAfterCoverage(before, after, demoOutline[0].id), demoOutline[2].id);
});
test("partial and unrelated coverage preserve the current idea", () => {
  const s = session();
  const before = structuredClone(s.state());
  s.setCoverage(demoOutline[0].id, "partial");
  s.setCoverage(demoOutline[1].id, "covered");
  assert.equal(focusAfterCoverage(before, s.state(), demoOutline[0].id), demoOutline[0].id);
});
test("automatic advancement returns to earlier missed ideas at the end", () => {
  const s = session();
  const before = structuredClone(s.state());
  const last = demoOutline.at(-1)!.id;
  s.setCoverage(last, "covered");
  assert.equal(focusAfterCoverage(before, s.state(), last), demoOutline[0].id);
});
test("finishing all ideas clears focus while explicit revisits remain possible", () => {
  const s = session();
  for (const card of demoOutline.slice(0, -1)) s.setCoverage(card.id, "covered");
  const before = structuredClone(s.state());
  const last = demoOutline.at(-1)!.id;
  s.setCoverage(last, "covered");
  assert.equal(focusAfterCoverage(before, s.state(), last), null);
  const completed = structuredClone(s.state());
  s.selectCard(demoOutline[0].id);
  assert.equal(focusAfterCoverage(completed, s.state(), demoOutline[0].id), demoOutline[0].id);
});
test("Next skips covered later cards and never marks the previous card covered", () => {
  const s = session();
  s.setCoverage(demoOutline[1].id, "covered");
  const before = s.state();
  const next = nextIdea(before, demoOutline[0].id);
  assert.equal(next.card?.id, demoOutline[2].id);
  assert.equal(s.state().coverage[demoOutline[0].id].status, "uncovered");
});
test("Next does not wrap to earlier missed ideas or claim completion", () => {
  const s = session();
  const result = nextIdea(s.state(), demoOutline.at(-1)!.id);
  assert.equal(result.card, null);
  assert.match(result.message, /earlier ideas remain/);
  for (const card of demoOutline) s.setCoverage(card.id, "covered");
  assert.equal(
    nextIdea(s.state(), demoOutline.at(-1)!.id).message,
    "All points covered.",
  );
});
test("partial later ideas remain eligible and expanded hints keep server identity", () => {
  const s = session();
  s.setCoverage(demoOutline[1].id, "partial");
  const next = nextIdea(s.state(), demoOutline[0].id);
  s.selectCard(next.card!.id);
  const short = s.requestCue("short");
  const more = s.requestCue("expanded");
  assert.equal(short.cardId, more.cardId);
  assert.equal(more.text, demoOutline[1].expandedCue);
});
test("card validation accepts approved text and rejects empty/oversized hints", () => {
  assert.equal(validateCard(demoOutline[0]), "");
  assert.match(
    validateCard({ ...demoOutline[0], meaning: "  " }),
    /each field/,
  );
  assert.match(
    validateCard({ ...demoOutline[0], cue: "one two three four five six" }),
    /2–5/,
  );
});
test("shortcuts exclude editing, repeated keys and modifier combinations", () => {
  const event = {
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };
  assert.equal(canShortcut(event, false), true);
  assert.equal(canShortcut(event, true), false);
  for (const key of Object.keys(event))
    assert.equal(canShortcut({ ...event, [key]: true }, false), false);
});
test("product frontend and API are served together without replacing the voice harness", async () => {
  const { server } = createApp({ adapter: () => new MockCoverageAdapter() });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const [path, pattern] of [
      ["/", /Thread — Keep your flow/],
      ["/ui/styles.css", /speaking-grid/],
      ["/voice-demo/", /html/i],
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.match(await res.text(), pattern as RegExp);
    }
    assert.equal((await fetch(base + "/api/health")).status, 200);
    assert.equal((await fetch(base + "/ui/../../.env")).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
