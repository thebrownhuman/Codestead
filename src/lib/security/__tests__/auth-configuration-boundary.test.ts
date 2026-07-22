import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const authSource = readFileSync(path.join(process.cwd(), "src/lib/auth.ts"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

describe("Better Auth security configuration", () => {
  it("pins the audited Better Auth release exactly", () => {
    expect(manifest.dependencies["better-auth"]).toBe("1.6.23");
  });

  it("disables implicit account linking even for a trusted OAuth provider", () => {
    expect(authSource).toContain("disableImplicitLinking: true");
  });

  it("marks invitation-created password accounts as rotation-complete without changing bootstrap defaults", () => {
    expect(authSource).toContain("mustChangePassword: false");
    expect(authSource).toContain("currentBootstrapAuthorization() === email ? undefined : false");
  });
});