import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const storeSource = readFileSync(
  path.resolve(process.cwd(), "src/lib/learning-service/drizzle-store.ts"),
  "utf8",
);

describe("plan initialization user-authority ordering", () => {
  it("takes A then the exact U row before the learner plan/source lock", () => {
    const start = storeSource.indexOf("async lockPlanInitialization");
    const end = storeSource.indexOf("async getPlanningProfile", start);
    const boundary = storeSource.slice(start, end);
    const authorityLock = boundary.indexOf("await lockUserAuthority");
    const userRead = boundary.indexOf(".from(user)");
    const userRowLock = boundary.indexOf('.for("update")');
    const planLock = boundary.indexOf('await this.lock("learning-plan"');

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(authorityLock).toBeGreaterThanOrEqual(0);
    expect(userRead).toBeGreaterThan(authorityLock);
    expect(userRowLock).toBeGreaterThan(userRead);
    expect(planLock).toBeGreaterThan(userRowLock);
  });
});
