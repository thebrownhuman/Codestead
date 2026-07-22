import { describe, expect, it } from "vitest";

import {
  validateProductionLoadDisposableSandboxEvidence,
  type ProductionLoadDisposableSandboxEvidence,
} from "./production-load-disposable-sandbox";

const validEvidence: ProductionLoadDisposableSandboxEvidence = {
  platform: "linux",
  uid: 65_532,
  gid: 65_532,
  attestation: [
    "schema=1",
    "profile=codestead-production-load-disposable-network-v1",
    "egress=default-deny",
    "",
  ].join("\n"),
  attestationSafe: true,
  dockerEnvironmentSafe: true,
  hasDefaultRoute: false,
  dangerousHostPathsPresent: false,
};

describe("production load disposable network sandbox attestation", () => {
  it("returns only fixed container-owned identities after complete attestation", () => {
    expect(validateProductionLoadDisposableSandboxEvidence(validEvidence)).toEqual({
      postgres: {
        listenHost: "0.0.0.0",
        listenPort: 15_432,
        upstreamHost: "production-load-postgres",
        upstreamPort: 5432,
        maximumConnections: 16,
      },
      tunnel: {
        listenHost: "0.0.0.0",
        listenPort: 13_000,
        upstreamHost: "production-load-app",
        upstreamPort: 3000,
        maximumConnections: 16,
      },
      provider: { listenHost: "0.0.0.0", listenPort: 18_080 },
    });
  });

  it("rejects host, loopback-capable, routed, privileged, and unattested contexts", () => {
    const invalid: ProductionLoadDisposableSandboxEvidence[] = [
      { ...validEvidence, platform: "win32" },
      { ...validEvidence, uid: 0, gid: 0 },
      { ...validEvidence, uid: 1_000, gid: 1_000 },
      { ...validEvidence, attestation: "schema=1\nprofile=host\negress=default-deny\n" },
      { ...validEvidence, attestationSafe: false },
      { ...validEvidence, dockerEnvironmentSafe: false },
      { ...validEvidence, hasDefaultRoute: true },
      { ...validEvidence, dangerousHostPathsPresent: true },
    ];
    for (const evidence of invalid) {
      expect(() => validateProductionLoadDisposableSandboxEvidence(evidence)).toThrow(
        "unattested_sandbox",
      );
    }
  });
});
