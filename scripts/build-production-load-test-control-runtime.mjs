import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "infra", "runtime");
const outputPath = path.join(
  outputDirectory,
  "production-load-test-control-service.mjs",
);

await mkdir(outputDirectory, { recursive: true });
await build({
  absWorkingDir: repositoryRoot,
  entryPoints: ["scripts/start-production-load-test-control-service.ts"],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  charset: "ascii",
  legalComments: "none",
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: "silent",
});

const bytes = await readFile(outputPath);
if (bytes.byteLength < 1_024
  || bytes.includes(Buffer.from(repositoryRoot, "utf8"))
  || bytes.includes(Buffer.from("sourceMappingURL=", "ascii"))) {
  throw new Error("Production load test-control bundle failed deterministic validation.");
}
const digest = createHash("sha256").update(bytes).digest("hex");
process.stdout.write(
  `production load test-control bundle built: sha256=${digest} bytes=${bytes.byteLength}\n`,
);
