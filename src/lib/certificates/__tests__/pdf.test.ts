// @vitest-environment node
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { decodePDFRawStream } from "pdf-lib/cjs/core/streams/decode";
import { describe, expect, it } from "vitest";
import { renderCertificatePdf } from "../pdf";

function contentStreams(document: PDFDocument) {
  return document.context.enumerateIndirectObjects()
    .filter((entry): entry is [typeof entry[0], PDFRawStream] => entry[1] instanceof PDFRawStream)
    .map(([, stream]) => Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1"));
}

/** Read text from the PDF's actual content operators and Unicode mappings. */
function extractText(document: PDFDocument): string {
  const streams = contentStreams(document);
  const mappings = new Map<string, string>();
  const unicode = (hex: string) => Buffer.from(hex, "hex").swap16().toString("utf16le");
  for (const stream of streams.filter((value) => value.includes("begincmap"))) {
    for (const block of stream.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([A-Fa-f0-9]+)>\s*<([A-Fa-f0-9]+)>/g)) mappings.set(pair[1].toUpperCase(), unicode(pair[2]));
    }
  }
  return streams.filter((value) => /\bBT\b/.test(value)).map((stream) => {
    // ActualText preserves logical order when Indic shaping reorders glyphs.
    const logical = [...stream.matchAll(/\/ActualText\s*<FEFF([A-Fa-f0-9]+)>/g)];
    if (logical.length) return logical.map((match) => unicode(match[1])).join("\n");
    return [...stream.matchAll(/<([A-Fa-f0-9]+)>\s*Tj/g)].map((match) => mappings.size
      ? (match[1].match(/.{4}/g) ?? []).map((glyph) => mappings.get(glyph.toUpperCase()) ?? "").join("")
      : new TextDecoder("windows-1252").decode(Buffer.from(match[1], "hex"))).join("\n");
  }).join("\n");
}

const input = { learnerDisplayName: "Owner Name", courseTitle: "Python", issuedAt: "2026-07-14T00:00:00Z", verificationId: "a".repeat(32), verificationUrl: `https://learn.test/verify/${"a".repeat(32)}`, status: "valid" as const, revokedAt: null };

describe("server certificate PDF", () => {
  it("embeds the certificate ID, verification URL and QR image", async () => {
    const id = "a".repeat(32);
    const url = `https://learn.test/verify/${id}`;
    const bytes = await renderCertificatePdf({ learnerDisplayName: "Owner Name", courseTitle: "Python", issuedAt: "2026-07-14T00:00:00Z", verificationId: id, verificationUrl: url, status: "valid", revokedAt: null });
    const document = await PDFDocument.load(bytes);
    const streams = document.context.enumerateIndirectObjects()
      .filter((entry): entry is [typeof entry[0], PDFRawStream] => entry[1] instanceof PDFRawStream);
    expect(extractText(document)).toContain(id);
    expect(extractText(document)).toContain(url);
    expect(streams.some(([, stream]) => stream.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))).toBe(true);
    const annotations = document.getPage(0).node.Annots();
    expect(annotations?.size()).toBe(1);
    expect(document.context.lookup(annotations!.get(0))?.toString()).toContain(url);
  });
  it.each(["José Muñoz", "शिवांश शर्मा"])("renders extractable Unicode name %s with one small subset font", async (name) => {
    const bytes = await renderCertificatePdf({ ...input, learnerDisplayName: name });
    const document = await PDFDocument.load(bytes);
    expect(extractText(document)).toContain(name);
    const objects = document.context.enumerateIndirectObjects().map(([, object]) => object.toString());
    expect(objects.filter((object) => object.includes("/FontFile2"))).toHaveLength(1);
    const drawnGlyphs = contentStreams(document).flatMap((stream) => [...stream.matchAll(/<([A-Fa-f0-9]+)>\s*Tj/g)]);
    expect(drawnGlyphs.length).toBeGreaterThan(0);
    expect(drawnGlyphs.every((match) => (match[1].match(/.{4}/g) ?? []).every((glyph) => glyph !== "0000"))).toBe(true);
    expect(bytes.byteLength).toBeLessThan(150_000);
  });
  it("still generates a readable PDF when a name contains an unsupported glyph", async () => {
    const bytes = await renderCertificatePdf({ ...input, learnerDisplayName: "Learner 🦄" });
    const document = await PDFDocument.load(bytes);
    expect(extractText(document)).toContain("Learner");
    expect(extractText(document)).toContain(input.verificationId);
    expect(extractText(document)).toContain(input.verificationUrl);
    expect(document.getPageCount()).toBe(1);
  });
});
