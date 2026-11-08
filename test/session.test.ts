import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoverageUpdate } from "../src/shared/types.js";
import type { CoverageAdapter, CoverageRequest } from "../src/server/coverage/adapter.js";
import { demoOutline, transcripts } from "../src/server/fixtures/outline.js";
import { Session } from "../src/server/session.js";

// Scripted adapter: stands in for the semantic model so tests check the backend's
// tracking rules deterministically. Model quality is evaluated separately.
class ScriptedAdapter implements CoverageAdapter {
  readonly name = "scripted";
  readonly simulated = true;
  calls: CoverageRequest[] = [];
  constructor(private script: (req: CoverageRequest) => CoverageUpdate[] | Promise<CoverageUpdate[]>) {}
  async evaluate(req: CoverageRequest) {
    this.calls.push(req);
    return this.script(req);
  }
}

const covered = (cardId: string, ids: string[], confidence = 0.9): CoverageUpdate => ({
  cardId,
  status: "covered",
  confidence,
  evidenceSegmentIds: ids,
});

function startedSession(adapter: CoverageAdapter, targetDurationSec: number | null = null, now?: () => number) {
  const s = new Session(adapter, now);
  s.setOutline(demoOutline, targetDurationSec);
  s.approve();
  s.start();
  return s;
}

test("paraphrased problem becomes covered with evidence", async () => {
  const s = startedSession(new ScriptedAdapter(() => [covered("problem", ["p1", "p2"])]));
  s.addSegments(transcripts.paraphrasedProblem);
  await s.settled();
  const c = s.state().coverage.problem;
  assert.equal(c.status, "covered");
  assert.deepEqual(c.evidenceSegmentIds, ["p1", "p2"]);
  assert.equal(s.requestCue("short").cardId, "story");
});

test("keyword-only mention is not full coverage; low-confidence covered is held at partial", async () => {
  const s = startedSession(new ScriptedAdapter(() => [covered("problem", ["k1"], 0.3)]));
  s.addSegments(transcripts.keywordOnly);
  await s.settled();
  assert.equal(s.state().coverage.problem.status, "partial");
});

test("coverage without valid evidence or for unknown cards is rejected", async () => {
  const s = startedSession(
    new ScriptedAdapter(() => [covered("problem", ["not-a-segment"]), covered("bogus", ["p1"])]),
  );
  s.addSegments(transcripts.paraphrasedProblem);
  await s.settled();
  assert.equal(s.state().coverage.problem.status, "uncovered");
  assert.equal(s.state().trackingStatus, "uncertain");
});

test("point covered early stays covered and is skipped", async () => {
  const s = startedSession(new ScriptedAdapter(() => [covered("problem", ["r1"]), covered("demo", ["r2"])]));
  s.addSegments(transcripts.reordered);
  await s.settled();
  assert.equal(s.requestCue("short").cardId, "story");
  s.selectCard("story");
  s.setCoverage("story", "covered");
  s.setCoverage("solution", "covered");
  s.selectCard(null);
  // demo was covered early, so the next cue skips it.
  assert.equal(s.requestCue("short").cardId, "closing");
});

test("cue helps finish a partial idea the speaker is in the middle of", async () => {
  const s = startedSession(
    new ScriptedAdapter(() => [
      { cardId: "story", status: "partial", confidence: 0.7, evidenceSegmentIds: ["h1"], missingMeaning: "what happened" },
    ]),
  );
  s.addSegments(transcripts.halfwayStory);
  await s.settled();
  const cue = s.requestCue("short");
  assert.equal(cue.cardId, "story");
  assert.equal(cue.text, "Your pitch story"); // Approved text, not model text
});

test("More expands the same idea and does not advance", async () => {
  const s = startedSession(new ScriptedAdapter(() => []));
  const short = s.requestCue("short");
  const more = s.requestCue("expanded");
  assert.equal(more.cardId, short.cardId);
  assert.equal(more.level, "expanded");
  assert.equal(more.text, demoOutline[0].expandedCue);
});

test("rapid Cue presses reuse the current cue with increasing revisions", async () => {
  const s = startedSession(new ScriptedAdapter(() => []));
  const a = s.requestCue("short");
  const b = s.requestCue("short");
  assert.equal(a.cardId, b.cardId);
  assert.notEqual(a.requestId, b.requestId);
  assert.ok(b.stateRevision > a.stateRevision);
});

