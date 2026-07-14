import { createHash, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { MAX_UPLOAD_BYTES } from "./policy";

export type ScanVerdict = "clean" | "infected";

export type ScanErrorCode =
  | "path_invalid"
  | "file_missing"
  | "file_changed"
  | "scanner_unavailable"
  | "scanner_protocol"
  | "scan_internal";

export class UploadScanError extends Error {
  constructor(
    readonly code: ScanErrorCode,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "UploadScanError";
  }
}

export interface ScanLease {
  readonly id: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly leaseToken: string;
  readonly attempt: number;
}

export interface UploadScanRepository {
  claimBatch(input: {
    now: Date;
    limit: number;
    leaseMs: number;
  }): Promise<readonly ScanLease[]>;
  complete(lease: ScanLease, verdict: ScanVerdict, now: Date): Promise<boolean>;
  fail(
    lease: ScanLease,
    input: {
      code: ScanErrorCode;
      terminal: boolean;
      retryAt: Date;
      now: Date;
    },
  ): Promise<boolean>;
}

export interface StreamScanner {
  scan(stream: AsyncIterable<Uint8Array>): Promise<ScanVerdict>;
}

const SAFE_OWNER_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Stored keys are created by the server as `<user-id>/<object-uuid>`. This
 * function deliberately accepts no other shape, even when it would resolve
 * beneath the root, so database corruption cannot turn the scanner into a
 * general-purpose local file reader.
 */
export function resolveStoredObjectPath(root: string, storageKey: string) {
  if (!path.isAbsolute(root) || path.isAbsolute(storageKey) || storageKey.includes("\\") || storageKey.includes("\0")) {
    throw new UploadScanError("path_invalid", false);
  }
  const segments = storageKey.split("/");
  if (
    segments.length !== 2 ||
    !SAFE_OWNER_SEGMENT.test(segments[0] ?? "") ||
    !UUID_SEGMENT.test(segments[1] ?? "")
  ) {
    throw new UploadScanError("path_invalid", false);
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new UploadScanError("path_invalid", false);
  }
  return candidate;
}

export async function openVerifiedStoredObject(
  root: string,
  object: Pick<ScanLease, "storageKey" | "sizeBytes">,
): Promise<FileHandle> {
  const candidate = resolveStoredObjectPath(root, object.storageKey);
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch (error) {
    // A missing/unmounted storage root is an operational outage, not evidence
    // that every queued learner object has permanently disappeared.
    throw new UploadScanError("scan_internal", true, { cause: error });
  }
  try {
    const [parentReal, entry] = await Promise.all([
      realpath(path.dirname(candidate)),
      lstat(candidate),
    ]);
    if (
      (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) ||
      entry.isSymbolicLink() ||
      !entry.isFile()
    ) {
      throw new UploadScanError("path_invalid", false);
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(candidate, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size !== object.sizeBytes ||
      opened.size <= 0 ||
      opened.size > MAX_UPLOAD_BYTES
    ) {
      await handle.close();
      throw new UploadScanError("file_changed", false);
    }
    return handle;
  } catch (error) {
    if (error instanceof UploadScanError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new UploadScanError("file_missing", false, { cause: error });
    }
    if (code === "ELOOP") {
      throw new UploadScanError("path_invalid", false, { cause: error });
    }
    throw new UploadScanError("scan_internal", true, { cause: error });
  }
}

function hashesMatch(actual: string, expected: string) {
  if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export async function scanStoredObject(
  root: string,
  lease: ScanLease,
  scanner: StreamScanner,
): Promise<ScanVerdict> {
  const handle = await openVerifiedStoredObject(root, lease);
  const hash = createHash("sha256");
  let bytesRead = 0;
  async function* verifiedStream() {
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      bytesRead += bytes.byteLength;
      hash.update(bytes);
      yield bytes;
    }
  }
  try {
    const verdict = await scanner.scan(verifiedStream());
    // An infected verdict is terminal and fail-closed. ClamAV may emit FOUND
    // and close the stream as soon as it recognizes a signature, so requiring
    // a full post-verdict read would incorrectly replace that verdict with
    // `file_changed`. Clean verdicts still require complete byte/hash proof.
    if (verdict === "infected") return verdict;
    const digest = hash.digest("hex");
    if (bytesRead !== lease.sizeBytes || !hashesMatch(digest, lease.sha256)) {
      throw new UploadScanError("file_changed", false);
    }
    return verdict;
  } catch (error) {
    if (error instanceof UploadScanError) throw error;
    throw new UploadScanError("scanner_unavailable", true, { cause: error });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function retryDelayMs(attempt: number, baseMs = 5_000, maximumMs = 15 * 60_000) {
  const exponent = Math.max(0, Math.min(20, Math.trunc(attempt) - 1));
  return Math.min(maximumMs, baseMs * 2 ** exponent);
}

export interface ScanBatchSummary {
  readonly claimed: number;
  readonly clean: number;
  readonly infected: number;
  readonly retrying: number;
  readonly failedClosed: number;
  readonly leaseLost: number;
}

export async function processScanBatch(input: {
  repository: UploadScanRepository;
  scanner: StreamScanner;
  root: string;
  now?: () => Date;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaximumMs?: number;
}): Promise<ScanBatchSummary> {
  const now = input.now ?? (() => new Date());
  const batchSize = Math.max(1, Math.min(100, Math.trunc(input.batchSize ?? 10)));
  const leaseMs = Math.max(30_000, Math.trunc(input.leaseMs ?? 180_000));
  const maxAttempts = Math.max(1, Math.min(100, Math.trunc(input.maxAttempts ?? 8)));
  const leases = await input.repository.claimBatch({ now: now(), limit: batchSize, leaseMs });
  const counters = { claimed: leases.length, clean: 0, infected: 0, retrying: 0, failedClosed: 0, leaseLost: 0 };

  for (const lease of leases) {
    try {
      const verdict = await scanStoredObject(input.root, lease, input.scanner);
      const updated = await input.repository.complete(lease, verdict, now());
      if (!updated) counters.leaseLost += 1;
      else if (verdict === "clean") counters.clean += 1;
      else counters.infected += 1;
    } catch (error) {
      const scanError = error instanceof UploadScanError
        ? error
        : new UploadScanError("scan_internal", true, { cause: error });
      const terminal = !scanError.retryable || lease.attempt >= maxAttempts;
      const failedAt = now();
      const retryAt = new Date(
        failedAt.getTime() + retryDelayMs(lease.attempt, input.retryBaseMs, input.retryMaximumMs),
      );
      const updated = await input.repository.fail(lease, {
        code: scanError.code,
        terminal,
        retryAt,
        now: failedAt,
      });
      if (!updated) counters.leaseLost += 1;
      else if (terminal) counters.failedClosed += 1;
      else counters.retrying += 1;
    }
  }
  return counters;
}
