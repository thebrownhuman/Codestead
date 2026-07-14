import { readFileSync } from "node:fs";
import path from "node:path";

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import SourcePage from "../page";

describe("open-source legal notice", () => {
  const previous = process.env.SOURCE_CODE_URL;
  afterEach(() => {
    if (previous === undefined) delete process.env.SOURCE_CODE_URL;
    else process.env.SOURCE_CODE_URL = previous;
  });

  it("offers this deployment's source and full controlling license", () => {
    process.env.SOURCE_CODE_URL = "https://example.test/source/learncoding";
    render(<SourcePage />);
    expect(screen.getByRole("heading", { name: /License and corresponding source/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Get this deployment's source/i })).toHaveAttribute(
      "href",
      "https://example.test/source/learncoding",
    );
    expect(screen.getByRole("link", { name: /Read the full license/i })).toHaveAttribute(
      "href",
      "https://www.gnu.org/licenses/agpl-3.0.html",
    );
    expect(document.body.textContent).toMatch(/without warranty/i);
  });

  it("fails visibly rather than pretending source access exists when unconfigured", () => {
    delete process.env.SOURCE_CODE_URL;
    render(<SourcePage />);
    expect(screen.queryByRole("link", { name: /Get this deployment's source/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Source archive URL is not configured/i)).toBeInTheDocument();
  });

  it("ships the exact AGPL family text and package SPDX identifier", () => {
    const root = process.cwd();
    const license = readFileSync(path.join(root, "LICENSE"), "utf8");
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { license?: string };
    expect(license).toMatch(/^GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
    expect(license).toContain("13. Remote Network Interaction; Use with the GNU General Public License.");
    expect(license).toContain("END OF TERMS AND CONDITIONS");
    expect(pkg.license).toBe("AGPL-3.0-only");
  });
});
