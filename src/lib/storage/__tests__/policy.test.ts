import { describe, expect, it } from "vitest";

import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_STORAGE_QUOTA_BYTES,
  MAX_UPLOAD_BYTES,
  isStoredObjectDownloadable,
  sanitizeUploadName,
  uploadWouldExceedQuota,
  validateUpload,
} from "../policy";

describe("stored object download policy", () => {
  it("allows only objects that passed the isolated scanner", () => {
    const status = "safe";
    expect(isStoredObjectDownloadable(status)).toBe(true);
  });

  it.each(["basic_safe", "pending", "scanning", "quarantined", "deleted", "scanner_error", ""])(
    "fails closed for %s objects",
    (status) => {
      expect(isStoredObjectDownloadable(status)).toBe(false);
    },
  );
});

describe("upload validation", () => {
  const text = new TextEncoder().encode("int main(void) { return 0; }");

  it("accepts every declared source/text family case-insensitively", () => {
    for (const extension of [
      "c", "h", "cpp", "cc", "cxx", "hpp", "java", "py", "pyi", "js", "mjs",
      "ts", "tsx", "jsx", "html", "css", "json", "md", "txt", "csv", "sql",
    ]) {
      expect(validateUpload({ name: `lesson.${extension.toUpperCase()}`, size: text.length, bytes: text }))
        .toMatchObject({ ok: true, extension: `.${extension}`, scanStatus: "pending" });
    }
  });

  it("accepts a signed PDF but leaves it pending for malware scanning", () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\ncontent");
    expect(validateUpload({ name: "notes.pdf", size: bytes.length, bytes })).toEqual({
      ok: true,
      name: "notes.pdf",
      extension: ".pdf",
      scanStatus: "pending",
    });
  });

  it.each([
    { name: "diagram.png", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]) },
    { name: "photo.jpg", bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 1]) },
    { name: "photo.jpeg", bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1]) },
    { name: "trace.gif", bytes: new TextEncoder().encode("GIF89a\0") },
    { name: "preview.webp", bytes: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]) },
  ])("accepts a signature-checked safe image: $name", ({ name, bytes }) => {
    expect(validateUpload({ name, size: bytes.length, bytes })).toMatchObject({
      ok: true,
      scanStatus: "pending",
    });
  });

  it.each([
    { name: "empty.py", size: 0, bytes: new Uint8Array(), status: 413 },
    { name: "huge.py", size: MAX_UPLOAD_BYTES + 1, bytes: text, status: 413 },
    { name: "fake.pdf", size: text.length, bytes: text, status: 415 },
    { name: "fake.png", size: text.length, bytes: text, status: 415 },
    { name: "fake.jpeg", size: text.length, bytes: text, status: 415 },
    { name: "binary.py", size: 3, bytes: Uint8Array.from([65, 0, 66]), status: 415 },
    { name: "archive.zip", size: text.length, bytes: text, status: 415 },
    { name: "mismatch.py", size: text.length + 1, bytes: text, status: 415 },
  ])("rejects unsafe upload $name", ({ name, size, bytes, status }) => {
    expect(validateUpload({ name, size, bytes })).toMatchObject({ ok: false, status });
  });

  it("removes path traversal, control characters, and overlong names", () => {
    expect(sanitizeUploadName("../../evil\r\nname.py")).toBe("evil_name.py");
    expect(sanitizeUploadName("a".repeat(200) + ".py")).toHaveLength(180);
    expect(sanitizeUploadName("😈")).toBe("_");
    expect(sanitizeUploadName("")).toBe("upload");
  });
});

describe("quota arithmetic", () => {
  it("allows an upload that exactly fills the quota", () => {
    expect(uploadWouldExceedQuota(DEFAULT_STORAGE_QUOTA_BYTES - 10, 10, DEFAULT_STORAGE_QUOTA_BYTES))
      .toBe(false);
  });

  it("keeps the declared adjustable quota ceiling at three GiB", () => {
    expect(DEFAULT_STORAGE_QUOTA_BYTES).toBe(2 * 1024 ** 3);
    expect(MAX_STORAGE_QUOTA_BYTES).toBe(3 * 1024 ** 3);
  });

  it("rejects over-quota and invalid arithmetic fail-closed", () => {
    expect(uploadWouldExceedQuota(DEFAULT_STORAGE_QUOTA_BYTES - 9, 10, DEFAULT_STORAGE_QUOTA_BYTES))
      .toBe(true);
    for (const values of [
      [-1, 1, 10], [0, 0, 10], [0, 1, -1], [Number.NaN, 1, 10],
      [Number.MAX_SAFE_INTEGER + 1, 1, Number.MAX_SAFE_INTEGER],
    ] as Array<[number, number, number]>) {
      expect(uploadWouldExceedQuota(values[0], values[1], values[2])).toBe(true);
    }
  });
});
