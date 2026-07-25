import { spawnSync } from "node:child_process";
import path from "node:path";

import { minimalNodeTestEnvironment } from
  "./disposable-integration-environment";
import { disposableIntegrationFailure } from
  "./disposable-integration-error";

type SignalName = "SIGINT" | "SIGTERM";

export type DisposableIntegrationChildProcess = Readonly<{
  exitCode: number | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: "close", listener: () => void) => unknown;
  pid?: number;
  signalCode: NodeJS.Signals | null;
}>;

type TrackedChild = {
  child: DisposableIntegrationChildProcess;
  closed: boolean;
  termination?: Promise<void>;
};

export type DisposableIntegrationTrackedChild<
  Child extends DisposableIntegrationChildProcess,
> = Readonly<{
  child: Child;
  completeAndWait: (signal: SignalName) => Promise<void>;
}>;

export type DisposableIntegrationChildController = Readonly<{
  hasActiveChild: () => boolean;
  spawnAndTrack: <Child extends DisposableIntegrationChildProcess>(
    spawnChild: () => Child,
  ) => DisposableIntegrationTrackedChild<Child>;
  terminateAndWait: (signal: SignalName) => Promise<void>;
  waitForTermination: () => Promise<void>;
}>;

export type DisposableIntegrationProcessTreeOperations = Readonly<{
  isTreeAlive: (child: DisposableIntegrationChildProcess) => boolean;
  terminate: (
    child: DisposableIntegrationChildProcess,
    signal: NodeJS.Signals,
  ) => void;
}>;

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw disposableIntegrationFailure("invalid_child_timeout");
  }
  return value;
}

function requireChildPid(
  child: DisposableIntegrationChildProcess,
): number {
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    throw disposableIntegrationFailure("invalid_child_pid");
  }
  return pid;
}

export function createDisposableIntegrationProcessTreeOperations(
  input: Readonly<{
    platform?: NodeJS.Platform;
    executeWindowsTreeKill?: (pid: number) => number | null;
    signalProcess?: (
      pid: number,
      signal: NodeJS.Signals | 0,
    ) => void;
  }> = {},
): DisposableIntegrationProcessTreeOperations {
  const platform = input.platform ?? process.platform;
  const windowsTreesKilled = new WeakSet<object>();
  const executeWindowsTreeKill = input.executeWindowsTreeKill ?? ((pid) => {
    const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot
      ?? "C:\\Windows";
    const result = spawnSync(
      path.join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      {
        env: minimalNodeTestEnvironment(process.env),
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      },
    );
    return result.status;
  });
  const signalProcess = input.signalProcess
    ?? ((pid: number, signal: NodeJS.Signals | 0) => {
      process.kill(pid, signal);
    });

  const terminate = (
    child: DisposableIntegrationChildProcess,
    signal: NodeJS.Signals,
  ): void => {
    const pid = requireChildPid(child);
    if (platform === "win32") {
      if (executeWindowsTreeKill(pid) !== 0) {
        throw disposableIntegrationFailure("child_tree_termination_failed");
      }
      windowsTreesKilled.add(child);
      return;
    }
    signalProcess(-pid, signal);
  };

  const isTreeAlive = (
    child: DisposableIntegrationChildProcess,
  ): boolean => {
    if (platform === "win32") {
      return !windowsTreesKilled.has(child)
        && child.exitCode === null
        && child.signalCode === null;
    }
    let pid: number;
    try {
      pid = requireChildPid(child);
    } catch {
      return true;
    }
    try {
      signalProcess(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  return { isTreeAlive, terminate };
}

async function waitForChildren(
  children: readonly TrackedChild[],
  timeoutMs: number,
  isTreeAlive: (
    child: DisposableIntegrationChildProcess,
  ) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const complete = children.every((tracked) => {
      if (!tracked.closed) return false;
      try {
        return !isTreeAlive(tracked.child);
      } catch {
        return false;
      }
    });
    if (complete) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(25, remaining));
    });
  }
}

