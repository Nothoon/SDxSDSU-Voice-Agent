import { inflateRawSync } from "node:zlib";

// Turns an uploaded deck or document into something the outline generator can read.
// PDFs pass through as-is (the Claude generator reads them natively). PPTX and DOCX
// are zip archives of XML, read with a minimal zip reader so no dependency is needed.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 40 * 1024 * 1024; // zip-bomb guard across all entries
const MAX_TEXT_CHARS = 200_000; // ~50k tokens of slide/doc text is plenty for an outline

export type SourceSection = { heading: string; lines: string[]; notes?: string };

export type SourceDocument =
  | { kind: "pdf"; name: string; base64: string }
  | { kind: "text"; name: string; format: "pptx" | "docx" | "text"; sections: SourceSection[]; text: string };

export class ExtractError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 422 = 422,
  ) {
    super(message);
  }
}

const SUPPORTED = "Upload a .pdf, .pptx, .docx, .txt, or .md file, or paste your notes.";

export function readUpload(input: { filename?: unknown; data?: unknown; text?: unknown }): SourceDocument {
  if (typeof input.text === "string" && input.text.trim()) {
    const text = input.text.slice(0, MAX_TEXT_CHARS);
    return fromSections("Pasted notes", "text", splitPlainText(text));
  }
  if (typeof input.data !== "string" || !input.data) throw new ExtractError(SUPPORTED, 400);
  const name = typeof input.filename === "string" && input.filename.trim() ? input.filename.trim().slice(0, 200) : "upload";
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.length === 0) throw new ExtractError("That file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new ExtractError("Keep uploads under 10 MB.", 413);

  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  // Trust content signatures over the extension where they exist.
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", name, base64: bytes.toString("base64") };
  if (bytes.readUInt32LE(0) === 0x04034b50) {
    const zip = readZip(bytes);
    if ([...zip.keys()].some((k) => k.startsWith("ppt/slides/"))) return fromSections(name, "pptx", pptxSections(zip));
    if (zip.has("word/document.xml")) return fromSections(name, "docx", docxSections(zip));
    throw new ExtractError(`That archive isn't a PowerPoint or Word file. ${SUPPORTED}`);
  }
  if (["txt", "md", "markdown", "text"].includes(ext) || isProbablyText(bytes)) {
    return fromSections(name, "text", splitPlainText(bytes.toString("utf8").slice(0, MAX_TEXT_CHARS)));
  }
  if (["ppt", "doc", "key", "pages"].includes(ext)) {
    throw new ExtractError(`Save it as .pptx, .docx, or PDF first. ${SUPPORTED}`);
  }
  throw new ExtractError(SUPPORTED);
}

