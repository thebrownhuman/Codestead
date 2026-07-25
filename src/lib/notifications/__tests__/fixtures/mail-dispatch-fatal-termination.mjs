const mode = process.argv[2];

if (mode === "shared-array-buffer-throws") {
  globalThis.SharedArrayBuffer = class {
    constructor() {
      throw new Error("injected SharedArrayBuffer allocation failure");
    }
  };
} else if (mode === "atomics-wait-throws") {
  Atomics.wait = () => {
    throw new Error("injected Atomics.wait failure");
  };
}

const {
  parkMailDispatchUntilKilled,
  terminateMailDispatchImmediately,
} = await import("../../mail-dispatch-fatal-termination.ts");

if (mode === "exit-returns") {
  process.exit = () => undefined;
} else if (mode === "exit-throws") {
  process.exit = () => {
    throw new Error("injected exit failure");
  };
} else if (
  mode !== "park" &&
  mode !== "exit" &&
  mode !== "shared-array-buffer-throws" &&
  mode !== "atomics-wait-throws"
) {
  throw new Error("invalid fixture mode");
}

process.stdout.write("ENTER\n");
if (
  mode === "park" ||
  mode === "shared-array-buffer-throws" ||
  mode === "atomics-wait-throws"
) {
  parkMailDispatchUntilKilled();
} else {
  terminateMailDispatchImmediately();
}
process.stdout.write("RESUMED\n");
