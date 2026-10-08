import { readFile } from "node:fs/promises";
import path from "node:path";
// Fontkit 1.1.1's Indic shaper expects this runtime; reuse Next's bundled copy.
import "next/dist/compiled/regenerator-runtime/runtime.js";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFHexString, PDFName, PDFOperator, PDFOperatorNames, PDFString, beginText, endText, setFontAndSize, setTextMatrix, showText, rgb } from "pdf-lib";
import QRCode from "qrcode";

let bundledFont: Promise<Buffer> | undefined;
function loadFont() {
  return bundledFont ??= readFile(path.join(process.cwd(), "src/lib/certificates/fonts/NotoSansDevanagari.ttf"))
    .catch((error) => { bundledFont = undefined; throw error; });
}

type PdfCertificate = Readonly<{
  learnerDisplayName: string;
  courseTitle: string;
  issuedAt: string;
  verificationId: string;
  verificationUrl: string;
  status: "valid" | "revoked";
  revokedAt: string | null;
}>;

export async function renderCertificatePdf(certificate: PdfCertificate): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fontData = await loadFont();
  const shapingFont = fontkit.create(fontData);
  const font = await pdf.embedFont(fontData, { subset: true });
  const characterSet = new Set(font.getCharacterSet());
  const page = pdf.addPage([842, 595]);
  const fontKey = page.node.newFontDictionary(font.name, font.ref);
  page.drawRectangle({ x: 24, y: 24, width: 794, height: 547, borderColor: rgb(0.16, 0.36, 0.3), borderWidth: 2 });
  const draw = (text: string, y: number, size = 14) => {
    const printable = Array.from(text).map((character) => characterSet.has(character.codePointAt(0)!) ? character : "?").join("");
    const run = shapingFont.layout(printable);
    const fittedSize = Math.min(size, 730 / Math.max(1, run.advanceWidth / shapingFont.unitsPerEm));
    const scale = fittedSize / shapingFont.unitsPerEm;
    const glyphCodes = font.encodeText(printable).asString().match(/.{4}/g) ?? [];
    // Indic shaping can reorder glyphs. ActualText preserves logical Unicode
    // order for text extraction and accessibility, including fallback glyphs.
    page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
      PDFName.of("Span"), pdf.context.obj({ ActualText: PDFHexString.fromText(text) }).toString(),
    ]));
    // pdf-lib's ordinary drawText omits OpenType positioning. Apply the shaper's
    // advances and offsets so Devanagari vowel marks attach to the right glyph.
    page.pushOperators(beginText(), setFontAndSize(fontKey, fittedSize));
    let cursorX = 56;
    let cursorY = y;
    run.positions.forEach((position, index) => {
      page.pushOperators(
        setTextMatrix(1, 0, 0, 1, cursorX + position.xOffset * scale, cursorY + position.yOffset * scale),
        showText(PDFHexString.of(glyphCodes[index])),
      );
      cursorX += position.xAdvance * scale;
      cursorY += position.yAdvance * scale;
    });
    page.pushOperators(endText());
    page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
  };
  draw("Codestead certificate", 516, 28);
  draw("Issued to", 466);
  draw(certificate.learnerDisplayName, 430, 25);
  draw(certificate.courseTitle, 384, 20);
  draw(`Issued ${new Date(certificate.issuedAt).toISOString().slice(0, 10)}`, 347);
  draw(certificate.status === "revoked"
    ? `Revoked${certificate.revokedAt ? ` ${new Date(certificate.revokedAt).toISOString().slice(0, 10)}` : ""}` : "Valid at download time", 315);
  draw(`Certificate ID: ${certificate.verificationId}`, 273, 12);
  draw(certificate.verificationUrl, 244, 11);
  draw("Scan or open the verification URL to check the current status.", 80, 11);
  const qr = await pdf.embedPng(await QRCode.toDataURL(certificate.verificationUrl, { type: "image/png", width: 160, margin: 2, errorCorrectionLevel: "M" }));
  page.drawImage(qr, { x: 635, y: 90, width: 135, height: 135 });
  const link = pdf.context.register(pdf.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [56, 240, 786, 258], Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of(certificate.verificationUrl) },
  }));
  page.node.set(PDFName.of("Annots"), pdf.context.obj([link]));
  pdf.setTitle("Codestead certificate");
  return pdf.save();
}
