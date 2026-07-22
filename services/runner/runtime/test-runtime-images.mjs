import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveLocalImageIdentity, validateLocalBuildIdentityRecord } from "./runtime-operations.mjs";

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));

const repository = process.env.RUNTIME_REPOSITORY ?? "learncoding/runtime";
const release = process.env.RUNTIME_RELEASE ?? "local";
const configuredImages = {
  c: process.env.RUNNER_TEST_IMAGE_C ?? `${repository}-c:${release}`,
  cpp: process.env.RUNNER_TEST_IMAGE_CPP ?? `${repository}-cpp:${release}`,
  java: process.env.RUNNER_TEST_IMAGE_JAVA ?? `${repository}-java:${release}`,
  python: process.env.RUNNER_TEST_IMAGE_PYTHON ?? `${repository}-python:${release}`,
  javascript: process.env.RUNNER_TEST_IMAGE_JAVASCRIPT ?? `${repository}-javascript:${release}`,
};
const localBuildIdentities = validateLocalBuildIdentityRecord(
  readFileSync(path.join(path.dirname(runtimeRoot), "dist", "runtime-local-build-identities.json"), "utf8"),
  Object.keys(configuredImages).map((language) => ({
    language,
    tag: `${repository}-${language}:${release}`,
  })),
);

function inspectImage(reference) {
  const inspected = spawnSync("docker", [
    "image", "inspect", "--platform", "linux/amd64", reference,
  ], { encoding: "utf8" });
  if (inspected.error || inspected.status !== 0) {
    throw new Error(`Local runtime image is missing: ${reference}`);
  }
  const images = JSON.parse(inspected.stdout);
  if (!Array.isArray(images) || images.length !== 1 || !images[0] || typeof images[0] !== "object") {
    throw new Error(`Docker returned an invalid image inspection: ${reference}`);
  }
  return images[0];
}

function immutableLocalReference(language, configuredReference) {
  const at = configuredReference.lastIndexOf("@");
  const withoutDigest = at >= 0 ? configuredReference.slice(0, at) : configuredReference;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  const repositoryName = colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
  const identity = resolveLocalImageIdentity({
    language,
    tag: configuredReference,
    repository: repositoryName,
    inspectImage,
    expectedIdentity: {
      manifestDigest: localBuildIdentities[language].manifestDigest,
      configDigest: localBuildIdentities[language].configDigest,
    },
  });
  if (at >= 0 && configuredReference.slice(at + 1) !== identity.manifestDigest) {
    throw new Error(`Configured runtime reference is stale for ${language}: ${configuredReference}`);
  }
  return identity.imageReference;
}

const images = Object.fromEntries(
  Object.entries(configuredImages).map(([language, reference]) => [language, immutableLocalReference(language, reference)]),
);

const fixtures = {
  c: {
    entrypoint: "main.c",
    valid: "#include <stdio.h>\n#include <string.h>\nint main(void){char s[80]={0};fgets(s,sizeof s,stdin);s[strcspn(s,\"\\r\\n\")]=0;printf(\"ok:%s\\n\",s);return 0;}\n",
    invalid: "int main( { return 0; }\n",
  },
  cpp: {
    entrypoint: "main.cpp",
    valid: "#include <iostream>\n#include <string>\nint main(){std::string s;std::getline(std::cin,s);std::cout<<\"ok:\"<<s<<'\\n';}\n",
    invalid: "int main( { return 0; }\n",
  },
  java: {
    entrypoint: "Main.java",
    valid: "import java.io.*; public class Main { public static void main(String[] a) throws Exception { var r=new BufferedReader(new InputStreamReader(System.in)); System.out.println(\"ok:\"+r.readLine()); } }\n",
    invalid: "public class Main { syntax error }\n",
  },
  python: {
    entrypoint: "main.py",
    valid: "print('ok:' + input())\n",
    invalid: "def broken(:\n  pass\n",
  },
  javascript: {
    entrypoint: "main.js",
    valid: "const fs=require('node:fs'); console.log('ok:'+fs.readFileSync(0,'utf8').trim());\n",
    invalid: "function broken( {\n",
  },
};

function cleanupContainer(name) {
  spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
}

