import path from "node:path";

const DOWNLOADABLE_SCAN_STATUSES = new Set(["safe"]);

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const DEFAULT_STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_STORAGE_QUOTA_BYTES = 3 * 1024 * 1024 * 1024;

const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".java", ".py", ".pyi", ".js", ".mjs",
  ".ts", ".tsx", ".jsx", ".html", ".css", ".json", ".md", ".txt", ".csv", ".sql", ".pdf",
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
]);

const IMAGE_SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  ".png": (bytes) =>
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((byte, index) => bytes[index] === byte),
  ".jpg": (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  ".jpeg": (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  ".gif": (bytes) => {
    if (bytes.length < 6) return false;
    const header = new TextDecoder("ascii").decode(bytes.subarray(0, 6));
    return header === "GIF87a" || header === "GIF89a";
  },
  ".webp": (bytes) =>
    bytes.length >= 12 &&
    new TextDecoder("ascii").decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder("ascii").decode(bytes.subarray(8, 12)) === "WEBP",
};

export type UploadValidation =
  | { ok: true; name: string; extension: string; scanStatus: "pending" }
  | { ok: false; status: 413 | 415; error: string };

export function isStoredObjectDownloadable(scanStatus: string) {
  return DOWNLOADABLE_SCAN_STATUSES.has(scanStatus);
}

export function sanitizeUploadName(value: string) {
  const base = path.basename(value).replace(/[^A-Za-z0-9._+ -]+/g, "_").slice(0, 180);
  return base || "upload";
}

export function validateUpload(input: {
  name: string;
  size: number;
  bytes: Uint8Array;
}): UploadValidation {
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, error: "Files must be between 1 byte and 50 MB." };
  }
  if (input.bytes.byteLength !== input.size) {
    return { ok: false, status: 415, error: "The uploaded file size does not match its content." };
  }
  const name = sanitizeUploadName(input.name);
  const extension = path.extname(name).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      status: 415,
      error: "Only source code, text, PDF, PNG, JPEG, GIF, and WebP files are allowed.",
    };
  }
  if (
    extension === ".pdf" &&
    ![0x25, 0x50, 0x44, 0x46, 0x2d].every((byte, index) => input.bytes[index] === byte)
  ) {
    return { ok: false, status: 415, error: "The file does not have a valid PDF signature." };
  }
  const imageSignature = IMAGE_SIGNATURES[extension];
  if (imageSignature && !imageSignature(input.bytes)) {
    return { ok: false, status: 415, error: "The file does not have a valid image signature." };
  }
  if (extension !== ".pdf" && !imageSignature && input.bytes.includes(0)) {
    return { ok: false, status: 415, error: "Binary content is not accepted for source/text uploads." };
  }
  return {
    ok: true,
    name,
    extension,
    // Every object is quarantined until the isolated scanner marks it safe.
    scanStatus: "pending",
  };
}

export function uploadWouldExceedQuota(usedBytes: number, incomingBytes: number, quotaBytes: number) {
  if (
    ![usedBytes, incomingBytes, quotaBytes].every(Number.isSafeInteger) ||
    usedBytes < 0 ||
    incomingBytes <= 0 ||
    quotaBytes < 0
  ) {
    return true;
  }
  return usedBytes > quotaBytes - incomingBytes;
}
