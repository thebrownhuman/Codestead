import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("privacy data inventory coverage", () => {
  const root = process.cwd();
  const schema = readFileSync(path.join(root, "src/lib/db/schema.ts"), "utf8");
  const inventory = readFileSync(path.join(root, "docs/privacy-data-inventory.md"), "utf8");

  it("names every PostgreSQL table declaration in the reviewed inventory", () => {
    const declarations = [...schema.matchAll(/export const \w+ = pgTable\(\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(declarations.length).toBeGreaterThan(50);
    const missing = declarations.filter((name) => !inventory.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  it("maps recipients, external processors, retention, prohibited fields, and open evidence", () => {
    for (const heading of [
      "Recipient and retention legend",
      "PostgreSQL field inventory",
      "Non-PostgreSQL stores and processors",
      "Public, cohort, and email allowlists",
      "Prohibited collection and unresolved operator evidence",
    ]) expect(inventory).toContain(`## ${heading}`);
    for (const processor of ["Runner VM/container", "AI provider", "Gmail", "Google OAuth", "GitHub public API", "Cloudflare Tunnel", "Encrypted backups"]) {
      expect(inventory).toContain(processor);
    }
    expect(inventory).toContain("7 daily, 4 weekly, and 12 monthly");
    expect(inventory).toContain("no advertising identifier");
    expect(inventory).toContain("remains a deployment gate");
  });
});
