import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function processSource() {
  return readFileSync(
    resolve(process.cwd(), "scripts", "process-outbox.ts"),
    "utf8",
  );
}

describe("mail worker startup authority contract", () => {
  it("uses the opaque pool-bound inspection and origin capabilities", () => {
    const source = processSource();

    expect(source).toContain("createMailDispatchBootstrapResources");
    expect(source).toContain("inspectMailDispatchRuntime");
    expect(source).toContain("captureMailDispatchApplicationOrigin");
    expect(source).toContain("mailDispatchApplicationUrl");
    expect(source).toContain("new PostgresOutboxStore(");
    expect(source).not.toContain("requireMailDispatchPostgresRuntime");
    expect(source).not.toContain("requireMailDeliveryAuthorityRuntime");
    expect(source).not.toContain("requireRunnableMailDeliveryAuthority");
  });

  it("inspects before every mail configuration capture", () => {
    const source = processSource();
    const inspection = source.indexOf("await inspectMailDispatchRuntime(");
    const origin = source.indexOf("captureMailDispatchApplicationOrigin(");
    const transport = source.indexOf("captureMailTransportConfiguration(");
    const store = source.indexOf("new PostgresOutboxStore(");
    const watchdog = source.indexOf("startMailDispatchHardWatchdog(");

    expect(inspection).toBeGreaterThanOrEqual(0);
    expect(origin).toBeGreaterThan(inspection);
    expect(transport).toBeGreaterThan(inspection);
    expect(store).toBeGreaterThan(origin);
    expect(watchdog).toBeGreaterThan(store);
  });

  it("has one dedicated pool lifecycle and no second or global pool", () => {
    const source = processSource();

    expect(source).not.toContain("createMailDispatchDatabaseResources");
    expect(source).not.toContain("../src/lib/db/client");
    expect(source).toContain("scheduleInactivityReminders(");
    expect(source).toContain("scheduleSmartRemindersWithDatabase(");
    expect(source).toContain("watchdog.close()");
    expect(source).toContain("activeResources.pool.end()");
  });
});
