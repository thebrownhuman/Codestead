import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const runbook = readFileSync(
  path.join(process.cwd(), "docs/runbooks/runner-isolation.md"),
  "utf8",
);

describe("runner isolation quarantine runbook contract", () => {
  it("keeps hostile execution on the dedicated VM and freezes every runner-capable trusted service", () => {
    expect(runbook).toContain("dedicated isolated runner VM, never on the trusted NUC");
    expect(runbook).toContain(
      "docker compose stop cloudflared app regrade-worker exam-finalization-worker practice-runner-recovery-worker",
    );
    expect(runbook).toContain("systemctl reboot");
    expect(runbook).toContain("runner_service_active=true");
    expect(runbook).toContain("administrator-only maintenance Access policy");
    expect(runbook).toContain("docker compose up -d app");
    expect(runbook).toContain("Run only after the administrator-only maintenance Access policy is verified");
  });

  it("requires independent zero-queue health, signed metrics, and journal projections", () => {
    expect(runbook).toContain(
      '.queueDepth == 0 and .activeJobs == 0 and .concurrency == 2',
    );
    expect(runbook).toContain("RUNNER_URL=http://192.168.122.12:4100");
    expect(runbook).not.toContain("RUNNER_URL=http://10.20.0.12:4100");
    expect(runbook).toContain('fetch(`${process.env.RUNNER_URL}/metrics`');
    expect(runbook).toContain('gauge("runner_queue_depth") === 0');
    expect(runbook).toContain('gauge("runner_active_jobs") === 0');
    expect(runbook).toContain("runner_health_idle=true");
    expect(runbook).toContain("runner_metrics_idle=true");
    expect(runbook).toContain("activeJobCount");
    expect(runbook).toContain("remoteJobIdMatchCount");
    expect(runbook).toContain("idempotencyKeyMatchCount");
    expect(runbook).toContain("sameBindingMatchCount");
    expect(runbook).toContain("allSuppliedIdentifiersMatch");
  });

  it("forbids journal disclosure or repair and gates resolution on fresh MFA plus both attestations", () => {
    expect(runbook).toContain("Never hand-edit the JSON");
    expect(runbook).toContain("Never print, copy, upload, or move the journal");
    expect(runbook).toMatch(/complete fresh MFA/i);
    expect(runbook).toContain("isolatedRunnerRestarted=true");
    expect(runbook).toContain("journalReconciled=true");
    expect(runbook).toContain("officialEvidenceChanged=false");
    expect(runbook).toContain("RECOVERY_QUARANTINED");
    expect(runbook).toContain("runner.practice.quarantine.resolve");
    expect(runbook).not.toMatch(
      /^\s*(?:sudo\s+)?(?:cat|less|more|head|tail)\s+.*runner-state-v1\.json/m,
    );
    expect(runbook).not.toMatch(/^\s*(?:sudo\s+)?[^\n]*jq\s+['"]?\.['"]?\s+.*runner-state-v1\.json/m);
  });

  it("documents automatic pre-dispatch, backoff, quarantine, and bounded evidence semantics", () => {
    expect(runbook).toContain("PRACTICE_PRE_DISPATCH_STALE");
    expect(runbook).toContain("original `runnerRequestId` as its remote idempotency key");
    expect(runbook).toContain("`retry_wait` with exponential delay");
    expect(runbook).toContain("becomes `quarantined`, receives no automatic retry");
    expect(runbook).toContain("`remoteRunnerJobId` when one was durably received");
    expect(runbook).toContain("It does not expose source, stdin, response streams, hidden tests, or request hashes");
  });

  it("provides exact immutable package transfer, install, and rollback commands", () => {
    expect(runbook).toContain("RUNNER_GUEST='codestead-admin@192.168.122.12'");
    expect(runbook).toContain("RUNNER_PACKAGE_REPORT=/var/lib/learncoding/runner-releases/package-report.json");
    expect(runbook).toContain("tar --create --file=-");
    expect(runbook).toContain("verify-release-tree.py");
    expect(runbook).toContain('RUNNER_RELEASE_MANIFEST_SHA256="$RUNNER_MANIFEST_SHA256"');
    expect(runbook).toContain("/opt/learncoding/infra/runner-vm/install-guest.sh");
    expect(runbook).toContain("RUNNER_PREVIOUS=/opt/learncoding.previous.");
    expect(runbook).toContain("systemctl stop learncoding-runner.service");
    expect(runbook).toContain("keep code execution disabled");
    expect(runbook).not.toContain("virsh undefine --remove-all-storage");
    expect(runbook).not.toContain("docker compose down -v");
    expect(runbook).not.toContain("git reset --hard");
  });
});
