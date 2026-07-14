import { describe, expect, it } from "vitest";

import { startExamRequestSchema } from "./start-contract";

const validStart = {
  moduleId: "python.toolchain",
  integrityDisclosureAccepted: true,
  readinessAcknowledged: true,
  device: {
    viewportWidth: 1_280,
    viewportHeight: 800,
    userAgent: "Integration desktop",
  },
} as const;

describe("formal exam start contract", () => {
  it("accepts only the disclosure, readiness, module, and device claims", () => {
    expect(startExamRequestSchema.safeParse(validStart).success).toBe(true);
  });

  it("rejects a forged legacy remediation-complete claim", () => {
    expect(startExamRequestSchema.safeParse({
      ...validStart,
      remediationComplete: true,
    })).toMatchObject({ success: false });
  });

  it("rejects unknown nested device claims too", () => {
    expect(startExamRequestSchema.safeParse({
      ...validStart,
      device: { ...validStart.device, trustedDevice: true },
    })).toMatchObject({ success: false });
  });
});
