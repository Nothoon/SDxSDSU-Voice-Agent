import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoverageUpdate } from "../src/shared/types.js";
import type { CoverageAdapter, CoverageRequest } from "../src/server/coverage/adapter.js";
import { OpenAICoverageAdapter } from "../src/server/coverage/openai.js";
import { demoOutline } from "../src/server/fixtures/outline.js";
import { Session } from "../src/server/session.js";
import { AutoHintScheduler } from "../src/voice/core/autohint.js";

const opts = { pauseMs: 3500, armSpeechMs: 1000, cooldownMs: 10_000, transcriptWaitMs: 2500 };

// Speak from `from` for `ms`, then fall silent.
function speak(s: AutoHintScheduler, from: number, ms: number) {
  s.speechStart(from);
  s.speechEnd(from + ms);
  return from + ms;
}

// Ticks every 200 ms over [from, to] and returns the times it fired.
function run(s: AutoHintScheduler, from: number, to: number, pending = () => false) {
  const fired: number[] = [];
  for (let t = from; t <= to; t += 200) if (s.tick(t, pending())) fired.push(t);
  return fired;
}

// ---- Scheduler timing (fake clock) ----

test("Auto Hint off: prolonged silence never triggers", () => {
  const s = new AutoHintScheduler(opts);
  const end = speak(s, 0, 3000);
  assert.deepEqual(run(s, end, end + 60_000), []);
  assert.equal(s.status(), "off");
});

test("enabled before first speech: silence alone never triggers", () => {
  const s = new AutoHintScheduler(opts);
  s.setEnabled(true);
  assert.equal(s.status(), "waiting");
  assert.deepEqual(run(s, 0, 30_000), []);
});

test("too little speech or a short pause does not trigger", () => {
  const s = new AutoHintScheduler(opts);
  s.setEnabled(true);
  let t = speak(s, 0, 600); // under the 1 s arming threshold
  assert.deepEqual(run(s, t, t + 8000), []);
  t = speak(s, t + 8000, 2000); // now armed
  assert.equal(s.status(), "armed");
  assert.deepEqual(run(s, t, t + 3000), [], "3 s pause is below the 3.5 s threshold");
});

test("sustained pause gives exactly one hint; continued silence does not repeat or advance", () => {
  const s = new AutoHintScheduler(opts);
  s.setEnabled(true);
  const t = speak(s, 0, 2000);
  const fired = run(s, t, t + 60_000);
  assert.equal(fired.length, 1);
  assert.ok(fired[0] >= t + 3500 && fired[0] < t + 3800);
  assert.equal(s.status(), "waiting", "needs new speech to rearm");
});

test("new speech plus cooldown allows one more hint; new speech inside the cooldown waits", () => {
  const s = new AutoHintScheduler(opts);
  s.setEnabled(true);
  let t = speak(s, 0, 2000);
  const [first] = run(s, t, t + 5000);
  t = speak(s, first + 200, 1500); // speaks again ~2 s after the first hint
  const second = run(s, t, t + 20_000);
  assert.equal(second.length, 1);
  assert.ok(second[0] - first >= 10_000, "respects the 10 s cooldown");
});

test("a pending transcript delays the hint; a transcript that never lands consumes the pause", () => {
  const s = new AutoHintScheduler(opts);
  s.setEnabled(true);
  let t = speak(s, 0, 2000);
  let pending = true;
  const early = run(s, t, t + 4000, () => pending);
  assert.deepEqual(early, []);
  pending = false;
  assert.equal(run(s, t + 4200, t + 5000).length, 1, "fires once the final transcript lands");

  t = speak(s, 20_000, 2000);
  assert.deepEqual(run(s, t, t + 30_000, () => true), [], "stuck transcript: no speculative hint");
  assert.equal(s.status(), "waiting");
});

test("a manual hint consumes the episode; Pause/Resume needs fresh speech", () => {
  const s = new AutoHintScheduler(opts);
  s.setEnabled(true);
  let t = speak(s, 0, 2000);
  s.delivered(); // speaker pressed Hint during the pause
  assert.deepEqual(run(s, t, t + 20_000), []);

  t = speak(s, 30_000, 2000);
  s.reset(); // Pause then Resume
  assert.deepEqual(run(s, t, t + 20_000), []);
  t = speak(s, t + 20_000, 2000);
  assert.equal(run(s, t, t + 5000).length, 1);
});

test("turning Auto Hint off and on again requires fresh speech", () => {
  const s = new AutoHintScheduler(opts);
  s.setEnabled(true);
  const t = speak(s, 0, 2000);
  s.setEnabled(false);
  s.setEnabled(true);
  assert.deepEqual(run(s, t, t + 20_000), []);
});

test("speaking resets the pause clock", () => {
  const s = new AutoHintScheduler(opts);
  s.setEnabled(true);
  let t = speak(s, 0, 2000);
  assert.deepEqual(run(s, t, t + 3000), []);
  t = speak(s, t + 3000, 500); // resumes before the threshold
  assert.deepEqual(run(s, t, t + 3000), []);
  assert.equal(run(s, t + 3200, t + 4000).length, 1);
});

