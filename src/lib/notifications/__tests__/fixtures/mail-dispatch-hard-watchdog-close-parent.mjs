import { writeSync } from "node:fs";

import {
  disarmMailDispatchHardWatchdog,
  startMailDispatchHardWatchdog,
} from "../../mail-dispatch-hard-watchdog.ts";

const watchdog = await startMailDispatchHardWatchdog();
const armed = await watchdog.arm();
await disarmMailDispatchHardWatchdog(armed);
await watchdog.close();
writeSync(1, "CLOSED\n");