function fromSections(name: string, format: "pptx" | "docx" | "text", sections: SourceSection[]): SourceDocument {
  const kept = sections.filter((s) => s.heading || s.lines.length || s.notes);
  const label = format === "pptx" ? "Slide" : "Section";
  let text = kept
    .map((s, i) =>
      [
        `## ${label} ${i + 1}${s.heading ? `: ${s.heading}` : ""}`,
        ...s.lines,
        ...(s.notes ? [`Speaker notes: ${s.notes}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
  if (!text.trim()) throw new ExtractError("No readable text was found. If the slides are images, export them as a PDF.");
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
  return { kind: "text", name, format, sections: kept, text };
}

// ---- Plain text ----

function isProbablyText(bytes: Buffer) {
  const sample = bytes.subarray(0, 4096);
  return !sample.includes(0) && !sample.toString("utf8").includes("�");
}

export function splitPlainText(text: string): SourceSection[] {
  const sections: SourceSection[] = [];
  let current: SourceSection | null = null;
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const heading = lines[0].match(/^#{1,6}\s+(.*)$/)?.[1];
    if (heading !== undefined) {
      current = { heading: heading.trim(), lines: lines.slice(1).map(stripBullet) };
      sections.push(current);
    } else if (current && lines.every((l) => /^([-*•]|\d+[.)])\s/.test(l))) {
      // A bullet list belongs to the heading above it.
      current.lines.push(...lines.map(stripBullet));
    } else {
      current = null;
      // A standalone bullet list: each bullet is its own idea.
      if (lines.length > 1 && lines.every((l) => /^([-*•]|\d+[.)])\s/.test(l))) {
        for (const l of lines) sections.push({ heading: "", lines: [stripBullet(l)] });
      } else sections.push({ heading: "", lines: [lines.join(" ")] });
    }
  }
  return sections;
}

const stripBullet = (l: string) => l.replace(/^([-*•]|\d+[.)])\s+/, "");

// ---- Office XML ----

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

// Paragraph texts from DrawingML (a:p/a:t) or WordprocessingML (w:p/w:t).
function paragraphs(xml: string, ns: "a" | "w") {
  const out: string[] = [];
  for (const p of xml.match(new RegExp(`<${ns}:p[\\s>][\\s\\S]*?</${ns}:p>`, "g")) ?? []) {
    const text = [...p.matchAll(new RegExp(`<${ns}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:t>`, "g"))]
      .map((m) => decodeXml(m[1]))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) out.push(text);
  }
  return out;
}

function pptxSections(zip: Map<string, Buffer>): SourceSection[] {
  const slideNumber = (k: string) => Number(k.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
  const slides = [...zip.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => slideNumber(a) - slideNumber(b));
  const order = presentationOrder(zip);
  if (order.length) slides.sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));

  return slides.map((path) => {
    const xml = zip.get(path)!.toString("utf8");
    // Prefer the title placeholder's text as the heading.
    const shapes = xml.match(/<p:sp[\s>][\s\S]*?<\/p:sp>/g) ?? [];
    const titleShape = shapes.find((s) => /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(s));
    const heading = titleShape ? paragraphs(titleShape, "a").join(" ") : "";
    const body = shapes.filter((s) => s !== titleShape).flatMap((s) => paragraphs(s, "a"));
    const all = shapes.length ? body : paragraphs(xml, "a");

    const rels = zip.get(path.replace("slides/", "slides/_rels/") + ".rels")?.toString("utf8") ?? "";
    const notesTarget = rels.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)?.[1];
    const notesXml = notesTarget ? zip.get(`ppt/notesSlides/${notesTarget}`)?.toString("utf8") : undefined;
    // Notes slides include the slide-number placeholder; keep only body text.
    const notes = notesXml
      ? (notesXml.match(/<p:sp[\s>][\s\S]*?<\/p:sp>/g) ?? [])
          .filter((s) => /<p:ph[^>]*type="body"/.test(s))
          .flatMap((s) => paragraphs(s, "a"))
          .join(" ")
      : "";
    return { heading, lines: all, notes: notes || undefined };
  });
}

// Slide order as listed in presentation.xml (file numbering can differ after reordering).
function presentationOrder(zip: Map<string, Buffer>): string[] {
  const pres = zip.get("ppt/presentation.xml")?.toString("utf8");
  const rels = zip.get("ppt/_rels/presentation.xml.rels")?.toString("utf8");
  if (!pres || !rels) return [];
  const targets = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*>/g)].flatMap((m) => {
      const id = m[0].match(/\bId="([^"]+)"/)?.[1];
      const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
      return id && target ? [[id, "ppt/" + target.replace(/^\/?ppt\//, "")]] : [];
    }),
  );
  return [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => targets.get(m[1]) ?? "").filter(Boolean);
}

function docxSections(zip: Map<string, Buffer>): SourceSection[] {
  const xml = zip.get("word/document.xml")!.toString("utf8");
  const sections: SourceSection[] = [];
  let current: SourceSection = { heading: "", lines: [] };
  for (const p of xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []) {
    const text = paragraphs(p, "w").join(" ");
    if (!text) continue;
    const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? "";
    if (/^(Heading[1-3]|Title)$/i.test(style)) {
      if (current.heading || current.lines.length) sections.push(current);
      current = { heading: text, lines: [] };
    } else current.lines.push(text);
  }
  if (current.heading || current.lines.length) sections.push(current);
  // A document with no headings: let paragraphs stand as sections.
  if (sections.length === 1 && !sections[0].heading) return sections[0].lines.map((l) => ({ heading: "", lines: [l] }));
  return sections;
}

// ---- Minimal zip reader (stored + deflate) ----

export function readZip(buf: Buffer): Map<string, Buffer> {
  const eocdMin = 22;
  let eocd = -1;
  for (let i = buf.length - eocdMin; i >= Math.max(0, buf.length - eocdMin - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ExtractError("That file looks damaged and couldn't be opened.");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  let total = 0;
  try {
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(offset) !== 0x02014b50) break;
      const method = buf.readUInt16LE(offset + 10);
      const compressed = buf.readUInt32LE(offset + 20);
      const size = buf.readUInt32LE(offset + 24);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const local = buf.readUInt32LE(offset + 42);
      const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
      offset += 46 + nameLen + extraLen + commentLen;
      // Only the XML parts we read; skip media to save work.
      if (!/\.(xml|rels)$/.test(name)) continue;
      total += size;
      if (total > MAX_EXTRACTED_BYTES) throw new ExtractError("That file expands to too much data to read.", 413);
      if (buf.readUInt32LE(local) !== 0x04034b50) continue;
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compressed);
      if (method === 0) entries.set(name, data);
      else if (method === 8) entries.set(name, inflateRawSync(data, { maxOutputLength: Math.max(size, 1) }));
    }
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError("That file looks damaged and couldn't be opened.");
  }
  return entries;
}