// ---- Server gate for automatic cues ----

class Scripted implements CoverageAdapter {
  readonly name = "scripted";
  readonly simulated = false;
  constructor(private fn: (req: CoverageRequest) => CoverageUpdate[] | Promise<CoverageUpdate[]>) {}
  async evaluate(req: CoverageRequest) {
    return this.fn(req);
  }
}

function listening(adapter: CoverageAdapter, now?: () => number) {
  const s = new Session(adapter, now);
  s.setOutline(demoOutline, null);
  s.approve();
  s.start();
  s.setProviderStatus("stt", "connected"); // the voice controller reports this once transcription is up
  return s;
}
const seg = (id: string, text: string) => ({ id, text, startMs: 0, endMs: 1, isFinal: true });

test("automatic cue gives the approved hint, marks its source, and counts separately", async () => {
  const s = listening(new Scripted(() => []));
  s.selectCard("story");
  const cue = await s.requestAutoCue();
  assert.equal(cue.cardId, "story");
  assert.equal(cue.text, "Your pitch story");
  assert.equal(cue.source, "auto");
  const recap = s.recap();
  assert.equal(recap.autoHints, 1);
  assert.equal(recap.cueRequests, 0);
});

test("automatic cue waits for the latest speech to be evaluated", async () => {
  const s = listening(
    new Scripted(async (req) => {
      await new Promise((r) => setTimeout(r, 100));
      return req.segments.length ? [{ cardId: "problem", status: "covered", confidence: 0.9, evidenceSegmentIds: ["p1"] }] : [];
    }),
  );
  s.addSegments([seg("p1", "Speakers lose their place even when they know the material")]);
  const cue = await s.requestAutoCue();
  assert.equal(s.state().coverage.problem.status, "covered");
  assert.equal(cue.cardId, "story", "hint reflects the just-finished idea");
});

test("automatic cue is refused while tracking is unreliable or a provider is down", async () => {
  const failing = listening(new Scripted(() => Promise.reject(new Error("model down"))));
  failing.addSegments([seg("a", "hello there everyone")]);
  await failing.settled();
  assert.equal(failing.state().trackingStatus, "unavailable");
  await assert.rejects(failing.requestAutoCue(), /tracking is uncertain/);
  assert.equal(failing.requestCue("short").cardId, "problem", "manual hints still work");

  const uncertain = listening(new Scripted(() => [{ cardId: "nope", status: "covered", confidence: 1, evidenceSegmentIds: ["b"] }]));
  uncertain.addSegments([seg("b", "something")]);
  await uncertain.settled();
  await assert.rejects(uncertain.requestAutoCue(), /tracking is uncertain/);

  const sttDown = listening(new Scripted(() => []));
  sttDown.setProviderStatus("stt", "disconnected");
  await assert.rejects(sttDown.requestAutoCue(), /tracking is uncertain/);
});

test("automatic cue is refused when coverage never settles", async () => {
  const s = listening(new Scripted(() => new Promise(() => {})));
  s.addSegments([seg("c", "a thought in progress")]);
  await assert.rejects(s.requestAutoCue(), /catching up/);
});

test("server enforces the automatic cooldown and listening state", async () => {
  let t = 1_000_000;
  const s = listening(new Scripted(() => []), () => t);
  await s.requestAutoCue();
  t += 4000;
  await assert.rejects(s.requestAutoCue(), /at most every 10 seconds/);
  t += 7000;
  assert.equal((await s.requestAutoCue()).source, "auto");
  s.pause();
  t += 20_000;
  await assert.rejects(s.requestAutoCue(), /only while listening/);
});

// ---- OpenAI coverage adapter (fake fetch) ----

test("OpenAI coverage uses a strict schema, low effort, and maps null missingMeaning away", async () => {
  let sent: any;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    const updates = [
      { cardId: "problem", status: "covered", confidence: 0.9, evidenceSegmentIds: ["p1"], missingMeaning: null },
      { cardId: "story", status: "partial", confidence: 0.7, evidenceSegmentIds: ["p1"], missingMeaning: "the pitch itself" },
    ];
    return new Response(
      JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ updates }) }] }] }),
    );
  }) as typeof fetch;
  const adapter = new OpenAICoverageAdapter("gpt-test", "sk-test", "low", fetchImpl);
  const out = await adapter.evaluate({ outline: demoOutline, segments: [seg("p1", "hi")], current: {}, transcriptRevision: 1 });
  assert.equal(out[0].missingMeaning, undefined);
  assert.equal(out[1].missingMeaning, "the pitch itself");
  assert.equal(sent.reasoning.effort, "low");
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  const item = sent.text.format.schema.properties.updates.items;
  assert.deepEqual([...item.required].sort(), ["cardId", "confidence", "evidenceSegmentIds", "missingMeaning", "status"]);
  assert.match(sent.input[0].content[0].text, /<speaker_transcript>/);
});
