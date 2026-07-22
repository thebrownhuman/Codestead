import { describe, expect, it, vi } from "vitest";

import type { ProductionLoadExecutionConfig } from "./production-load-config";
import type { ProductionLoadControlClient } from "./production-load-control";
import type {
  ApprovedProductionLoadDecisionArtifact,
  ProductionLoadTerminalReceipt,
} from "./production-load-evidence";
import type { ProductionFaultMatrixResult } from "./production-load-faults";
import type {
  BuildProductionLoadGateReportInput,
  ProductionLoadGateReport,
} from "./production-load-reporting";
import type {
  ProductionLoadClock,
  ProductionLoadWorkloadAdapter,
  ProductionLoadWorkloadResult,
} from "./production-load-workload";
import { runProductionLoadGate } from "./production-load-orchestrator";

const activeRelease = [
  "SCHEMA_VERSION=1",
  `GIT_COMMIT=${"1".repeat(40)}`,
  `GIT_TREE=${"2".repeat(40)}`,
  `RELEASE_MANIFEST_SHA256=${"3".repeat(64)}`,
  `APPLICATION_IMAGE_RECORD_SHA256=${"4".repeat(64)}`,
  "COMPOSE_PROJECT=learncoding",
  "COMPOSE_WORKDIR=/opt/learncoding",
  "PUBLIC_ORIGIN=https://learn.example.test",
  `MANAGED_INVENTORY_SHA256=${"5".repeat(64)}`,
  `FIREWALL_POLICY_SHA256=${"6".repeat(64)}`,
  `RUNNER_GUEST_RELEASE_SHA256=${"7".repeat(64)}`,
  `RUNNER_RUNTIME_IMAGES_SHA256=${"8".repeat(64)}`,
  "",
].join("\n");

const config: ProductionLoadExecutionConfig = {
  mode: "production",
  allowRemote: true,
  baseUrl: new URL("https://learn.example.test/"),
  scope: "codestead-project-only",
  project: "learncoding",
  disposableFaultsConfirmed: true,
  datasetId: "seed-20260715",
  repositoryRoot: "/repo",
  evidenceRoot: "/evidence",
  activeReleasePath: "/release/active-release.env",
  controlSocket: "/run/learncoding/load-control.sock",
  reportPath: "/evidence/load-gate-report.json",
  nucHostId: "nuc-host-001",
  runnerVmId: "123e4567-e89b-42d3-a456-426614174000",
};

const workload = {
  startedAt: "2026-07-15T00:00:00.000Z",
  completedAt: "2026-07-15T01:20:00.000Z",
  actions: [],
  resourceSamples: [],
  observedSustainedTotals: {
    lessonReads: 1_200,
    dashboardReads: 600,
    reviewQuizCompletions: 600,
    autosaves: 1_200,
    codeJobs: 200,
  },
  abort: { aborted: false },
} satisfies ProductionLoadWorkloadResult;

const faults = {
  scope: "codestead-project-only",
  startedAt: "2026-07-15T01:20:00.000Z",
  completedAt: "2026-07-15T03:20:00.000Z",
  cases: [],
} satisfies ProductionFaultMatrixResult;

const baseline = {
  oomKills: 0,
  thermalThrottleIncrements: 0,
  postgresDeadlocks: 0,
};

