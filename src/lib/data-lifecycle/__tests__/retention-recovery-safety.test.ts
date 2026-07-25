import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function source(file: string) {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("retention crash recovery and object revalidation contracts", () => {
  it("locks eligible objects inside their deletion transaction and revalidates the predicate", () => {
    const retention = source("src/lib/data-lifecycle/retention.ts");
    const helperStart = retention.indexOf("async function commitObjectRetentionCheckpoint");
    const helperEnd = retention.indexOf("function reportOutcome", helperStart);
    const helper = retention.slice(helperStart, helperEnd);
    const transaction = helper.indexOf('await client.query("begin")');
    const selection = helper.indexOf("await eligibleObjectRows");
    const deletion = helper.indexOf("delete from stored_object");
    const revalidation = helper.indexOf("Retention object eligibility changed during locked deletion.");
    const enqueue = helper.indexOf("await enqueueFileErasures");
    const checkpoint = helper.indexOf('phase: "file_erasure_pending"');
    const persistence = helper.indexOf("update data_lifecycle_run set report");
    const commit = helper.indexOf('await client.query("commit")');

    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(transaction).toBeGreaterThan(-1);
    expect(selection).toBeGreaterThan(transaction);
    expect(deletion).toBeGreaterThan(selection);
    expect(revalidation).toBeGreaterThan(deletion);
    expect(enqueue).toBeGreaterThan(revalidation);
    expect(checkpoint).toBeGreaterThan(enqueue);
    expect(persistence).toBeGreaterThan(checkpoint);
    expect(commit).toBeGreaterThan(persistence);
    expect(retention).toMatch(/select id, storage_key from stored_object[\s\S]*for update skip locked/u);
    expect(helper).toMatch(/delete from stored_object[\s\S]*retention_class = 'temporary'[\s\S]*returning id, storage_key/u);
  });

  it("bounds automatic same-command recovery retries in the production service", () => {
    const unit = source("infra/systemd/learncoding-retention.service");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toMatch(/RestartSec=\d+s/u);
    expect(unit).toMatch(/StartLimitBurst=\d+/u);
    expect(unit).toMatch(/StartLimitIntervalSec=\d+/u);
  });
});
