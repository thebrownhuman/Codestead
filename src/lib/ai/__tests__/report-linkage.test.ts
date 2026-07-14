import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("tutor report evidence linkage", () => {
  it("returns the same call id stored on the model call and assistant message", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/app/api/ai/tutor/route.ts"),
      "utf8",
    );
    expect(source).toContain("const callId = randomUUID()");
    expect(source).toContain("id: callId");
    expect(source).toContain("modelCallId: callId");
    expect(source).toMatch(/source:\s*routed\.source,\s*callId,/);
  });

  it("never accepts report evidence directly from the browser", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/app/api/ai/reports/route.ts"),
      "utf8",
    );
    expect(source).toContain("eq(modelCall.userId, authz.session.user.id)");
    expect(source).toContain('eq(modelCall.operation, "tutor")');
    expect(source).not.toMatch(/body\.data\.(?:provider\b|model\b|promptVersion\b|contextManifest\b|requestHash\b|responseHash\b)/);
  });
});
