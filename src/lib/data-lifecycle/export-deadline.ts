export const EXPORT_DEADLINE_MS = 120_000;

export class ExportDeadlineError extends Error {
  readonly code = "EXPORT_DEADLINE_EXCEEDED";
  constructor() {
    super("The export exceeded its 120-second deadline. No file was saved. Please retry.");
  }
}

export function exportDeadline() {
  const controller = new AbortController();
  const expiresAt = new Date(Date.now() + EXPORT_DEADLINE_MS);
  const timer = setTimeout(() => controller.abort(new ExportDeadlineError()), EXPORT_DEADLINE_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    expiresAt,
    dispose: () => clearTimeout(timer),
    abort: (reason: Error) => controller.abort(reason),
  };
}

export function withinExportDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
