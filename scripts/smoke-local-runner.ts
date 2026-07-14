import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  RunnerClient,
  runtimeByLanguage,
  type RunnerLanguage,
} from "../src/lib/runner/client";
import { parseEnvText } from "../services/runner/src/local-launcher";

const rootEnvironment = parseEnvText(readFileSync(path.resolve(".env"), "utf8"));
const baseUrl = process.env.RUNNER_BASE_URL ?? rootEnvironment.RUNNER_BASE_URL ?? "http://127.0.0.1:4100";
const secret = process.env.RUNNER_SHARED_SECRET ?? rootEnvironment.RUNNER_SHARED_SECRET;
if (!secret) throw new Error("RUNNER_SHARED_SECRET is missing from the root .env.");

const fixtures: ReadonlyArray<{
  language: RunnerLanguage;
  source: string;
  expected: string;
  stdin?: string;
}> = [
  { language: "c", source: "#include <stdio.h>\nint main(void) { puts(\"smoke-c\"); return 0; }\n", expected: "smoke-c\n" },
  { language: "cpp", source: "#include <iostream>\nint main() { std::cout << \"smoke-cpp\\n\"; }\n", expected: "smoke-cpp\n" },
  { language: "java", source: "public class Main { public static void main(String[] args) { System.out.println(\"smoke-java\"); } }\n", expected: "smoke-java\n" },
  {
    language: "python",
    source: "left = int(input())\nright = int(input())\nprint(left + right)\n",
    stdin: "10\n20\n",
    expected: "30\n",
  },
  { language: "javascript", source: "console.log(\"smoke-javascript\");\n", expected: "smoke-javascript\n" },
];

async function main() {
  const client = new RunnerClient(baseUrl, secret);
  const health = await client.checkAvailability();
  if (!health.available) throw new Error(`Runner is ${health.status} (${health.code}).`);
  process.stdout.write(`runner healthy: ${health.activeJobs}/${health.concurrency} active, ${health.queueDepth} queued\n`);

  for (const fixture of fixtures) {
    const runtime = runtimeByLanguage[fixture.language];
    const requestId = randomUUID();
    const result = await client.submitAndWait({
      submissionId: randomUUID(),
      correlationId: randomUUID(),
      language: fixture.language,
      runtimeVersion: runtime.version,
      mode: "RUN",
      sourceFiles: [{ path: runtime.entrypoint, content: fixture.source }],
      entrypoint: runtime.entrypoint,
      ...(fixture.stdin === undefined ? {} : { stdin: fixture.stdin }),
      limits: {
        wallTimeMs: 10_000,
        memoryMb: 128,
        cpuCount: 0.5,
        pids: 32,
        outputBytes: 65_536,
        fileBytes: 16_777_216,
      },
    }, requestId, { timeoutMs: 60_000, pollMs: 200 });
    const stdout = result.result?.run?.stdout;
    if (result.state !== "COMPLETED" || result.result?.status !== "ACCEPTED" || stdout !== fixture.expected) {
      throw new Error(`${fixture.language} smoke failed with ${result.result?.status ?? result.error?.code ?? result.state}.`);
    }
    process.stdout.write(`${fixture.language}: accepted\n`);
  }
  process.stdout.write("all five local runner languages passed\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`Runner smoke failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
