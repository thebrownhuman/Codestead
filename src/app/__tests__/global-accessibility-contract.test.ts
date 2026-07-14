import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const globalCss = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

describe("global accessibility styling contract", () => {
  it("keeps the page bounded at the supported viewport and honors system accessibility modes", () => {
    expect(globalCss).toContain("min-width: 320px");
    expect(globalCss).toContain("overflow-x: clip");
    expect(globalCss).toContain("@media (prefers-contrast: more)");
    expect(globalCss).toContain("@media (forced-colors: active)");
    expect(globalCss).toContain("html[data-reduce-motion=\"true\"] *");
  });

  it("retains visible focus and full-size global actions", () => {
    expect(globalCss).toContain(":focus-visible");
    expect(globalCss).toContain("outline: 3px solid var(--focus)");
    expect(globalCss).toContain("min-height: 44px");
    expect(globalCss).toContain("touch-action: manipulation");
  });
});
