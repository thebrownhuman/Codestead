import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());
const source = (file: string) => readFileSync(resolve(ROOT, file), "utf8");

function composeService(compose: string, name: string, nextName: string) {
  const start = compose.indexOf(`  ${name}:`);
  const end = compose.indexOf(`\n  ${nextName}:`, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return compose.slice(start, end);
}

describe("production durable object-root provisioning", () => {
  it("provisions and re-verifies the exact root/marker identity before runtime validation", () => {
    const preparer = source("infra/ops/prepare-object-storage.mjs");
    const runtime = source("infra/ops/validate-runtime.sh");
    expect(preparer).toContain('const MARKER_NAME = ".codestead-object-root-v1"');
    expect(preparer).toContain('const MARKER_CONTENT = "codestead-object-storage-v1\\n"');
    expect(preparer).toContain("process.platform !== \"linux\"");
    expect(preparer).toContain("process.getuid?.() !== 0");
    expect(preparer).toContain("const WRITER_UID = 1000");
    expect(preparer).toContain("const WRITER_GID = 1000");
    expect(preparer).toContain("0o1770");
    expect(preparer).toContain("const APP_DATA_MODE = 0o750");
    expect(preparer).toContain('await ensureDirectory(dataRootHandle, "app-data", 0, 0, APP_DATA_MODE)');
    expect(preparer).toContain('await ensureDirectory(appDataHandle, "objects", 0, WRITER_GID, OBJECT_ROOT_MODE)');
    expect(preparer).toContain("`/proc/self/fd/${parentHandle.fd}`");
    expect(preparer).toContain("dataRootEntry.dev !== dataRootOpened.dev");
    expect(preparer).toContain("DATA_ROOT_MODE");
    expect(preparer).toContain("0o440");
    expect(preparer).toContain("constants.O_EXCL");
    expect(preparer).toContain("constants.O_NOFOLLOW");
    expect(preparer).toContain("await markerHandle.sync()");
    expect(preparer).toContain("await objectRootHandle.sync()");
    expect(preparer).toContain("markerEntry.nlink !== 1");
    expect(preparer).toContain("rootEntry.dev !== markerEntry.dev");

    const syntax = spawnSync(process.execPath, ["--check", resolve(ROOT, "infra/ops/prepare-object-storage.mjs")], {
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);

    const unit = source("infra/systemd/learncoding-compose.service");
    const execStartLines = unit.match(/^ExecStart=.*$/gmu) ?? [];
    expect(execStartLines).toEqual([
      "ExecStart=/usr/bin/env PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/bash /opt/learncoding/infra/ops/start-production-stack.sh --startup-wait 600",
    ]);
    expect(unit).not.toMatch(/^ExecStartPre=/mu);
    expect(unit).not.toMatch(/^ExecStartPost=/mu);

    const guardedStart = source("infra/ops/start-production-stack.sh");
    const prePrivilegedValidate = guardedStart.indexOf(
      'run_with_deadline 120 "$bash_bin" "$validator" --pre-privileged',
    );
    const prepare = guardedStart.indexOf(
      "NODE_OPTIONS='' run_with_deadline 120 \"$node_bin\" \"$object_preparer\"",
    );
    const validate = guardedStart.indexOf(
      'run_with_deadline 120 "$bash_bin" "$validator" ||',
    );
    const compose = guardedStart.indexOf(
      'run_with_deadline 120 "${compose[@]}" up -d',
    );
    expect(prePrivilegedValidate).toBeGreaterThan(-1);
    expect(prepare).toBeGreaterThan(prePrivilegedValidate);
    expect(validate).toBeGreaterThan(prepare);
    expect(compose).toBeGreaterThan(validate);

    const repositoryJavaScriptPositions = [
      runtime.indexOf('"$resolved_node_bin" "$application_image_record_verifier"'),
      runtime.indexOf('"$resolved_node_bin" "$database_secret_validator"'),
    ];
    for (const position of repositoryJavaScriptPositions) {
      expect(position).toBeGreaterThan(-1);
    }
    const firstRepositoryJavaScript = Math.min(...repositoryJavaScriptPositions);
    const earlyGuard = runtime.indexOf('if [[ "$pre_privileged" == true ]]');
    const earlyExit = runtime.indexOf("exit 0", earlyGuard);
    expect(earlyGuard).toBeGreaterThan(-1);
    expect(earlyExit).toBeGreaterThan(earlyGuard);
    expect(firstRepositoryJavaScript).toBeGreaterThan(earlyExit);
  });

  it("pins the dedicated objects source with service-specific least privilege", () => {
    const compose = source("compose.yaml");
    const app = composeService(compose, "app", "runner-egress-gateway");
    const scanner = composeService(compose, "scan-worker", "file-erasure-worker");
    const erasure = composeService(compose, "file-erasure-worker", "lifecycle");
    const lifecycle = composeService(compose, "lifecycle", "platform-seed");
    const writableNested = /source: \$\{LEARN_DATA_ROOT:-\/srv\/learncoding\}\/app-data\/objects\s+target: \/var\/lib\/learncoding\/objects\s+read_only: false/u;
    const readonlyNested = /source: \$\{LEARN_DATA_ROOT:-\/srv\/learncoding\}\/app-data\/objects\s+target: \/var\/lib\/learncoding\/objects\s+read_only: true/u;
    expect(app).toMatch(writableNested);
    expect(app).toContain('user: "1000:1000"');
    expect(scanner).toContain('user: "1000:1000"');
    expect(erasure).toContain('user: "1000:1000"');
    expect(lifecycle).toContain('user: "1000:1000"');
    expect(scanner).toMatch(readonlyNested);
    expect(erasure).toMatch(writableNested);
    expect(lifecycle).toMatch(writableNested);
    for (const service of [app, scanner, erasure, lifecycle]) {
      expect(service).not.toMatch(
        /source: \$\{LEARN_DATA_ROOT:-\/srv\/learncoding\}\/app-data\s+target: \/var\/lib\/learncoding(?:\s|$)/u,
      );
    }
  });

  it("keeps pilot mode explicit while documenting the full-mode root prerequisite", () => {
    expect(source("infra/env/compose.env.example")).toContain("UPLOADS_ENABLED=false");
    const runbook = source("docs/runbooks/upload-scanning.md");
    expect(runbook).toContain("prepare-object-storage.mjs");
    expect(runbook).toContain("root:1000");
    expect(runbook).toContain("01770");
    expect(runbook).toContain("0440");
  });
});
