import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deriveLostDeviceProof,
  hashLostDeviceProof,
  LOST_DEVICE_PROOF_TTL_MS,
} from "../lost-device-recovery";

const TEST_KEY = "unit-only-lost-device-proof-key-32-bytes-minimum";

describe("lost-device mailbox proof", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("derives an opaque 256-bit proof and stores only its SHA-256 verifier", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    const raw = deriveLostDeviceProof(id, TEST_KEY);
    const verifier = hashLostDeviceProof(raw);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(verifier).not.toContain(raw);
    expect(deriveLostDeviceProof(id, TEST_KEY)).toBe(raw);
    expect(
      deriveLostDeviceProof(
        "10000000-0000-4000-8000-000000000002",
        TEST_KEY,
      ),
    ).not.toBe(raw);
    expect(LOST_DEVICE_PROOF_TTL_MS).toBe(15 * 60_000);
  });

  it("requires the independent proof key in production instead of exposing the auth signing key to mail delivery", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOST_DEVICE_PROOF_KEY", "");
    vi.stubEnv("BETTER_AUTH_SECRET", TEST_KEY);
    expect(() => deriveLostDeviceProof(id)).toThrow("LOST_DEVICE_PROOF_KEY");
    vi.stubEnv("LOST_DEVICE_PROOF_KEY", TEST_KEY);
    expect(deriveLostDeviceProof(id)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const compose = readFileSync(path.join(process.cwd(), "compose.yaml"), "utf8");
    expect(compose.match(/LOST_DEVICE_PROOF_KEY_FILE/g)).toHaveLength(2);
    const entrypoint = readFileSync(
      path.join(process.cwd(), "infra/docker/entrypoint.sh"),
      "utf8",
    );
    expect(entrypoint).toContain("REQUIRE_LOST_DEVICE_PROOF_KEY");
  });

  it("keeps security history token-free and queues only a non-secret proof reference", () => {
    const root = process.cwd();
    const schema = readFileSync(path.join(root, "src/lib/db/schema.ts"), "utf8");
    const historyBlock = schema.slice(
      schema.indexOf("export const authSessionHistory"),
      schema.indexOf("export const lostDeviceProof"),
    );
    expect(historyBlock).not.toMatch(/\b(token|password|secret|backupCodes)\s*:/i);

    const controls = readFileSync(
      path.join(root, "src/lib/session-controls.ts"),
      "utf8",
    );
    expect(controls).not.toContain("token: session.token");
    expect(controls).not.toContain("password:");
    expect(controls).not.toContain("backupCodes:");

    const recovery = readFileSync(
      path.join(root, "src/lib/security/lost-device-recovery.ts"),
      "utf8",
    );
    const queuedVariables = recovery.match(
      /template: "lost-device-proof",\s*variables: \{([^}]+)\}/g,
    );
    expect(queuedVariables).toHaveLength(2);
    for (const block of queuedVariables ?? []) {
      expect(block).toContain("recoveryRequestId");
      expect(block).not.toContain("rawProof");
      expect(block).not.toContain("url:");
    }
  });
});