function harness(verdict: "PASS" | "FAIL" = "PASS") {
  const calls: string[] = [];
  const decision = {
    path: "/evidence/load-gate-decision.json",
    byteLength: 1024,
    sha256: "9".repeat(64),
    decision: {} as ApprovedProductionLoadDecisionArtifact["decision"],
  } satisfies ApprovedProductionLoadDecisionArtifact;
  const report = { verdict } as ProductionLoadGateReport;
  const control = {
    captureBaseline: vi.fn(async () => {
      calls.push("baseline");
      return baseline;
    }),
  } as unknown as ProductionLoadControlClient;
  const dependencies = {
    readActiveRelease: vi.fn(async () => {
      calls.push("active-release");
      return activeRelease;
    }),
    readDecision: vi.fn(async () => {
      calls.push("decision");
      return decision;
    }),
    assertDecisionUnchanged: vi.fn(async () => {
      calls.push("decision-unchanged");
    }),
    runWorkload: vi.fn<() => Promise<ProductionLoadWorkloadResult>>(async () => {
      calls.push("workload");
      return workload;
    }),
    runFaultMatrix: vi.fn(async () => {
      calls.push("faults");
      return faults;
    }),
    buildReport: vi.fn((input: BuildProductionLoadGateReportInput) => {
      void input;
      calls.push("report");
      return report;
    }),
    writeReport: vi.fn(async () => {
      calls.push("publish");
      return {
        path: config.reportPath,
        byteLength: 2048,
        sha256: "a".repeat(64),
      };
    }),
    writeTerminalReceipt: vi.fn(async (input: {
      readonly evidenceRoot: string;
      readonly receipt: ProductionLoadTerminalReceipt;
    }) => {
      calls.push("terminal");
      return {
        path: `${input.evidenceRoot}/load-gate-terminal.json`,
        byteLength: 1024,
        sha256: "b".repeat(64),
      };
    }),
  };
  return { calls, control, dependencies, decision, report };
}

const clock = {
  now: () => Date.parse("2026-07-15T03:20:01.000Z"),
  waitUntil: async () => undefined,
} satisfies ProductionLoadClock;

const adapter = {} as ProductionLoadWorkloadAdapter<never>;

