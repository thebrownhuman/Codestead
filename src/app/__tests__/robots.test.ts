import { describe, expect, it } from "vitest";

import robots from "../robots";

describe("robots", () => {
  it("disallows /admin and /api", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const disallow = Array.isArray(rules?.disallow) ? rules.disallow : [rules?.disallow];
    expect(disallow).toContain("/admin/");
    expect(disallow).toContain("/api/");
    expect(disallow).toContain("/learn/");
  });

  it("allows the public landing page", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const allow = Array.isArray(rules?.allow) ? rules.allow : [rules?.allow];
    expect(allow).toContain("/");
  });
});
