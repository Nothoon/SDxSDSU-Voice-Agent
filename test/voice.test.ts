import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/server/app.js";
import { MockCoverageAdapter } from "../src/server/coverage/mock.js";
import { demoOutline } from "../src/server/fixtures/outline.js";
import { MockVoiceProvider } from "../src/server/voice/mock.js";
import type { TranscriptSegment } from "../src/shared/types.js";
import { stripEcho } from "../src/voice/core/echo.js";
import { TranscriptNormalizer } from "../src/voice/core/transcript.js";
import { EnergyVad } from "../src/voice/core/vad.js";

const seg = (text: string, startMs: number, endMs: number): TranscriptSegment => ({
  id: "s1",
  text,
  startMs,
  endMs,
  isFinal: true,
});

// ---- Transcript normalization ----

test("partial and committed transcripts for one utterance share a stable id", () => {
  let t = 1000;
  const n = new TranscriptNormalizer("run-0", () => t);
  const p1 = n.handle({ message_type: "partial_transcript", text: "speakers lose" })!;
  t = 1400;
  const p2 = n.handle({ message_type: "partial_transcript", text: "speakers lose their place" })!;
  t = 2000;
  const f = n.handle({ message_type: "committed_transcript", text: "Speakers lose their place." })!;
  assert.equal(p1.id, "run-0-0");
  assert.equal(p2.id, p1.id);
  assert.deepEqual(f, { id: "run-0-0", text: "Speakers lose their place.", startMs: 1000, endMs: 2000, isFinal: true });
  t = 3000;
  const next = n.handle({ message_type: "partial_transcript", text: "then" })!;
  assert.equal(next.id, "run-0-1");
  assert.equal(next.isFinal, false);
});

test("empty commits, session and unknown messages produce no segment", () => {
  const n = new TranscriptNormalizer("r", () => 0);
  assert.equal(n.handle({ message_type: "session_started", session_id: "x" }), null);
  assert.equal(n.handle({ message_type: "committed_transcript", text: "  " }), null);
  assert.equal(n.handle({ message_type: "committed_transcript_with_timestamps", text: "dup" }), null);
  assert.equal(n.handle({ message_type: "partial_transcript", text: "a" })!.id, "r-1");
});

// ---- Echo exclusion ----

const cue = { startMs: 1000, endMs: 2000, text: "Your pitch story" };

test("cue audio picked up by the mic is not speaker evidence", () => {
  assert.equal(stripEcho(seg("your pitch story", 1200, 2100), [cue]), null);
});

test("speaker interruption during a cue is kept", () => {
  const s = seg("so last year I froze on stage", 1500, 3000);
  assert.deepEqual(stripEcho(s, [cue]), s);
});

test("echoed cue prefix is removed and the speaker's words kept", () => {
  const out = stripEcho(seg("Your pitch story. Right, last year I froze", 1100, 3500), [cue]);
  assert.equal(out?.text, "Right, last year I froze");
});

test("the same words outside any playback window are kept", () => {
  const s = seg("your pitch story", 9000, 10000);
  assert.deepEqual(stripEcho(s, [cue]), s);
});

// ---- Speaker activity ----

test("VAD declares speech after sustained energy and a gap after hangover", () => {
  const vad = new EnergyVad({ minSpeechMs: 100, hangoverMs: 300, ratio: 3, minRms: 0.01 });
  for (let t = 0; t < 500; t += 50) assert.equal(vad.update(0.003, t), null);
  assert.equal(vad.update(0.2, 500), null);
  assert.equal(vad.update(0.2, 550), null);
  assert.equal(vad.update(0.2, 600), "start");
  assert.equal(vad.onsetMs, 500);
  assert.equal(vad.update(0.002, 650), null); // brief dip is not a gap
  assert.equal(vad.update(0.2, 700), null);
  for (let t = 750; t < 1050; t += 50) assert.equal(vad.update(0.002, t), null);
  assert.equal(vad.update(0.002, 1050), "end");
});