describe("production load orchestrator", () => {
  it("binds approval to the active candidate and rechecks it before every mutating stage and publication", async () => {
    const fixture = harness();
    const result = await runProductionLoadGate({
      config,
      control: fixture.control,
      adapter,
      clock,
      dependencies: fixture.dependencies,
    });

    expect(fixture.calls).toEqual([
      "active-release",
      "decision",
      "decision-unchanged",
      "baseline",
      "decision-unchanged",
      "workload",
      "decision-unchanged",
      "faults",
      "decision-unchanged",
      "report",
      "decision-unchanged",
      "publish",
    ]);
    expect(result.verdict).toBe("PASS");
    expect(result.candidate.gitSha).toBe("1".repeat(40));
    expect(fixture.dependencies.readDecision).toHaveBeenCalledWith(expect.objectContaining({
      evidenceRoot: config.evidenceRoot,
      expectedCandidate: result.candidate,
    }));
    expect(fixture.dependencies.buildReport).toHaveBeenCalledWith(expect.objectContaining({
      decisionSha256: `sha256:${fixture.decision.sha256}`,
    }));
    expect(fixture.dependencies.buildReport.mock.calls[0]?.[0]).not.toHaveProperty(
      "secretLeakFindings",
    );
  });

  it("stops before approval or control activity when the configured target differs from the approved origin", async () => {
    const fixture = harness();
    const mismatchedConfig = {
      ...config,
      baseUrl: new URL("https://other.example.test/"),
    };

    await expect(runProductionLoadGate({
      config: mismatchedConfig,
      control: fixture.control,
      adapter,
      clock,
      dependencies: fixture.dependencies,
    })).rejects.toThrow(
      "Production load gate stopped at active_release (candidate_origin_mismatch).",
    );

    expect(fixture.calls).toEqual(["active-release", "terminal"]);
    expect(fixture.dependencies.readDecision).not.toHaveBeenCalled();
    expect(fixture.control.captureBaseline).not.toHaveBeenCalled();
    expect(fixture.dependencies.runWorkload).not.toHaveBeenCalled();
    expect(fixture.dependencies.runFaultMatrix).not.toHaveBeenCalled();
    expect(fixture.dependencies.writeTerminalReceipt).toHaveBeenCalledWith({
      evidenceRoot: mismatchedConfig.evidenceRoot,
      receipt: expect.objectContaining({
        status: "NOT_RUN",
        stage: "active_release",
        failureCode: "candidate_origin_mismatch",
        decisionSha256: null,
      }),
    });
  });

  it("publishes a completed FAIL verdict without converting it into a pass", async () => {
    const fixture = harness("FAIL");
    const result = await runProductionLoadGate({
      config,
      control: fixture.control,
      adapter,
      clock,
      dependencies: fixture.dependencies,
    });

    expect(result.verdict).toBe("FAIL");
    expect(fixture.dependencies.writeReport).toHaveBeenCalledOnce();
  });

  it("stops before the next stage when the immutable approval changes", async () => {
    const fixture = harness();
    fixture.dependencies.assertDecisionUnchanged
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("changed"));

    await expect(runProductionLoadGate({
      config,
      control: fixture.control,
      adapter,
      clock,
      dependencies: fixture.dependencies,
    })).rejects.toThrow("Production load gate stopped at approval (approval_changed).");
    expect(fixture.dependencies.runWorkload).not.toHaveBeenCalled();
    expect(fixture.dependencies.runFaultMatrix).not.toHaveBeenCalled();
    expect(fixture.dependencies.writeReport).not.toHaveBeenCalled();
    expect(fixture.dependencies.writeTerminalReceipt).toHaveBeenCalledWith({
      evidenceRoot: config.evidenceRoot,
      receipt: expect.objectContaining({
        status: "NOT_RUN",
        stage: "approval",
        failureCode: "approval_changed",
        decisionSha256: `sha256:${fixture.decision.sha256}`,
      }),
    });
  });

  it("publishes sanitized NOT_RUN evidence when approval is unavailable", async () => {
    const fixture = harness();
    fixture.dependencies.readDecision.mockRejectedValue(
      new Error("databaseUrl=postgresql://secret:secret@example.invalid/db"),
    );

    await expect(runProductionLoadGate({
      config,
      control: fixture.control,
      adapter,
      clock,
      dependencies: fixture.dependencies,
    })).rejects.toThrow("Production load gate stopped at approval (decision_unavailable).");
    expect(fixture.dependencies.writeTerminalReceipt).toHaveBeenCalledWith({
      evidenceRoot: config.evidenceRoot,
      receipt: expect.objectContaining({
        status: "NOT_RUN",
        stage: "approval",
        failureCode: "decision_unavailable",
        candidate: expect.objectContaining({ gitSha: "1".repeat(40) }),
        decisionSha256: null,
      }),
    });
    expect(JSON.stringify(fixture.dependencies.writeTerminalReceipt.mock.calls)).not.toContain("secret");
    expect(fixture.dependencies.runWorkload).not.toHaveBeenCalled();
  });

  it("aborts before every fault when the workload resource guard fires", async () => {
    const fixture = harness();
    fixture.dependencies.runWorkload.mockResolvedValue({
      ...workload,
      abort: {
        aborted: true,
        sampleIndex: 17,
        reason: "available_memory_below_8_gib_twice",
      },
    });

    await expect(runProductionLoadGate({
      config,
      control: fixture.control,
      adapter,
      clock,
      dependencies: fixture.dependencies,
    })).rejects.toThrow("Production load aborted: available_memory_below_8_gib_twice");
    expect(fixture.dependencies.runFaultMatrix).not.toHaveBeenCalled();
    expect(fixture.dependencies.buildReport).not.toHaveBeenCalled();
    expect(fixture.dependencies.writeReport).not.toHaveBeenCalled();
    expect(fixture.dependencies.writeTerminalReceipt).toHaveBeenCalledWith({
      evidenceRoot: config.evidenceRoot,
      receipt: expect.objectContaining({
        status: "FAIL",
        stage: "workload",
        failureCode: "available_memory_below_8_gib_twice",
        decisionSha256: `sha256:${fixture.decision.sha256}`,
      }),
    });
  });

  it("publishes FAIL terminal evidence when final report publication fails", async () => {
    const fixture = harness();
    fixture.dependencies.writeReport.mockRejectedValue(new Error("disk path contained secret material"));

    await expect(runProductionLoadGate({
      config,
      control: fixture.control,
      adapter,
      clock,
      dependencies: fixture.dependencies,
    })).rejects.toThrow("Production load gate stopped at publication (report_publication_failed).");
    expect(fixture.dependencies.writeTerminalReceipt).toHaveBeenCalledWith({
      evidenceRoot: config.evidenceRoot,
      receipt: expect.objectContaining({
        status: "FAIL",
        stage: "publication",
        failureCode: "report_publication_failed",
        decisionSha256: `sha256:${fixture.decision.sha256}`,
      }),
    });
    expect(JSON.stringify(fixture.dependencies.writeTerminalReceipt.mock.calls)).not.toContain("secret material");
  });
});