async function execute(language, source, options = {}) {
  const fixture = fixtures[language];
  const directory = mkdtempSync(path.join(os.tmpdir(), `lc-runtime-${language}-`));
  const entrypoint = options.entrypoint ?? fixture.entrypoint;
  const file = path.join(directory, entrypoint);
  writeFileSync(file, source, { encoding: "utf8", mode: 0o444 });
  try { chmodSync(directory, 0o755); chmodSync(file, 0o444); } catch { /* Windows bind permissions are VM-managed. */ }
  const name = `lc-contract-${language}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const mode = options.mode ?? "run";
  const args = [
    "run", "--rm", "--interactive", "--name", name, "--pull", "never", "--network", "none",
    "--ipc", "none", "--log-driver", "none", "--read-only", "--init",
    "--stop-timeout", "1", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", "32", "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5",
    "--ulimit", "fsize=16777216:16777216", "--ulimit", "nofile=64:64",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700",
    "--tmpfs", "/work:rw,exec,nosuid,nodev,size=16777216,uid=65532,gid=65532,mode=0700",
    "--user", "65532:65532", "--env", "HOME=/tmp", "--workdir", "/work",
    ...(options.environment ?? []).flatMap((value) => ["--env", value]),
    "--mount", `type=bind,src=${directory},dst=/input,readonly`,
    images[language], "/opt/runner/execute", "--mode", mode, "--language", language,
    "--source-root", "/input", "--entrypoint", `/input/${entrypoint}`,
  ];
  const maximumOutput = options.maximumOutput ?? 64 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let settled = false;
    const stop = (reason) => {
      if (reason === "timeout") timedOut = true;
      else outputLimited = true;
      child.kill("SIGKILL");
      cleanupContainer(name);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const capture = (target, chunk) => {
      const remaining = maximumOutput - bytes;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > maximumOutput && !outputLimited) stop("output");
    };
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupContainer(name);
      rmSync(directory, { recursive: true, force: true });
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupContainer(name);
      rmSync(directory, { recursive: true, force: true });
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputLimited,
      });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const results = [];
async function contract(name, operation) {
  const started = Date.now();
  try {
    await operation();
    results.push({ name, status: "passed", durationMs: Date.now() - started });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    results.push({ name, status: "failed", durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    process.stderr.write(`FAIL ${name}: ${error instanceof Error ? error.message : error}\n`);
  }
}

for (const [language, fixture] of Object.entries(fixtures)) {
  await contract(`${language}: compile and run`, async () => {
    const compiled = await execute(language, fixture.valid, { mode: "compile" });
    check(compiled.code === 0 && !compiled.timedOut, `${language} valid source did not compile: ${compiled.stderr}`);
    const ran = await execute(language, fixture.valid, { stdin: "buddy\n" });
    check(ran.code === 0, `${language} valid source did not run: ${ran.stderr}`);
    check(ran.stdout.trim() === "ok:buddy", `${language} stdout contract mismatch: ${ran.stdout}`);
  });
  await contract(`${language}: compile error`, async () => {
    const result = await execute(language, fixture.invalid, { mode: "compile" });
    check(result.code !== 0 && result.code !== 125 && result.code !== 126 && result.code !== 127, `${language} compile error was not classified as learner failure (${result.code}).`);
    check(result.stderr.length > 0, `${language} compile error emitted no diagnostic.`);
  });
}

await contract("python: read-only root and writable ephemeral work", async () => {
  const source = "from pathlib import Path\ntry:\n Path('/forbidden').write_text('x')\n print('ROOT_WRITABLE')\nexcept OSError:\n Path('/work/allowed').write_text('ok')\n print('ROOT_BLOCKED_WORK_OK')\n";
  const result = await execute("python", source);
  check(result.code === 0 && result.stdout.trim() === "ROOT_BLOCKED_WORK_OK", `filesystem isolation failed: ${result.stdout} ${result.stderr}`);
});

await contract("python: network egress blocked", async () => {
  const source = "import socket\ns=socket.socket();s.settimeout(.5)\ntry:\n s.connect(('1.1.1.1',53));print('NETWORK_OPEN')\nexcept OSError:\n print('NETWORK_BLOCKED')\n";
  const result = await execute("python", source);
  check(result.code === 0 && result.stdout.trim() === "NETWORK_BLOCKED", `network isolation failed: ${result.stdout}`);
});

await contract("python: hidden environment absent", async () => {
  const marker = "HIDDEN_EXPECTED_DO_NOT_EXPOSE_7f31";
  const result = await execute("python", "import os\nprint(os.getenv('HIDDEN_EXPECTED_VALUE','ABSENT'))\n", {
    environment: [`HIDDEN_EXPECTED_VALUE=${marker}`],
  });
  check(result.code === 0 && result.stdout.trim() === "ABSENT", "controlled child environment leaked a hidden value");
  check(!`${result.stdout}${result.stderr}`.includes(marker), "hidden marker appeared in output");
});

await contract("python: cross-job work cleanup", async () => {
  const first = await execute("python", "from pathlib import Path\nPath('/work/cross-job').write_text('secret')\nprint('WROTE')\n");
  check(first.code === 0, "first cleanup fixture failed");
  const second = await execute("python", "from pathlib import Path\nprint('DIRTY' if Path('/work/cross-job').exists() else 'CLEAN')\n");
  check(second.code === 0 && second.stdout.trim() === "CLEAN", "work tmpfs persisted across jobs");
});

await contract("python: wall timeout", async () => {
  const result = await execute("python", "while True: pass\n", { timeoutMs: 1_200 });
  check(result.timedOut, "infinite loop was not terminated by the wall-time supervisor");
});

await contract("python: combined output cap", async () => {
  const result = await execute("python", "while True: print('x'*1024, flush=True)\n", {
    timeoutMs: 5_000,
    maximumOutput: 8_192,
  });
  check(result.outputLimited, "unbounded output was not terminated at the configured cap");
  check(Buffer.byteLength(result.stdout) <= 8_192, "captured output exceeded the configured cap");
});

await contract("python: process limit", async () => {
  const source = "import os,time,signal\nchildren=[];limited=False\nfor _ in range(80):\n try:\n  p=os.fork()\n except OSError:\n  limited=True;break\n if p==0:\n  time.sleep(3);os._exit(0)\n children.append(p)\nfor p in children:\n try: os.kill(p,signal.SIGKILL)\n except ProcessLookupError: pass\nfor p in children:\n try: os.waitpid(p,0)\n except ChildProcessError: pass\nprint('LIMITED' if limited else 'UNEXPECTED')\n";
  const result = await execute("python", source, { timeoutMs: 10_000 });
  check(result.code === 0 && result.stdout.trim() === "LIMITED", `PID limit did not engage: ${result.stdout} ${result.stderr}`);
});

const failed = results.filter((result) => result.status === "failed");
const reportDirectory = path.join(path.dirname(runtimeRoot), "dist");
try {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(
    path.join(reportDirectory, "runtime-contract-report.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), images, results }, null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(`warning: could not write runtime contract report: ${error instanceof Error ? error.message : error}\n`);
}
process.stdout.write(`${JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length }, null, 2)}\n`);
if (failed.length) process.exitCode = 1;
