import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import PlaygroundPage from "../page";

vi.mock("@/components/lesson/lesson-workspace", () => ({
  CodeLab: ({ runnerLabel }: { runnerLabel?: string }) => <div data-testid="code-lab">{runnerLabel}</div>,
}));

afterEach(() => vi.unstubAllEnvs());

describe("provider-aware playground", () => {
  it("shows Piston limits and passes the server-selected label to CodeLab", () => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "piston");
    render(<PlaygroundPage />);
    expect(screen.getByText("3 sec")).toBeInTheDocument();
    expect(screen.getByText("10 sec compile limit · 128 MiB practice memory")).toBeInTheDocument();
    expect(screen.getByTestId("code-lab")).toHaveTextContent("isolated Piston runner");
    expect(screen.queryByText(/two-slot NUC/)).not.toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("uses Piston presentation when the provider is unset", () => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "");
    render(<PlaygroundPage />);
    expect(screen.getByText("3 sec")).toBeInTheDocument();
    expect(screen.getByTestId("code-lab")).toHaveTextContent("isolated Piston runner");
    expect(screen.queryByText(/two-slot NUC/)).not.toBeInTheDocument();
  });

  it("rejects legacy presentation rather than advertising a usable native runner", () => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "legacy");
    expect(() => render(<PlaygroundPage />)).toThrow("legacy runner is retired");
  });

  it("keeps shared Piston limits aligned with deployment", async () => {
    const { PISTON_LIMITS } = await import("@/lib/runner/provider-config");
    const compose = readFileSync("compose.yaml", "utf8");
    for (const [name, value] of Object.entries({
      PISTON_RUN_TIMEOUT: PISTON_LIMITS.runTimeoutMs,
      PISTON_COMPILE_TIMEOUT: PISTON_LIMITS.compileTimeoutMs,
      PISTON_RUN_MEMORY_LIMIT: PISTON_LIMITS.runMemoryBytes,
      PISTON_MAX_CONCURRENT_JOBS: PISTON_LIMITS.concurrentJobs,
    })) expect(compose).toContain(`${name}: "${value}"`);
  });
});
