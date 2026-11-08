import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { deflateRawSync } from "node:zlib";
import { createApp } from "../src/server/app.js";
import { MockCoverageAdapter } from "../src/server/coverage/mock.js";
import { readUpload, readZip, splitPlainText } from "../src/server/outline/extract.js";
import { toIdeaCards, type OutlineGenerator } from "../src/server/outline/generator.js";
import { MockOutlineGenerator } from "../src/server/outline/mock.js";
import { ClaudeOutlineGenerator } from "../src/server/outline/claude.js";
import { OpenAIOutlineGenerator } from "../src/server/outline/openai.js";
import { validateOutline } from "../src/server/session.js";
import { validateCard } from "../src/ui/model.js";

// ---- Fixture builders: a minimal zip writer (deflate) for .pptx/.docx ----

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8");
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const shape = (type: string | null, paras: string[]) =>
  `<p:sp><p:nvSpPr>${type ? `<p:nvPr><p:ph type="${type}"/></p:nvPr>` : ""}</p:nvSpPr><p:txBody>${paras
    .map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>`;
const slide = (title: string, body: string[]) => `<p:sld><p:cSld><p:spTree>${shape("title", [title])}${shape(null, body)}</p:spTree></p:cSld></p:sld>`;

function pptx() {
  return zip({
    // File numbering is deliberately out of presentation order.
    "ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/><Relationship Id="rId3" Target="slides/slide3.xml"/></Relationships>`,
    "ppt/slides/slide2.xml": slide("The blank moment", ["Speakers lose their place mid-pitch", "Even experts &amp; founders"]),
    "ppt/slides/slide1.xml": slide("Thread listens", ["Tracks ideas by meaning", "Whispers a 3-word cue"]),
    "ppt/slides/slide3.xml": slide("Try it today", ["Free for students"]),
    "ppt/slides/_rels/slide2.xml.rels": `<Relationships><Relationship Id="rId9" Target="../notesSlides/notesSlide7.xml"/></Relationships>`,
    "ppt/notesSlides/notesSlide7.xml": `<p:notes><p:cSld><p:spTree>${shape("body", ["Tell the demo-day story."])}${shape("sldNum", ["2"])}</p:spTree></p:cSld></p:notes>`,
  });
}

function docx() {
  const para = (text: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  return zip({
    "word/document.xml": `<w:document><w:body>${para("Problem", "Heading1")}${para("People freeze when they lose their place.")}${para("Solution", "Heading1")}${para("A quiet cue brings the idea back.")}</w:body></w:document>`,
  });
}

const b64 = (b: Buffer) => b.toString("base64");

// ---- Extraction ----

test("pptx: slides follow presentation order with titles, body, and speaker notes", () => {
  const doc = readUpload({ filename: "pitch.pptx", data: b64(pptx()) });
  assert.equal(doc.kind, "text");
  if (doc.kind !== "text") return;
  assert.equal(doc.format, "pptx");
  assert.deepEqual(
    doc.sections.map((s) => s.heading),
    ["The blank moment", "Thread listens", "Try it today"],
  );
  assert.deepEqual(doc.sections[0].lines, ["Speakers lose their place mid-pitch", "Even experts & founders"]);
  assert.equal(doc.sections[0].notes, "Tell the demo-day story.");
  assert.equal(doc.sections[1].notes, undefined);
  assert.match(doc.text, /## Slide 1: The blank moment[\s\S]*Speaker notes: Tell the demo-day story\./);
});

test("docx: headings start sections", () => {
  const doc = readUpload({ filename: "notes.docx", data: b64(docx()) });
  assert.ok(doc.kind === "text" && doc.format === "docx");
  assert.deepEqual(
    doc.sections.map((s) => [s.heading, s.lines]),
    [
      ["Problem", ["People freeze when they lose their place."]],
      ["Solution", ["A quiet cue brings the idea back."]],
    ],
  );
});

test("PDFs pass through by signature, regardless of extension", () => {
  const pdf = Buffer.from("%PDF-1.7\n...");
  const doc = readUpload({ filename: "deck.bin", data: b64(pdf) });
  assert.equal(doc.kind, "pdf");
});

test("plain text: markdown headings group bullets; bare bullets become ideas", () => {
  assert.deepEqual(
    splitPlainText("# Problem\n- people freeze\n- notes distract\n\n# Ask\nTry Thread"),
    [
      { heading: "Problem", lines: ["people freeze", "notes distract"] },
      { heading: "Ask", lines: ["Try Thread"] },
    ],
  );
  assert.equal(splitPlainText("- one idea\n- two idea\n- three idea").length, 3);
});

test("rejects unsupported, empty, and legacy binary formats with guidance", () => {
  assert.throws(() => readUpload({}), /Upload a \.pdf/);
  assert.throws(() => readUpload({ filename: "x.ppt", data: b64(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0xff, 0xfe])) }), /Save it as \.pptx/);
  assert.throws(() => readUpload({ filename: "x.zip", data: b64(zip({ "a.xml": "<a/>" })) }), /isn't a PowerPoint or Word/);
  assert.throws(() => readZip(Buffer.from("PK\u0003\u0004garbage")), /damaged/);
});

// ---- Generation ----

test("practice import turns slides into valid, approvable cards", async () => {
  const drafts = await new MockOutlineGenerator().generate(readUpload({ filename: "pitch.pptx", data: b64(pptx()) }));
  const cards = toIdeaCards(drafts);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].title, "The blank moment");
  assert.equal(cards[0].expandedCue, "Tell the demo-day story.");
  for (const card of cards) assert.equal(validateCard(card), "", card.cue);
  assert.doesNotThrow(() => validateOutline(cards));
});

