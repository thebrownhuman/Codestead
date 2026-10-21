import { RateLimiterMemory } from "rate-limiter-flexible";
import { configuredCodeRunnerProvider } from "./provider-config";
import { pinnedPistonImageDigest } from "./exam-client";
import { PISTON_RUNTIMES } from "./piston-client";

type Health = { status: "ready" | "unavailable"; latencyMs: number; limited?: true };
type Dependencies = {
  request: typeof fetch;
  warn: (message: string) => void;
};
const CACHE_MS = 30_000;
const TIMEOUT_MS = 3_000;
const MAX_BYTES = 65_536;

async function runtimeInventory(response: Response) {
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("Unavailable");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Unavailable");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("Unavailable");
      chunks.push(part.value);
    }
    const inventory: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return Array.isArray(inventory) && Object.values(PISTON_RUNTIMES).every((required) =>
      inventory.some((entry: unknown) => entry !== null && typeof entry === "object" &&
        "language" in entry && entry.language === required.language && "version" in entry && entry.version === required.version));
  } finally { void reader.cancel().catch(() => {}); }
}

/** Per application process: one in-flight probe, cached failures, and one fixed limiter bucket. */
export function createRunnerHealth(deps: Dependencies = {
  request: fetch,
  warn: (message) => console.warn(message),
}) {
  const limiter = new RateLimiterMemory({ points: 120, duration: 60 });
  let cached: { result: Health; expires: number } | undefined;
  let pending: Promise<Health> | undefined;
  async function probe(): Promise<Health> {
    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const available = await Promise.race([
        (async () => {
          configuredCodeRunnerProvider();
          if (!process.env.PISTON_URL || !process.env.PISTON_IMAGE) return false;
          pinnedPistonImageDigest(process.env.PISTON_IMAGE);
          const url = new URL(process.env.PISTON_URL);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return false;
          const response = await deps.request(`${url.origin}/api/v2/runtimes`, {
            cache: "no-store", redirect: "error", signal: controller.signal,
          });
          return runtimeInventory(response);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("Unavailable")); }, TIMEOUT_MS);
        }),
      ]);
      if (!available) throw new Error("Unavailable");
      return { status: "ready", latencyMs: Math.max(0, Date.now() - started) };
    } catch {
      deps.warn("Runner health probe failed");
      return { status: "unavailable", latencyMs: Math.max(0, Date.now() - started) };
    } finally { clearTimeout(timer); }
  }
  return async (): Promise<Health> => {
    // No per-IP map, forwarded-header trust, credential access, or database dependency.
    try { await limiter.consume("runner-health"); }
    catch { return { status: "unavailable", latencyMs: 0, limited: true }; }
    if (cached && Date.now() < cached.expires) return cached.result;
    if (!pending) {
      pending = probe().then((result) => {
        cached = { result, expires: Date.now() + CACHE_MS };
        return result;
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };
}

export const runnerHealth = createRunnerHealth();
