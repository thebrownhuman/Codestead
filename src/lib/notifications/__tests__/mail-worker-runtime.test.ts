import { describe, expect, it } from "vitest";
import { requireMailWorkerRoleRuntime } from "../mail-worker-role-runtime";

describe("mail worker startup authority", () => {
  it("rejects missing, duplicated, false, and nonboolean attestation results", async () => {
    for (const rows of [[], [{ mail_role_exact: false }], [{ mail_role_exact: "true" }],
      [{ mail_role_exact: true }, { mail_role_exact: true }]]) {
      await expect(requireMailWorkerRoleRuntime({ query: async () => ({ rows }) }))
        .rejects.toThrow("Mail worker role authority is unavailable.");
    }
  });

  it("requires a successful exact catalog attestation", async () => {
    await expect(requireMailWorkerRoleRuntime({ query: async () => ({ rows: [{ mail_role_exact: true }] }) }))
      .resolves.toBeUndefined();
    const failure = Object.assign(new Error("database unavailable"), { code: "08006" });
    await expect(requireMailWorkerRoleRuntime({ query: async () => { throw failure; } }))
      .rejects.toBe(failure);
  });
});