test("a late model response cannot overwrite newer coverage", async () => {
  const s = startedSession(new ScriptedAdapter(() => []));
  s.addSegments(transcripts.paraphrasedProblem);
  await s.settled();
  const newer = s.state().transcriptRevision;
  s.applyCoverage([covered("problem", ["p1"])], newer + 1);
  assert.deepEqual(s.applyCoverage([covered("story", ["p2"])], newer), []);
  assert.equal(s.state().coverage.story.status, "uncovered");
});

test("coverage never moves backward and respects manual correction", async () => {
  let call = 0;
  const s = startedSession(
    new ScriptedAdapter(() =>
      call++ === 0 ? [covered("problem", ["p1"])] : [{ cardId: "problem", status: "uncovered", confidence: 0.9, evidenceSegmentIds: [] }],
    ),
  );
  s.addSegments([transcripts.paraphrasedProblem[0]]);
  await s.settled();
  s.addSegments([transcripts.paraphrasedProblem[1]]);
  await s.settled();
  assert.equal(s.state().coverage.problem.status, "covered");
  s.setCoverage("problem", "uncovered");
  assert.equal(s.state().coverage.problem.manual, true);
});

test("coverage provider failure keeps last coverage and marks tracking unavailable", async () => {
  let fail = false;
  const s = startedSession(
    new ScriptedAdapter(() => {
      if (fail) throw new Error("disconnected");
      return [covered("problem", ["p1"])];
    }),
  );
  s.addSegments([transcripts.paraphrasedProblem[0]]);
  await s.settled();
  fail = true;
  s.addSegments([transcripts.paraphrasedProblem[1]]);
  await s.settled();
  const st = s.state();
  assert.equal(st.trackingStatus, "unavailable");
  assert.equal(st.coverage.problem.status, "covered");
  // Manual cueing still works from the last reliable state.
  assert.equal(s.requestCue("short").text, "Your pitch story");
});

test("every point covered gives a completion state with no card", async () => {
  const s = startedSession(new ScriptedAdapter(() => []));
  for (const c of demoOutline) s.setCoverage(c.id, "covered");
  assert.equal(s.state().allCovered, true);
  const cue = s.requestCue("short");
  assert.equal(cue.cardId, null);
  assert.equal(cue.text, "All points covered.");
});

test("final 20% of target duration prioritizes uncovered must-mention ideas", async () => {
  let t = 0;
  const s = startedSession(new ScriptedAdapter(() => []), 100, () => t);
  s.setCoverage("problem", "covered");
  t = 85_000;
  assert.equal(s.requestCue("short").cardId, "solution"); // story is not must-mention
});

test("partial transcripts and duplicate segments never change coverage", async () => {
  const adapter = new ScriptedAdapter(() => [covered("problem", ["p1"])]);
  const s = startedSession(adapter);
  s.addSegments([{ ...transcripts.paraphrasedProblem[0], isFinal: false }]);
  await s.settled();
  assert.equal(adapter.calls.length, 0);
  s.addSegments([transcripts.paraphrasedProblem[0]]);
  const dup = s.addSegments([transcripts.paraphrasedProblem[0]]);
  await s.settled();
  assert.equal(dup.accepted, 0);
  assert.equal(adapter.calls.length, 1);
});

test("Pause suspends tracking and cues; End clears buffers and keeps the recap", async () => {
  const adapter = new ScriptedAdapter(() => [covered("problem", ["p1"])]);
  const s = startedSession(adapter);
  s.addSegments([transcripts.paraphrasedProblem[0]]);
  await s.settled();
  s.pause();
  assert.equal(s.addSegments([transcripts.paraphrasedProblem[1]]).accepted, 0);
  assert.throws(() => s.requestCue("short"));
  s.resume();
  s.requestCue("short");
  s.end();
  assert.equal(s.transcript().length, 0);
  const recap = s.recap();
  assert.deepEqual(recap.covered, ["problem"]);
  assert.deepEqual(recap.missedMustMention, ["solution", "demo", "closing"]);
  assert.equal(recap.cueRequests, 1);
});