test("practice import explains that PDFs need the AI provider", async () => {
  await assert.rejects(
    new MockOutlineGenerator().generate({ kind: "pdf", name: "d.pdf", base64: "" }),
    /can't read PDFs/,
  );
});

test("normalization keeps hints within 2–5 words and caps the outline at 7", () => {
  const cards = toIdeaCards(
    Array.from({ length: 9 }, (_, i) => ({
      title: `Point number ${i}`,
      meaning: "Something the speaker means.",
      cue: i === 0 ? "one two three four five six seven" : i === 1 ? "Solo" : "Fine short hint",
      expandedCue: "",
      mustMention: i === 0,
    })),
  );
  assert.equal(cards.length, 7);
  assert.equal(cards[0].cue, "one two three four five");
  assert.equal(cards[1].cue, "Point number 1");
  assert.equal(cards[1].expandedCue, "Something the speaker means.");
  assert.deepEqual(cards.map((c) => c.order), [0, 1, 2, 3, 4, 5, 6]);
  for (const card of cards) assert.equal(validateCard(card), "");
});

test("Claude generator sends PDFs as a document block and parses structured output", async () => {
  let sent: any;
  const fake = {
    beta: {
      messages: {
        create: async (params: any) => {
          sent = params;
          return {
            stop_reason: "end_turn",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ideas: [{ title: "Problem", meaning: "Speakers freeze.", cue: "That blank moment", expandedCue: "Everyone freezes sometimes.", mustMention: true }],
                }),
              },
            ],
          };
        },
      },
    },
  };
  const gen = new ClaudeOutlineGenerator("claude-opus-5-5", fake as any);
  const ideas = await gen.generate({ kind: "pdf", name: "d.pdf", base64: "JVBERi0=" });
  assert.equal(ideas[0].cue, "That blank moment");
  const content = sent.messages[0].content;
  assert.equal(content[0].type, "document");
  assert.equal(content[0].source.media_type, "application/pdf");
  assert.equal(sent.output_config.format.type, "json_schema");
});

test("Claude generator surfaces refusals instead of returning cards", async () => {
  const fake = { beta: { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } } };
  await assert.rejects(
    new ClaudeOutlineGenerator("claude-opus-5-5", fake as any).generate({ kind: "text", name: "n", format: "text", sections: [], text: "x" }),
    /declined/,
  );
});

// ---- HTTP ----

async function withServer(outline: OutlineGenerator | undefined, fn: (base: string) => Promise<void>) {
  const { server } = createApp({ adapter: () => new MockCoverageAdapter(), outline });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}
