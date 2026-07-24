import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("catalog SQL avoids reserved PostgreSQL role aliases", async () => {
  const source = await readFile(
    new URL("./verify-database-role-boundaries.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /join\s+pg_catalog\.pg_roles\s+current_role\b/iu,
  );
  assert.doesNotMatch(source, /\bcurrent_role\.oid\b/iu);
  assert.match(
    source,
    /join\s+pg_catalog\.pg_roles\s+active_role\b/iu,
  );
});
