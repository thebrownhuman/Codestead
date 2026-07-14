import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.dirname(runtimeRoot);
const release = process.env.RUNTIME_RELEASE ?? "local";
const repository = process.env.RUNTIME_REPOSITORY ?? "learncoding/runtime";

function readEnvironment(file) {
  const result = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid environment line: ${rawLine}`);
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

const pinned = readEnvironment(path.join(runtimeRoot, "images.env"));
const languages = [
  { id: "c", env: "C", expectedVersion: "14.2.0", tool: ["/usr/local/bin/gcc", "--version"] },
  { id: "cpp", env: "CPP", expectedVersion: "14.2.0", tool: ["/usr/local/bin/g++", "--version"] },
  { id: "java", env: "JAVA", expectedVersion: "21.0.11", tool: ["/opt/java/openjdk/bin/java", "-version"] },
  { id: "python", env: "PYTHON", expectedVersion: "3.14.6", tool: ["/usr/local/bin/python3", "--version"] },
  { id: "javascript", env: "JAVASCRIPT", expectedVersion: "22.23.1", tool: ["/usr/local/bin/node", "--version"] },
];

function pinnedPackages(name, { required = false } = {}) {
  const raw = pinned[name]?.trim() ?? "";
  if (required && !raw) throw new Error(`Missing pinned package set: ${name}.`);
  for (const specification of raw ? raw.split(/\s+/) : []) {
    if (!/^[a-z0-9][a-z0-9+_.-]*=[a-z0-9][a-z0-9+_.:~-]*$/i.test(specification)) {
      throw new Error(`Package must use an exact Alpine version in ${name}: ${specification}`);
    }
  }
  return raw;
}

function imageTag(language) {
  return `${repository}-${language.id}:${release}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? runnerRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} exited ${result.status}${details}`);
  }
  return options.capture
    ? options.includeStderr
      ? `${result.stdout}${result.stderr}`
      : result.stdout
    : "";
}

function commandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "ignore" });
  return !result.error && result.status === 0;
}

function build() {
  const publish = process.env.RUNTIME_PUSH === "1";
  if (publish && release === "local") throw new Error("RUNTIME_RELEASE must be immutable when pushing images.");
  const harnessPackages = pinnedPackages("HARNESS_BUILD_PACKAGES", { required: true });
  for (const language of languages) {
    const runtimeImage = pinned[`RUNTIME_BASE_${language.env}`];
    if (!runtimeImage?.includes("@sha256:")) throw new Error(`Missing pinned base for ${language.id}.`);
    const runtimePackages = pinnedPackages(`RUNTIME_PACKAGES_${language.env}`);
    run("docker", [
      "buildx", "build", "--platform", "linux/amd64",
      publish ? "--push" : "--load",
      "--provenance=mode=max", "--sbom=true",
      "--build-arg", `HARNESS_BUILD_IMAGE=${pinned.HARNESS_BUILD_IMAGE}`,
      "--build-arg", `HARNESS_BUILD_PACKAGES=${harnessPackages}`,
      "--build-arg", `RUNTIME_IMAGE=${runtimeImage}`,
      "--build-arg", `BASE_IMAGE_REFERENCE=${runtimeImage}`,
      "--build-arg", `RUNTIME_PACKAGES=${runtimePackages}`,
      "--build-arg", `EXPECTED_LANGUAGE=${language.id}`,
      "--build-arg", `EXPECTED_TOOL_VERSION=${language.expectedVersion}`,
      "--tag", imageTag(language),
      "--file", path.join(runtimeRoot, "Dockerfile"),
      runtimeRoot,
    ]);
  }
}

function inspectOne(language) {
  const tag = imageTag(language);
  const raw = JSON.parse(run("docker", ["image", "inspect", tag], { capture: true }))[0];
  if (raw.Config?.User !== "65532:65532") throw new Error(`${tag} does not default to UID/GID 65532.`);
  if ((raw.Config?.Entrypoint ?? []).length !== 0) throw new Error(`${tag} has a base-image entrypoint.`);
  if (raw.Config?.Labels?.["io.learncoding.runner.language"] !== language.id) {
    throw new Error(`${tag} has the wrong language label.`);
  }
  if (raw.Config?.Labels?.["io.learncoding.runner.packages"] !== pinnedPackages(`RUNTIME_PACKAGES_${language.env}`)) {
    throw new Error(`${tag} has the wrong pinned package label.`);
  }
  const description = JSON.parse(run("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", tag, "/opt/runner/execute", "--describe",
  ], { capture: true }));
  if (description.protocolVersion !== 1 || description.language !== language.id || description.shell !== false) {
    throw new Error(`${tag} returned an invalid harness description.`);
  }
  const version = run("docker", ["run", "--rm", "--network", "none", "--read-only", tag, ...language.tool], { capture: true, includeStderr: true }).trim();
  return {
    language: language.id,
    tag,
    imageId: raw.Id,
    base: raw.Config.Labels["io.learncoding.runner.base"],
    harness: description,
    version: version.split(/\r?\n/)[0],
  };
}

function inspect() {
  const report = languages.map(inspectOne);
  const output = path.join(runnerRoot, "dist", "runtime-inspection.json");
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), images: report }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function registryDigest(tag) {
  const raw = JSON.parse(run("docker", ["buildx", "imagetools", "inspect", tag, "--raw"], { capture: true }));
  const manifest = raw.manifests?.find((entry) =>
    entry.platform?.os === "linux" && entry.platform?.architecture === "amd64",
  );
  if (manifest?.digest) return manifest.digest;
  const text = run("docker", ["buildx", "imagetools", "inspect", tag], { capture: true });
  const match = /^Digest:\s+(sha256:[a-f0-9]{64})$/m.exec(text);
  if (!match) throw new Error(`Could not resolve registry digest for ${tag}.`);
  return match[1];
}

function record() {
  const local = process.env.RUNTIME_RECORD_LOCAL === "1" || release === "local";
  const lines = ["# Generated by runtime/manage-images.mjs record; do not hand-edit."];
  const records = [];
  for (const language of languages) {
    const tag = imageTag(language);
    const digest = local
      ? JSON.parse(run("docker", ["image", "inspect", tag], { capture: true }))[0].Id
      : registryDigest(tag);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid image digest for ${tag}.`);
    const reference = local
      ? `${repository}-${language.id}@${digest}`
      : `${tag}@${digest}`;
    run("docker", ["run", "--rm", "--network", "none", "--read-only", reference, "/opt/runner/execute", "--describe"], { capture: true });
    lines.push(`RUNNER_IMAGE_${language.env === "JAVASCRIPT" ? "JAVASCRIPT" : language.env}=${reference}`);
    records.push({ language: language.id, reference, digest });
  }
  const directory = path.join(runnerRoot, "dist");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "runtime-images.env"), `${lines.join("\n")}\n`);
  writeFileSync(path.join(directory, "runtime-images.json"), `${JSON.stringify({ release, local, records }, null, 2)}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function scan() {
  const directory = path.join(runnerRoot, "dist", "runtime-security");
  mkdirSync(directory, { recursive: true });
  const allowMissing = process.env.ALLOW_MISSING_SCANNER === "1";
  const hasTrivy = commandAvailable("trivy");
  const hasGrype = commandAvailable("grype");
  for (const language of languages) {
    const tag = imageTag(language);
    const stem = path.join(directory, language.id);
    extractAttestedSbom(tag, `${stem}.spdx.json`);
  }
  if (!hasTrivy && !hasGrype) {
    if (allowMissing) {
      process.stderr.write("warning: local HIGH/CRITICAL CVE scanner is unavailable; SBOMs were generated but the release gate is incomplete\n");
      return;
    }
    throw new Error("Install Trivy or Grype with a locally cached vulnerability database before releasing runtimes.");
  }
  for (const language of languages) {
    const tag = imageTag(language);
    const stem = path.join(directory, language.id);
    if (hasTrivy) run("trivy", [
      "image",
      "--skip-db-update",
      "--skip-java-db-update",
      "--offline-scan",
      "--skip-version-check",
      "--scanners", "vuln",
      "--severity", "HIGH,CRITICAL",
      "--exit-code", "1",
      "--format", "json",
      "--output", `${stem}.trivy.json`,
      tag,
    ]);
    else if (hasGrype) {
      const findings = run("grype", [tag, "--fail-on", "high", "-o", "json"], {
        capture: true,
        env: { GRYPE_DB_AUTO_UPDATE: "false" },
      });
      writeFileSync(`${stem}.grype.json`, findings);
    }
  }
}

function digestMember(digest) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid OCI digest: ${digest}`);
  return `blobs/sha256/${digest.slice("sha256:".length)}`;
}

