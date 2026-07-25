type SignalName = "SIGINT" | "SIGTERM";
type ContainerRole = "source" | "target";

type CleanupTarget = Readonly<{
  cleanup: () => void;
}>;

type ChildController = Readonly<{
  hasActiveChild: () => boolean;
  terminateAndWait: (signal: SignalName) => Promise<void>;
}>;

type ProcessTarget = Readonly<{
  once: (signal: SignalName, listener: () => void) => void;
  removeListener: (signal: SignalName, listener: () => void) => void;
  exit: (code: number) => void;
}>;

export function createFullSchemaRestoreLifecycle(input: Readonly<{
  childController: ChildController;
  processTarget: ProcessTarget;
  writeError: (message: string) => void;
}>): Readonly<{
  ownTaskRoot: (cleanup: () => void) => void;
  ownContainer: (role: ContainerRole, target: CleanupTarget) => void;
  cleanup: (signal?: SignalName) => Promise<void>;
  uninstallSignalHandlers: () => void;
}> {
  let taskRootCleanup: (() => void) | undefined;
  let source: CleanupTarget | undefined;
  let target: CleanupTarget | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let handlingSignal = false;
  let handlersInstalled = false;
  const registered: Array<readonly [SignalName, () => void]> = [];

  const cleanup = (signal: SignalName = "SIGTERM"): Promise<void> => {
    if (cleanupPromise !== undefined) return cleanupPromise;
    cleanupPromise = (async () => {
      let failed = false;
      try {
        await input.childController.terminateAndWait(signal);
      } catch {
        failed = true;
      }
      for (const operation of [
        target?.cleanup,
        source?.cleanup,
        taskRootCleanup,
      ]) {
        if (operation === undefined) continue;
        try {
          operation();
        } catch {
          failed = true;
        }
      }
      if (failed) {
        throw new Error("full-schema restore lifecycle cleanup failed");
      }
    })();
    return cleanupPromise;
  };

  const installSignalHandlers = () => {
    if (handlersInstalled) return;
    handlersInstalled = true;
    const install = (signal: SignalName, successExitCode: number) => {
      const listener = () => {
        if (handlingSignal) return;
        handlingSignal = true;
        void cleanup(signal).then(
          () => {
            input.processTarget.exit(successExitCode);
          },
          () => {
            input.writeError(
              "Full-schema restore gate failed: "
              + "signal_cleanup_failed\n",
            );
            input.processTarget.exit(1);
          },
        );
      };
      registered.push([signal, listener]);
      input.processTarget.once(signal, listener);
    };
    install("SIGINT", 130);
    install("SIGTERM", 143);
  };

  return {
    ownTaskRoot(rootCleanup) {
      if (taskRootCleanup !== undefined) {
        throw new Error(
          "full-schema restore lifecycle ownership is invalid",
        );
      }
      taskRootCleanup = rootCleanup;
      installSignalHandlers();
    },
    ownContainer(role, container) {
      if (!handlersInstalled) {
        throw new Error(
          "full-schema restore lifecycle ownership is invalid",
        );
      }
      if (role === "source") {
        if (source !== undefined) {
          throw new Error(
            "full-schema restore lifecycle ownership is invalid",
          );
        }
        source = container;
      } else {
        if (target !== undefined) {
          throw new Error(
            "full-schema restore lifecycle ownership is invalid",
          );
        }
        target = container;
      }
    },
    cleanup,
    uninstallSignalHandlers() {
      for (const [signal, listener] of registered) {
        input.processTarget.removeListener(signal, listener);
      }
      registered.length = 0;
    },
  };
}
