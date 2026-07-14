import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

import pg from "pg";

const { Client } = pg;

function executable(name: "docker" | "npm") {
  if (process.platform !== "win32") return name;
  return name === "npm" ? "npm.cmd" : "docker.exe";
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly quiet?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      env: options.env ?? process.env,
      stdio: options.quiet ? "ignore" : "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}.`));
    });
  });
}

function runNpm(args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return run(process.execPath, [npmCli, ...args], { env });
  return run(executable("npm"), args, { env });
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port."));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`PostgreSQL did not become ready: ${String(lastError)}`);
}

async function main() {
  const requestedTests = process.argv.slice(2);
  for (const requested of requestedTests) {
    if (!/^integration\/[a-z0-9-]+\.integration\.test\.ts$/.test(requested.replaceAll("\\", "/"))) {
      throw new Error(`Integration test path is not allowlisted: ${requested}`);
    }
  }
  const docker = executable("docker");
  const dockerCheck = spawnSync(docker, ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (dockerCheck.status !== 0) {
    throw new Error(
      "Docker is required for test:integration. Start Docker and grant this process access to its daemon. " +
      (dockerCheck.stderr || dockerCheck.error?.message || "Docker server was unavailable."),
    );
  }

  const suffix = randomBytes(6).toString("hex");
  const containerName = `learncoding-postgres-it-${suffix}`;
  const password = randomBytes(24).toString("base64url");
  const port = await availablePort();
  const image = process.env.INTEGRATION_POSTGRES_IMAGE ??
    "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
  const databaseUrl = `postgresql://learncoding_it:${password}@127.0.0.1:${port}/learncoding_integration`;
  let started = false;

  const cleanup = () => {
    if (!started) return;
    spawnSync(docker, ["rm", "--force", containerName], {
      stdio: "ignore",
      windowsHide: true,
    });
    started = false;
  };

  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    await run(docker, [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--label",
      "com.learncoding.purpose=disposable-integration-test",
      "--publish",
      `127.0.0.1:${port}:5432`,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,nosuid,nodev,size=512m",
      "--env",
      "POSTGRES_DB=learncoding_integration",
      "--env",
      "POSTGRES_USER=learncoding_it",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      image,
    ]);
    started = true;
    await waitForPostgres(databaseUrl);

    const testEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_SIZE: "8",
      NODE_ENV: "test" as const,
      BETTER_AUTH_SECRET: "integration-only-secret-never-for-production",
      INTEGRATION_TEST: "1",
    };
    await runNpm(["run", "db:migrate"], testEnv);
    // A second pass must be a no-op. This catches non-idempotent migration
    // journal or DDL regressions before they reach an existing installation.
    await runNpm(["run", "db:migrate"], testEnv);
    await runNpm([
      "run",
      "test:integration:vitest",
      ...(requestedTests.length > 0 ? ["--", ...requestedTests] : []),
    ], testEnv);
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
