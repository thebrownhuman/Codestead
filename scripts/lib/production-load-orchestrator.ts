import {
  buildProductionLoadCandidateFromActiveRelease,
  type ProductionLoadCandidate,
} from "../../src/lib/performance/load-report";
import type { ProductionLoadExecutionConfig } from "./production-load-config";
import type { ProductionLoadControlClient } from "./production-load-control";
import type {
  ApprovedProductionLoadDecisionArtifact,
  ProductionLoadReportArtifact,
  ProductionLoadTerminalReceipt,
  ReadProductionLoadDecisionOptions,
} from "./production-load-evidence";
import type {
  ProductionFaultMatrixResult,
  RunProductionFaultMatrixInput,
} from "./production-load-faults";
import type {
  BuildProductionLoadGateReportInput,
  ProductionLoadGateReport,
} from "./production-load-reporting";
import type {
  ProductionLoadClock,
  ProductionLoadWorkloadAdapter,
  ProductionLoadWorkloadResult,
  RunProductionLoadWorkloadInput,
} from "./production-load-workload";

export type ProductionLoadOrchestratorDependencies<Session> = {
  readActiveRelease(path: string): Promise<string>;
  readDecision(
    options: ReadProductionLoadDecisionOptions,
  ): Promise<ApprovedProductionLoadDecisionArtifact>;
  assertDecisionUnchanged(
    artifact: ApprovedProductionLoadDecisionArtifact,
    options: ReadProductionLoadDecisionOptions,
  ): Promise<void>;
  runWorkload(
    input: RunProductionLoadWorkloadInput<Session>,
  ): Promise<ProductionLoadWorkloadResult>;
  runFaultMatrix(
    input: RunProductionFaultMatrixInput,
  ): Promise<ProductionFaultMatrixResult>;
  buildReport(input: BuildProductionLoadGateReportInput): ProductionLoadGateReport;
  writeReport(input: {
    readonly evidenceRoot: string;
    readonly report: unknown;
  }): Promise<ProductionLoadReportArtifact>;
  writeTerminalReceipt(input: {
    readonly evidenceRoot: string;
    readonly receipt: ProductionLoadTerminalReceipt;
  }): Promise<ProductionLoadReportArtifact>;
};

export type RunProductionLoadGateInput<Session> = {
  readonly config: ProductionLoadExecutionConfig;
  readonly control: ProductionLoadControlClient;
  readonly adapter: ProductionLoadWorkloadAdapter<Session>;
  readonly clock: ProductionLoadClock;
  readonly dependencies: ProductionLoadOrchestratorDependencies<Session>;
};

export type ProductionLoadGateExecution = {
  readonly verdict: "PASS" | "FAIL";
  readonly candidate: ProductionLoadCandidate;
  readonly report: ProductionLoadGateReport;
  readonly artifact: ProductionLoadReportArtifact;
};

type TerminalStatus = ProductionLoadTerminalReceipt["status"];
type TerminalStage = ProductionLoadTerminalReceipt["stage"];

function terminalTimestamp(clock: ProductionLoadClock): string {
  const value = clock.now();
  return new Date(Number.isSafeInteger(value) && value >= 0 ? value : Date.now()).toISOString();
}

async function stopProductionLoadGate<Session>(input: {
  readonly gate: RunProductionLoadGateInput<Session>;
  readonly status: TerminalStatus;
  readonly stage: TerminalStage;
  readonly failureCode: string;
  readonly candidate: ProductionLoadCandidate | null;
  readonly decision: ApprovedProductionLoadDecisionArtifact | null;
  readonly throwMessage?: string;
}): Promise<never> {
  const message = input.throwMessage ?? `Production load gate stopped at ${input.stage} (${input.failureCode}).`;
  try {
    await input.gate.dependencies.writeTerminalReceipt({
      evidenceRoot: input.gate.config.evidenceRoot,
      receipt: {
        schemaVersion: 1,
        generatedAt: terminalTimestamp(input.gate.clock),
        status: input.status,
        stage: input.stage,
        failureCode: input.failureCode,
        candidate: input.candidate,
        decisionSha256: input.decision ? `sha256:${input.decision.sha256}` : null,
      },
    });
  } catch {
    throw new Error(`${message} Terminal evidence publication also failed.`);
  }
  throw new Error(message);
}

