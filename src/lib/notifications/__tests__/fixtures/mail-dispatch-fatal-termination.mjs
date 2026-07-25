import {
  parkMailDispatchUntilKilled,
  terminateMailDispatchImmediately,
} from "../../mail-dispatch-fatal-termination.ts";

const mode = process.argv[2];

if (mode === "exit-returns") {
  process.exit = () => undefined;
} else if (mode === "exit-throws") {
  process.exit = () => {
    throw new Error("injected exit failure");
  };
} else if (mode !== "park" && mode !== "exit") {
  throw new Error("invalid fixture mode");
}

process.stdout.write("ENTER\n");
if (mode === "park") {
  parkMailDispatchUntilKilled();
} else {
  terminateMailDispatchImmediately();
}
process.stdout.write("RESUMED\n");
