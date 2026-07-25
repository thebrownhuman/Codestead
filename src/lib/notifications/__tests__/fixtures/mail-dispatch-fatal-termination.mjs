import { writeSync } from "node:fs";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

const mode = isMainThread ? process.argv[2] : workerData?.mode;

if (!isMainThread) {
  process.reallyExit = () => {
    writeSync(1, "WORKER_REALLY_EXIT\n");
  };
  const { terminateMailDispatchImmediately } = await import(
    "../../mail-dispatch-fatal-termination.ts"
  );
  parentPort?.postMessage("READY");
  terminateMailDispatchImmediately();
}

if (mode === "really-exit-returns") {
  process.reallyExit = () => undefined;
} else if (mode === "really-exit-throws") {
  process.reallyExit = () => {
    throw new Error("injected reallyExit failure");
  };
} else if (mode === "really-exit-unavailable") {
  process.reallyExit = undefined;
} else if (mode === "kill-returns" || mode === "atomics-mutated") {
  process.reallyExit = () => undefined;
  process._kill = () => 0;
} else if (mode === "kill-throws") {
  process.reallyExit = () => undefined;
  process._kill = () => {
    throw new Error("injected _kill failure");
  };
} else if (mode === "kill-unavailable") {
  process.reallyExit = () => undefined;
  process._kill = undefined;
} else if (mode === "atomics-returns") {
  process.reallyExit = () => undefined;
  process._kill = () => 0;
  Atomics.wait = () => "not-equal";
} else if (mode === "atomics-throws") {
  process.reallyExit = () => undefined;
  process._kill = () => 0;
  Atomics.wait = () => {
    throw new Error("injected Atomics.wait failure");
  };
} else if (mode === "atomics-unavailable") {
  process.reallyExit = () => undefined;
  process._kill = () => 0;
  Atomics.wait = undefined;
} else if (mode === "shared-array-buffer-throws") {
  globalThis.SharedArrayBuffer = class {
    constructor() {
      throw new Error("injected SharedArrayBuffer allocation failure");
    }
  };
}

const {
  parkMailDispatchUntilKilled,
  terminateMailDispatchImmediately,
} = await import("../../mail-dispatch-fatal-termination.ts");

if (mode === "atomics-mutated") {
  Atomics.wait = () => "not-equal";
}

let recursiveExitDepth = 0;
process.on("beforeExit", () => {
  writeSync(1, "BEFORE_EXIT_CLEANUP\n");
});
process.on("exit", () => {
  writeSync(1, "EXIT_CLEANUP\n");
  process.exit(0);
});
process.exitCode = 0;
process.exit = () => {
  if (recursiveExitDepth === 0) {
    recursiveExitDepth += 1;
    process.exit(0);
  }
};
process.reallyExit = () => {
  writeSync(1, "MUTATED_REALLY_EXIT\n");
};
process._kill = () => {
  writeSync(1, "MUTATED_RAW_KILL\n");
  return 0;
};
if (mode !== "atomics-mutated") {
  Atomics.wait = () => {
    writeSync(1, "MUTATED_ATOMICS_WAIT\n");
    return "not-equal";
  };
}

writeSync(1, "ENTER\n");
if (mode === "worker") {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { mode: "worker-terminate" },
  });
  worker.once("message", () => {
    // The worker kills the whole process immediately after this handshake.
  });
  await new Promise(() => {});
} else if (
  mode === "park"
  || mode === "shared-array-buffer-throws"
) {
  parkMailDispatchUntilKilled();
} else if (
  mode === "native-hostile"
  || mode === "really-exit-returns"
  || mode === "really-exit-throws"
  || mode === "really-exit-unavailable"
  || mode === "kill-returns"
  || mode === "kill-throws"
  || mode === "kill-unavailable"
  || mode === "atomics-mutated"
  || mode === "atomics-returns"
  || mode === "atomics-throws"
  || mode === "atomics-unavailable"
) {
  terminateMailDispatchImmediately();
} else {
  throw new Error("invalid fixture mode");
}
writeSync(1, "RESUMED\n");