test("boosted threshold during playback ignores moderate echo but not the speaker", () => {
  const vad = new EnergyVad({ minSpeechMs: 100, hangoverMs: 300, ratio: 3, minRms: 0.02 });
  vad.boost = 2;
  for (let t = 0; t <= 400; t += 50) assert.equal(vad.update(0.03, t), null);
  let started = false;
  for (let t = 450; t <= 600; t += 50) started ||= vad.update(0.2, t) === "start";
  assert.ok(started);
});

// ---- Server voice routes (mock provider) ----

async function withServer(fn: (base: string, voice: MockVoiceProvider) => Promise<void>) {
  const voice = new MockVoiceProvider();
  const { server } = createApp({ adapter: () => new MockCoverageAdapter(), voice });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, voice);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("cue audio is served only for approved card text and is cached", async () => {
  await withServer(async (base, voice) => {
    const session = await (await post(`${base}/api/sessions`, { outline: demoOutline })).json();
    const url = `${base}/api/sessions/${session.id}/voice/cue-audio?cardId=story&level=short`;

    assert.equal((await fetch(url)).status, 409, "draft outline is not approved");
    await post(`${base}/api/sessions/${session.id}/approve`);

    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/wav");
    assert.equal(res.headers.get("x-thread-simulated"), "true");
    assert.ok((await res.arrayBuffer()).byteLength > 44);
    await fetch(url);
    assert.equal(voice.synthesizeCalls, 1, "second request is served from cache");

    assert.equal((await fetch(url.replace("story", "nope"))).status, 404);
    assert.equal((await fetch(url.replace("level=short", "level=loud"))).status, 400);

    const state = await (await fetch(`${base}/api/sessions/${session.id}`)).json();
    assert.equal(state.providers.tts, "degraded", "simulated TTS is never reported as connected");
  });
});

test("editing a card's cue text produces new audio", async () => {
  await withServer(async (base, voice) => {
    const s = await (await post(`${base}/api/sessions`, { outline: demoOutline })).json();
    await post(`${base}/api/sessions/${s.id}/approve`);
    const url = `${base}/api/sessions/${s.id}/voice/cue-audio?cardId=story&level=short`;
    await fetch(url);
    const edited = demoOutline.map((c) => (c.id === "story" ? { ...c, cue: "The demo day story" } : c));
    await fetch(`${base}/api/sessions/${s.id}/outline`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outline: edited }),
    });
    await post(`${base}/api/sessions/${s.id}/approve`);
    await fetch(url);
    assert.equal(voice.synthesizeCalls, 2);
  });
});

test("prepare synthesizes every approved cue; STT token needs a live provider", async () => {
  await withServer(async (base) => {
    const s = await (await post(`${base}/api/sessions`, { outline: demoOutline })).json();
    assert.equal((await post(`${base}/api/sessions/${s.id}/voice/stt-token`)).status, 409, "not approved yet");
    await post(`${base}/api/sessions/${s.id}/approve`);
    const prep = await (await post(`${base}/api/sessions/${s.id}/voice/prepare`)).json();
    assert.deepEqual(prep, { prepared: demoOutline.length * 3, failed: [], simulated: true });

    const token = await post(`${base}/api/sessions/${s.id}/voice/stt-token`);
    assert.equal(token.status, 503);
    assert.match((await token.json()).error, /ELEVENLABS_API_KEY/);

    const health = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual(health.voice, { provider: "mock", simulated: true, stt: false });
  });
});

test("next-idea announcements speak the approved card title", async () => {
  await withServer(async (base, voice) => {
    const s = await (await post(`${base}/api/sessions`, { outline: demoOutline })).json();
    await post(`${base}/api/sessions/${s.id}/approve`);
    const res = await fetch(`${base}/api/sessions/${s.id}/voice/cue-audio?cardId=story&level=title`);
    assert.equal(res.status, 200);
    assert.equal(voice.synthesizeCalls, 1);
    // Same text through the prepare path is a cache hit, so it was synthesized from card.title.
    const synthesized: string[] = [];
    const original = voice.synthesize.bind(voice);
    voice.synthesize = async (text: string) => (synthesized.push(text), original(text));
    await post(`${base}/api/sessions/${s.id}/voice/prepare`);
    assert.ok(!synthesized.includes("Personal story"), "title audio was already cached from card.title");
    assert.ok(synthesized.includes("Problem"));
  });
});