function extractAttestedSbom(tag, output) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "learncoding-sbom-"));
  const archive = path.join(temporary, "image.tar");
  try {
    run("docker", ["image", "save", "--output", archive, tag]);
    const extract = (member) => run("tar", ["-xOf", archive, member], { capture: true });
    const rootIndex = JSON.parse(extract("index.json"));
    const rootDescriptor = rootIndex.manifests?.[0];
    if (!rootDescriptor?.digest) throw new Error(`${tag} archive has no OCI root descriptor.`);
    const imageIndex = JSON.parse(extract(digestMember(rootDescriptor.digest)));
    const attestationDescriptor = imageIndex.manifests?.find((manifest) =>
      manifest.annotations?.["vnd.docker.reference.type"] === "attestation-manifest",
    );
    if (!attestationDescriptor?.digest) throw new Error(`${tag} has no BuildKit attestation manifest.`);
    const attestation = JSON.parse(extract(digestMember(attestationDescriptor.digest)));
    const sbomLayer = attestation.layers?.find((layer) =>
      layer.annotations?.["in-toto.io/predicate-type"] === "https://spdx.dev/Document",
    );
    if (!sbomLayer?.digest) throw new Error(`${tag} has no SPDX SBOM attestation.`);
    const statement = JSON.parse(extract(digestMember(sbomLayer.digest)));
    if (statement.predicateType !== "https://spdx.dev/Document" || !statement.predicate) {
      throw new Error(`${tag} contains a malformed SPDX attestation.`);
    }
    writeFileSync(output, `${JSON.stringify(statement.predicate, null, 2)}\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const command = process.argv[2];
if (command === "build") build();
else if (command === "inspect") inspect();
else if (command === "record") record();
else if (command === "scan") scan();
else throw new Error("Usage: node runtime/manage-images.mjs <build|inspect|record|scan>");
