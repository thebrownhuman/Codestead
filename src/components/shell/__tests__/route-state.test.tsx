import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReturnHomeLink, RouteState } from "../route-state";

const routeStateCss = readFileSync(
  resolve(process.cwd(), "src/components/shell/route-state.module.css"),
  "utf8",
);
const appLoading = readFileSync(resolve(process.cwd(), "src/app/loading.tsx"), "utf8");
const appError = readFileSync(resolve(process.cwd(), "src/app/error.tsx"), "utf8");
const appNotFound = readFileSync(resolve(process.cwd(), "src/app/not-found.tsx"), "utf8");

describe("RouteState", () => {
  it("announces loading without exposing decorative skeleton content", () => {
    render(
      <RouteState
        description="Saved progress stays in place."
        eyebrow="Loading checkpoint"
        title="Preparing your route"
        variant="loading"
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAccessibleName("Preparing your route");
    expect(screen.getByText("Saved progress stays in place.")).toBeVisible();
  });

  it("gives route errors an announced recovery action", async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(
      <RouteState
        action={<button onClick={reset} type="button">Try again</button>}
        description="The page could not load."
        eyebrow="Route interrupted"
        title="Run this checkpoint again"
        variant="error"
      />,
    );

    expect(screen.getByRole("alert")).toHaveAccessibleName("Run this checkpoint again");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("provides a real internal route out of a missing page", () => {
    render(
      <RouteState
        action={<ReturnHomeLink />}
        description="This route moved."
        eyebrow="Path not found"
        title="No checkpoint here"
        variant="not-found"
      />,
    );

    expect(screen.getByRole("link", { name: "Return to learning home" })).toHaveAttribute("href", "/learn");
  });

  it("contains reduced-motion, small-screen, and forced-color fallbacks", () => {
    expect(routeStateCss).toContain('@media (max-width: 480px)');
    expect(routeStateCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(routeStateCss).toContain(':global(html[data-motion="reduce"]) .spinner');
    expect(routeStateCss).toContain('@media (forced-colors: active)');
  });

  it("wires the shared state into the root loading, error, and not-found boundaries", () => {
    expect(appLoading).toContain('variant="loading"');
    expect(appError).toContain('variant="error"');
    expect(appError).toContain("reset");
    expect(appNotFound).toContain('variant="not-found"');
  });
});
