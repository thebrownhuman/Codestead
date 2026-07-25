type SignalName = "SIGINT" | "SIGTERM";

type CleanupTarget = Readonly<{
  cleanup: () => void;
}>;

export function installFullSchemaRestoreSignalHandlers(input: Readonly<{
  source: CleanupTarget;
  target: CleanupTarget;
  cleanupTaskRoot: () => void;
  processTarget: Readonly<{
    once: (signal: SignalName, listener: () => void) => void;
    removeListener: (signal: SignalName, listener: () => void) => void;
    exit: (code: number) => void;
  }>;
  writeError: (message: string) => void;
}>): () => void {
  let handlingSignal = false;
  const registered: Array<readonly [SignalName, () => void]> = [];
  const install = (signal: SignalName, successExitCode: number) => {
    const listener = () => {
      if (handlingSignal) return;
      handlingSignal = true;
      let cleanupFailed = false;
      for (const cleanup of [
        input.target.cleanup,
        input.source.cleanup,
        input.cleanupTaskRoot,
      ]) {
        try {
          cleanup();
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        input.writeError(
          "Full-schema restore gate failed: signal_cleanup_failed\n",
        );
      }
      input.processTarget.exit(cleanupFailed ? 1 : successExitCode);
    };
    registered.push([signal, listener]);
    input.processTarget.once(signal, listener);
  };
  install("SIGINT", 130);
  install("SIGTERM", 143);
  return () => {
    for (const [signal, listener] of registered) {
      input.processTarget.removeListener(signal, listener);
    }
  };
}
