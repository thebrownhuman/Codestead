import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function source(file: string) {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("retention crash recovery and object revalidation contracts", () => {
  it("locks eligible objects inside their deletion transaction and revalidates the predicate", () => {
    const retention = source("src/lib/data-lifecycle/retention.ts");
    const objectRoot = retention.indexOf("const objectRoot =");
    const transaction = retention.indexOf('await client.query("begin")', objectRoot);
    const selection = retention.indexOf("await eligibleObjectRows", objectRoot);
    const enqueue = retention.indexOf("await enqueueFileErasures", objectRoot);

    expect(objectRoot).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(objectRoot);
    expect(selection).toBeGreaterThan(transaction);
    expect(enqueue).toBeGreaterThan(selection);
    expect(retention).toMatch(/select id, storage_key[\s\S]*for update skip locked/u);
    expect(retention).toMatch(/delete from stored_object[\s\S]*retention_class = 'temporary'[\s\S]*returning id, storage_key/u);
  });

  it("bounds automatic same-command recovery retries in the production service", () => {
    const unit = source("infra/systemd/learncoding-retention.service");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toMatch(/RestartSec=\d+s/u);
    expect(unit).toMatch(/StartLimitBurst=\d+/u);
    expect(unit).toMatch(/StartLimitIntervalSec=\d+/u);
  });
});
