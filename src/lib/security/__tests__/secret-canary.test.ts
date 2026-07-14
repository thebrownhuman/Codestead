import { describe, expect, it } from "vitest";

import { findSecretCanaries } from "../secret-canary";

describe("secret canary scanner", () => {
  it("detects provider and private-key canaries without returning the secret", () => {
    const nvidia = ["nvapi", "-", "A".repeat(40)].join("");
    const privateKey = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    const findings = findSecretCanaries(`safe\n${nvidia}\n${privateKey}`);
    expect(findings).toEqual([
      { detector: "nvidia-api-key", line: 2 },
      { detector: "private-key", line: 3 },
    ]);
    expect(JSON.stringify(findings)).not.toContain(nvidia);
  });

  it("does not flag masked metadata or deliberately short synthetic fixtures", () => {
    expect(findSecretCanaries("NVIDIA NIM •••• abcd\nnvapi-test-only")).toEqual([]);
  });
});
