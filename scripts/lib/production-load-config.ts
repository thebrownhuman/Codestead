import path from "node:path";

import { assertLoadTarget } from "../../src/lib/performance/load-report";

export type ProductionLoadExecutionConfig = {
  readonly mode: "production";
  readonly allowRemote: true;
  readonly baseUrl: URL;
  readonly scope: "codestead-project-only";
  readonly project: "learncoding";
  readonly disposableFaultsConfirmed: true;
  readonly datasetId: "seed-20260715";
  readonly repositoryRoot: string;
  readonly evidenceRoot: string;
  readonly activeReleasePath: string;
  readonly controlSocket: string;
  readonly reportPath: string;
  readonly nucHostId: string;
  readonly runnerVmId: string;
};

function fail(code: string): never {
  throw new Error(`Production load configuration failed: ${code}`);
}

function exact(
  environment: NodeJS.ProcessEnv,
  name: string,
  expected: string,
): string {
  const value = environment[name];
  if (value !== expected) fail(`invalid_${name.toLowerCase()}`);
  return value;
}

function absolutePath(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value || !path.isAbsolute(value)) fail(`invalid_${name.toLowerCase()}`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) fail(`unsafe_${name.toLowerCase()}`);
  return resolved;
}

function productionTarget(environment: NodeJS.ProcessEnv): URL {
  const raw = environment.LOAD_BASE_URL?.trim();
  if (!raw) fail("missing_load_base_url");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("invalid_load_base_url");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail("ambiguous_load_base_url");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    fail("load_base_url_must_be_origin");
  }
  let target: URL;
  try {
    target = assertLoadTarget(parsed.href, true);
  } catch {
    fail("unsafe_load_base_url");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (target.protocol !== "https:" && !loopback.has(target.hostname)) {
    fail("remote_load_target_requires_https");
  }
  target.pathname = "/";
  return target;
}

export function resolveProductionLoadConfig(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): ProductionLoadExecutionConfig {
  exact(environment, "LOAD_MODE", "production");
  exact(environment, "LOAD_ALLOW_REMOTE", "1");
  exact(environment, "LOAD_SCOPE", "codestead-project-only");
  exact(environment, "LOAD_PROJECT", "learncoding");
  exact(environment, "LOAD_DISPOSABLE_FAULTS_CONFIRMED", "1");
  if (environment.LOAD_COOKIE?.trim()) fail("load_cookie_forbidden");

  const evidenceRoot = absolutePath(environment, "LOAD_EVIDENCE_ROOT");
  const reportPath = path.join(evidenceRoot, "load-gate-report.json");
  if (environment.LOAD_REPORT_PATH !== undefined
    && path.resolve(environment.LOAD_REPORT_PATH) !== reportPath) {
    fail("load_report_path_must_match_evidence_root");
  }

  const nucHostId = environment.LOAD_NUC_HOST_ID?.trim() ?? "";
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/.test(nucHostId)) {
    fail("invalid_load_nuc_host_id");
  }
  const runnerVmId = environment.LOAD_RUNNER_VM_ID?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runnerVmId)) {
    fail("invalid_load_runner_vm_id");
  }

  return {
    mode: "production",
    allowRemote: true,
    baseUrl: productionTarget(environment),
    scope: "codestead-project-only",
    project: "learncoding",
    disposableFaultsConfirmed: true,
    datasetId: "seed-20260715",
    repositoryRoot: path.resolve(repositoryRoot),
    evidenceRoot,
    activeReleasePath: absolutePath(environment, "LOAD_ACTIVE_RELEASE_PATH"),
    controlSocket: absolutePath(environment, "LOAD_CONTROL_SOCKET"),
    reportPath,
    nucHostId,
    runnerVmId,
  };
}