const post = (base: string, body: unknown) =>
  fetch(base + "/api/outline/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("POST /api/outline/generate drafts cards from an upload or pasted notes", async () => {
  await withServer(undefined, async (base) => {
    const health = await (await fetch(base + "/api/health")).json();
    assert.deepEqual(health.outline, { provider: "mock", simulated: true });

    const res = await post(base, { filename: "pitch.pptx", data: b64(pptx()) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.simulated, true);
    assert.deepEqual(data.source, { name: "pitch.pptx", kind: "pptx" });
    assert.equal(data.outline.length, 3);

    // The draft is a valid outline for a new session.
    const session = await (await fetch(base + "/api/sessions", { method: "POST", body: JSON.stringify({ outline: data.outline }) })).json();
    assert.equal(session.outline.length, 3);

    const pasted = await (await post(base, { text: "# Problem\nPeople freeze.\n\n# Solution\nA quiet cue." })).json();
    assert.deepEqual(pasted.outline.map((c: any) => c.title), ["Problem", "Solution"]);
  });
});

test("POST /api/outline/generate returns clear client errors", async () => {
  await withServer(undefined, async (base) => {
    const pdf = await post(base, { filename: "deck.pdf", data: b64(Buffer.from("%PDF-1.7")) });
    assert.equal(pdf.status, 422);
    assert.match((await pdf.json()).error, /can't read PDFs/);
    assert.equal((await post(base, {})).status, 400);
    const huge = await post(base, { filename: "big.txt", data: "A".repeat(15 * 1024 * 1024) });
    assert.equal(huge.status, 413);
  });
});

test("provider failures become a 502 without leaking details", async () => {
  const failing: OutlineGenerator = { name: "x", simulated: false, generate: async () => { throw new Error("secret upstream detail"); } };
  await withServer(failing, async (base) => {
    const res = await post(base, { text: "Some notes" });
    assert.equal(res.status, 502);
    assert.doesNotMatch((await res.json()).error, /secret/);
  });
});

// ---- OpenAI generator (fake fetch; the live API is exercised manually) ----

function fakeOpenAI(reply: { status?: number; body: unknown }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const openaiCards = {
  status: "completed",
  output: [
    { type: "reasoning", content: [] },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({
            ideas: [
              { title: "Fried noodles", meaning: "Instant noodles are fried in palm oil.", cue: "Fried in palm oil", expandedCue: "Instant noodles are flash fried in palm oil.", mustMention: true },
            ],
          }),
        },
      ],
    },
  ],
};

test("OpenAI generator sends PDFs as a file input with a strict schema and parses cards", async () => {
  const { calls, fetchImpl } = fakeOpenAI({ body: openaiCards });
  const gen = new OpenAIOutlineGenerator("gpt-test", "sk-test", fetchImpl);
  const ideas = await gen.generate({ kind: "pdf", name: "deck.pdf", base64: "JVBERi0=" });
  assert.equal(ideas[0].cue, "Fried in palm oil");
  const { url, headers, body } = calls[0];
  assert.equal(url, "https://api.openai.com/v1/responses");
  assert.equal(headers.Authorization, "Bearer sk-test");
  assert.equal(body.model, "gpt-test");
  assert.equal(body.store, false);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.input[0].content[0], { type: "input_file", filename: "deck.pdf", file_data: "data:application/pdf;base64,JVBERi0=" });
});

test("OpenAI generator sends extracted text for slides and docs", async () => {
  const { calls, fetchImpl } = fakeOpenAI({ body: openaiCards });
  await new OpenAIOutlineGenerator("m", "k", fetchImpl).generate({
    kind: "text", name: "n.txt", format: "text", sections: [], text: "Ramen is fried.",
  });
  const part = calls[0].body.input[0].content[0];
  assert.equal(part.type, "input_text");
  assert.match(part.text, /<material format="text">\nRamen is fried\.\n<\/material>/);
});

test("OpenAI generator surfaces refusals, truncation, and HTTP errors without the key", async () => {
  const refusal = fakeOpenAI({ body: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] } });
  await assert.rejects(new OpenAIOutlineGenerator("m", "k", refusal.fetchImpl).generate({ kind: "pdf", name: "a.pdf", base64: "x" }), /declined/);

  const cut = fakeOpenAI({ body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } });
  await assert.rejects(new OpenAIOutlineGenerator("m", "k", cut.fetchImpl).generate({ kind: "pdf", name: "a.pdf", base64: "x" }), /ran out of room/);

  const denied = fakeOpenAI({ status: 401, body: { error: { message: "Incorrect API key provided" } } });
  await assert.rejects(
    new OpenAIOutlineGenerator("m", "sk-secret", denied.fetchImpl).generate({ kind: "pdf", name: "a.pdf", base64: "x" }),
    (err: Error) => /OpenAI 401: Incorrect API key/.test(err.message) && !err.message.includes("sk-secret"),
  );
});