export function createDisposableIntegrationChildController(
  input: Readonly<{
    gracefulTimeoutMs?: number;
    forceTimeoutMs?: number;
    isTreeAlive?: (
      child: DisposableIntegrationChildProcess,
    ) => boolean;
    terminate?: (
      child: DisposableIntegrationChildProcess,
      signal: NodeJS.Signals,
    ) => void;
  }> = {},
): DisposableIntegrationChildController {
  const gracefulTimeoutMs = positiveTimeout(
    input.gracefulTimeoutMs ?? 5_000,
  );
  const forceTimeoutMs = positiveTimeout(input.forceTimeoutMs ?? 5_000);
  const processTree = createDisposableIntegrationProcessTreeOperations();
  const terminate = input.terminate ?? processTree.terminate;
  const isTreeAlive = input.isTreeAlive ?? processTree.isTreeAlive;
  const active = new Set<TrackedChild>();
  let shutdownSignal: SignalName | undefined;
  let activeTermination: Promise<void> | undefined;

  const performTrackedTermination = async (
    tracked: TrackedChild,
    signal: SignalName,
  ): Promise<void> => {
    if (!active.has(tracked)) return;
    let treeAlive = true;
    try {
      treeAlive = isTreeAlive(tracked.child);
    } catch {
      // The bounded termination proof below remains authoritative.
    }
    if (tracked.closed && !treeAlive) {
      active.delete(tracked);
      return;
    }
    try {
      terminate(tracked.child, signal);
    } catch {
      // The tree-exit proof below remains authoritative.
    }
    if (
      await waitForChildren([tracked], gracefulTimeoutMs, isTreeAlive)
    ) {
      active.delete(tracked);
      return;
    }
    try {
      terminate(tracked.child, "SIGKILL");
    } catch {
      // The final bounded tree-exit proof below remains authoritative.
    }
    if (await waitForChildren([tracked], forceTimeoutMs, isTreeAlive)) {
      active.delete(tracked);
      return;
    }
    throw disposableIntegrationFailure("active_child_reap_failed");
  };

  const ensureTrackedTermination = (
    tracked: TrackedChild,
    signal: SignalName,
  ): Promise<void> => {
    if (tracked.termination !== undefined) return tracked.termination;
    let resolveTermination: () => void = () => undefined;
    let rejectTermination: (error: unknown) => void = () => undefined;
    const barrier = new Promise<void>((resolve, reject) => {
      resolveTermination = resolve;
      rejectTermination = reject;
    });
    tracked.termination = barrier;
    void performTrackedTermination(tracked, signal).then(
      resolveTermination,
      rejectTermination,
    );
    return barrier;
  };

  const spawnAndTrack = <
    Child extends DisposableIntegrationChildProcess,
  >(
    spawnChild: () => Child,
  ): DisposableIntegrationTrackedChild<Child> => {
    if (shutdownSignal !== undefined) {
      throw disposableIntegrationFailure("child_spawn_after_shutdown");
    }
    const child = spawnChild();
    const tracked: TrackedChild = { child, closed: false };
    active.add(tracked);
    child.once("close", () => {
      tracked.closed = true;
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      tracked.closed = true;
    }
    return {
      child,
      completeAndWait: (signal) => ensureTrackedTermination(tracked, signal),
    };
  };

  const terminateAndWait = (signal: SignalName): Promise<void> => {
    if (activeTermination !== undefined) return activeTermination;
    shutdownSignal = signal;
    activeTermination = Promise.all(
      [...active].map((tracked) => ensureTrackedTermination(
        tracked,
        signal,
      )),
    ).then(() => undefined);
    return activeTermination;
  };

  return {
    hasActiveChild: () => active.size > 0,
    spawnAndTrack,
    terminateAndWait,
    waitForTermination: () => (
      activeTermination ?? Promise.resolve()
    ),
  };
}
