import assert from "node:assert/strict";
import test from "node:test";

import { utcSecondTimestamp } from "./manage-application-images.mjs";

test("the manager emits canonical UTC timestamps without milliseconds", () => {
  assert.equal(
    utcSecondTimestamp(new Date("2026-07-19T12:34:56.789Z")),
    "2026-07-19T12:34:56Z",
  );
});