export async function runProductionLoadGate<Session>(
  input: RunProductionLoadGateInput<Session>,
): Promise<ProductionLoadGateExecution> {
  let activeReleaseText: string;
  let candidate: ProductionLoadCandidate | null = null;
  let decision: ApprovedProductionLoadDecisionArtifact | null = null;
  try {
    activeReleaseText = await input.dependencies.readActiveRelease(
      input.config.activeReleasePath,
    );
    candidate = buildProductionLoadCandidateFromActiveRelease(
      activeReleaseText,
      input.config.nucHostId,
      input.config.runnerVmId,
    );
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "NOT_RUN",
      stage: "active_release",
      failureCode: "active_release_invalid",
      candidate,
      decision,
    });
  }

  if (input.config.baseUrl.origin !== candidate.publicOrigin) {
    return stopProductionLoadGate({
      gate: input,
      status: "NOT_RUN",
      stage: "active_release",
      failureCode: "candidate_origin_mismatch",
      candidate,
      decision,
    });
  }

  const decisionOptions: ReadProductionLoadDecisionOptions = {
    evidenceRoot: input.config.evidenceRoot,
    expectedCandidate: candidate,
  };
  try {
    decision = await input.dependencies.readDecision(decisionOptions);
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "NOT_RUN",
      stage: "approval",
      failureCode: "decision_unavailable",
      candidate,
      decision,
    });
  }

  try {
    await input.dependencies.assertDecisionUnchanged(decision, decisionOptions);
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "NOT_RUN",
      stage: "approval",
      failureCode: "approval_changed",
      candidate,
      decision,
    });
  }

  let baseline: Awaited<ReturnType<ProductionLoadControlClient["captureBaseline"]>>;
  try {
    baseline = await input.control.captureBaseline();
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "NOT_RUN",
      stage: "baseline",
      failureCode: "baseline_capture_failed",
      candidate,
      decision,
    });
  }

  try {
    await input.dependencies.assertDecisionUnchanged(decision, decisionOptions);
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "NOT_RUN",
      stage: "approval",
      failureCode: "approval_changed",
      candidate,
      decision,
    });
  }

  let workload: ProductionLoadWorkloadResult;
  try {
    workload = await input.dependencies.runWorkload({
      clock: input.clock,
      baseline,
      adapter: input.adapter,
    });
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "FAIL",
      stage: "workload",
      failureCode: "workload_execution_failed",
      candidate,
      decision,
    });
  }
  if (workload.abort.aborted) {
    const reason = /^[a-z0-9_]{3,80}$/.test(workload.abort.reason)
      ? workload.abort.reason
      : "invalid_abort_reason";
    return stopProductionLoadGate({
      gate: input,
      status: "FAIL",
      stage: "workload",
      failureCode: reason,
      candidate,
      decision,
      throwMessage: `Production load aborted: ${reason}`,
    });
  }

  try {
    await input.dependencies.assertDecisionUnchanged(decision, decisionOptions);
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "FAIL",
      stage: "approval",
      failureCode: "approval_changed_after_workload",
      candidate,
      decision,
    });
  }

  let faults: ProductionFaultMatrixResult;
  try {
    faults = await input.dependencies.runFaultMatrix({
      scope: input.config.scope,
      clock: input.clock,
      adapter: input.control,
    });
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "FAIL",
      stage: "fault_matrix",
      failureCode: "fault_matrix_failed",
      candidate,
      decision,
    });
  }

  try {
    await input.dependencies.assertDecisionUnchanged(decision, decisionOptions);
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "FAIL",
      stage: "approval",
      failureCode: "approval_changed_after_faults",
      candidate,
      decision,
    });
  }

  let report: ProductionLoadGateReport;
  try {
    const generatedAtMs = input.clock.now();
    if (!Number.isSafeInteger(generatedAtMs) || generatedAtMs < 0) {
      throw new Error("invalid clock");
    }
    report = input.dependencies.buildReport({
      generatedAt: new Date(generatedAtMs).toISOString(),
      decisionSha256: `sha256:${decision.sha256}`,
      candidate,
      baseline,
      workload,
      faults,
    });
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "FAIL",
      stage: "report",
      failureCode: "report_build_failed",
      candidate,
      decision,
    });
  }

  try {
    await input.dependencies.assertDecisionUnchanged(decision, decisionOptions);
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "FAIL",
      stage: "approval",
      failureCode: "approval_changed_before_publication",
      candidate,
      decision,
    });
  }

  let artifact: ProductionLoadReportArtifact;
  try {
    artifact = await input.dependencies.writeReport({
      evidenceRoot: input.config.evidenceRoot,
      report,
    });
  } catch {
    return stopProductionLoadGate({
      gate: input,
      status: "FAIL",
      stage: "publication",
      failureCode: "report_publication_failed",
      candidate,
      decision,
    });
  }
  if (artifact.path !== input.config.reportPath) {
    return stopProductionLoadGate({
      gate: input,
      status: "FAIL",
      stage: "publication",
      failureCode: "unexpected_report_path",
      candidate,
      decision,
    });
  }

  return {
    verdict: report.verdict,
    candidate,
    report,
    artifact,
  };
}
