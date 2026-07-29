/* eslint-disable @next/next/no-assign-module-variable */

import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

type DockerInvocation = Readonly<{
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}>;

type DockerCommandResult = Readonly<{
  status: number | null;
  stdout?: string;
  stderr?: string;
  errorCode?: string;
}>;

type PasswordFileHandle = Readonly<{
  hostPath: string;
  containerPath: string;
  cleanup: () => void;
}>;

type DisposablePostgresContainer = Readonly<{
  cleanup: () => void;
  getIdentity: () => Readonly<{
    containerId: string;
    port: number;
    database: string;
    username: string;
  }>;
  start: () => void;
}>;

type SignalName = "SIGINT" | "SIGTERM";

type DisposablePostgresModule = Readonly<{
  createDisposablePostgresContainer?: (input: Readonly<{
    dockerCommand: string;
    containerName: string;
    image: string;
    port: number;
    database: string;
    username: string;
    password: string;
    taskHomeDirectory: string;
    sourceEnvironment: EnvironmentSource;
    createPasswordFile: (password: string) => PasswordFileHandle;
    execute: (invocation: DockerInvocation) => DockerCommandResult;
    commandTimeoutMs?: number;
    cleanupTimeoutMs?: number;
  }>) => DisposablePostgresContainer;
  installDisposablePostgresSignalHandlers?: (input: Readonly<{
    container: DisposablePostgresContainer;
    processTarget: Readonly<{
      on: (signal: SignalName, listener: () => void) => void;
      exit: (code: number) => void;
    }>;
    terminateActiveChildren: (signal: SignalName) => Promise<void>;
    writeError: (message: string) => void;
  }>) => void;
  runWithDisposablePostgresContainer?: <T>(
    container: DisposablePostgresContainer,
    operation: () => Promise<T>,
  ) => Promise<T>;
}>;

async function loadContainerModule(): Promise<DisposablePostgresModule | null> {
  const modulePath = "../lib/disposable-postgres-container";
  try {
    return await import(/* @vite-ignore */ modulePath) as DisposablePostgresModule;
  } catch {
    return null;
  }
}

const CONTAINER_NAME = "learncoding-postgres-it-unit123";
const RUN_LABEL = `com.learncoding.integration-run=${CONTAINER_NAME}`;
const OWNED_CONTAINER_ID = "a".repeat(64);
const FOREIGN_CONTAINER_ID = "b".repeat(64);
const PASSWORD = "docker-password-file-content-canary";
const PASSWORD_FILE = path.resolve("task-secret", "postgres-password");
const PASSWORD_CONTAINER_PATH = "/run/secrets/postgres-password";
const TASK_HOME = path.resolve("task-home", "run123");
const VOLUME_NAME = "9".repeat(64);
const PG18_IMAGE =
  "postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";

type FakeDockerBehavior = {
  runStatus: number | null;
  runCreatesContainer: boolean;
  runErrorCode?: string;
  runStderr?: string;
  rmStatus: number | null;
  rmErrorCode?: string;
  rmStderr?: string;
  rmRemovesContainer: boolean;
  rmRemovesVolumes: boolean;
  volumeRmStatus: number | null;
  volumeRmRemovesVolume: boolean;
  label: string;
};

function createFakeDocker(
  overrides: Partial<FakeDockerBehavior> = {},
) {
  const calls: DockerInvocation[] = [];
  const behavior: FakeDockerBehavior = {
    runStatus: 0,
    runCreatesContainer: true,
    rmStatus: 0,
    rmRemovesContainer: true,
    rmRemovesVolumes: true,
    volumeRmStatus: 0,
    volumeRmRemovesVolume: true,
    label: RUN_LABEL,
    ...overrides,
  };
  let containerExists = false;
  let containerId = OWNED_CONTAINER_ID;
  const volumes = new Set<string>();

  const execute = (invocation: DockerInvocation): DockerCommandResult => {
    calls.push(invocation);
    const args = [...invocation.args];

    if (args[0] === "version") {
      return { status: 0, stdout: "28.0.0\n" };
    }
    if (args[0] === "run") {
      if (behavior.runCreatesContainer) {
        containerExists = true;
        volumes.add(VOLUME_NAME);
      }
      return {
        status: behavior.runStatus,
        errorCode: behavior.runErrorCode,
        stderr: behavior.runStderr,
        stdout: behavior.runStatus === 0 ? `${containerId}\n` : "",
      };
    }
    if (args[0] === "container" && args[1] === "ls") {
      return {
        status: 0,
        stdout: containerExists ? `${containerId}\n` : "",
      };
    }
    if (
      args[0] === "container"
      && args[1] === "inspect"
      && args[3]?.includes(".Id")
    ) {
      const targetExists = containerExists && args.at(-1) === containerId;
      return {
        status: targetExists ? 0 : 1,
        stdout: targetExists ? `${containerId}\n` : "",
      };
    }
    if (
      args[0] === "container"
      && args[1] === "inspect"
      && args[3]?.includes("Config.Labels")
    ) {
      const requested = args.at(-1);
      const targetExists = containerExists
        && (requested === containerId || requested === CONTAINER_NAME);
      return {
        status: targetExists ? 0 : 1,
        stdout: targetExists ? `${behavior.label}\n` : "",
      };
    }
    if (
      args[0] === "container"
      && args[1] === "inspect"
      && args[3]?.includes(".Mounts")
    ) {
      const requested = args.at(-1);
      const targetExists = containerExists
        && (requested === containerId || requested === CONTAINER_NAME);
      return {
        status: targetExists ? 0 : 1,
        stdout: targetExists ? `${[...volumes].join("\n")}\n` : "",
      };
    }
    if (args[0] === "container" && args[1] === "rm") {
      if (behavior.rmStatus === 0) {
        if (behavior.rmRemovesContainer) containerExists = false;
        if (behavior.rmRemovesVolumes) volumes.clear();
      }
      return {
        status: behavior.rmStatus,
        errorCode: behavior.rmErrorCode,
        stderr: behavior.rmStderr,
      };
    }
    if (args[0] === "volume" && args[1] === "ls") {
      const requestedName = args.at(-1)?.replace(/^name=\^/u, "").replace(/\$$/u, "");
      return {
        status: 0,
        stdout: requestedName && volumes.has(requestedName)
          ? `${requestedName}\n`
          : "",
      };
    }
    if (args[0] === "volume" && args[1] === "rm") {
      const requestedName = args.at(-1);
      if (
        behavior.volumeRmStatus === 0
        && behavior.volumeRmRemovesVolume
        && requestedName
      ) {
        volumes.delete(requestedName);
      }
      return { status: behavior.volumeRmStatus };
    }
    throw new Error(`Unexpected fake Docker invocation: ${args.join(" ")}`);
  };

  return {
    behavior,
    calls,
    execute,
    replaceWithSameLabel() {
      containerExists = true;
      containerId = FOREIGN_CONTAINER_ID;
      behavior.label = RUN_LABEL;
    },
    setVolumes(names: readonly string[]) {
      volumes.clear();
      for (const name of names) volumes.add(name);
    },
    autoRemove() {
      containerExists = false;
      volumes.clear();
    },
    hasContainer() {
      return containerExists;
    },
    hasVolume(name: string) {
      return volumes.has(name);
    },
  };
}

function createFixture(
  module: DisposablePostgresModule,
  fake: ReturnType<typeof createFakeDocker>,
  input: Readonly<{
    passwordCleanupFails?: boolean;
    port?: number;
  }> = {},
) {
  const cleanup = vi.fn(() => {
    if (input.passwordCleanupFails) {
      throw new Error(`raw password cleanup ${PASSWORD} ${PASSWORD_FILE}`);
    }
  });
  const createPasswordFile = vi.fn((password: string): PasswordFileHandle => {
    if (password !== PASSWORD) throw new Error("wrong password");
    return {
      hostPath: PASSWORD_FILE,
      containerPath: PASSWORD_CONTAINER_PATH,
      cleanup,
    };
  });
  const container = module.createDisposablePostgresContainer?.({
    dockerCommand: "docker.exe",
    containerName: CONTAINER_NAME,
    image: PG18_IMAGE,
    port: input.port ?? 54321,
    database: "learncoding_integration",
    username: "codestead_it",
    password: PASSWORD,
    taskHomeDirectory: TASK_HOME,
    sourceEnvironment: {
      Path: "C:\\runtime\\bin",
      SystemRoot: "C:\\Windows",
      HOME: "C:\\ambient-home-canary",
      USERPROFILE: "C:\\ambient-profile-canary",
      APPDATA: "C:\\ambient-appdata-canary",
      API_TOKEN: "ambient-token-canary",
      PGPASSWORD: "ambient-pg-password-canary",
      POSTGRES_PASSWORD: "ambient-postgres-password-canary",
      HTTPS_PROXY: "http://ambient-proxy.invalid",
      DATABASE_APP_URL: "postgresql://ambient.invalid/app",
    },
    createPasswordFile,
    execute: fake.execute,
    commandTimeoutMs: 30_000,
    cleanupTimeoutMs: 5_000,
  });
  if (!container) throw new Error("container helper missing");
  return { cleanup, container, createPasswordFile };
}

function renderedFailure(error: unknown): string {
  return [
    String(error),
    inspect(error),
    JSON.stringify(error),
    JSON.stringify(Object.entries(error as object)),
  ].join("\n");
}

describe("disposable PostgreSQL container", () => {
  it("uses a PG18-safe data path and a read-only password file without secret metadata", async () => {
    const module = await loadContainerModule();
    expect(module).not.toBeNull();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    if (!module?.createDisposablePostgresContainer) return;

    const fake = createFakeDocker();
    const fixture = createFixture(module, fake);
    fixture.container.start();

    const runCall = fake.calls.find((call) => call.args[0] === "run");
    expect(runCall).toBeDefined();
    const publishIndex = runCall?.args.indexOf("--publish") ?? -1;
    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(runCall?.args[publishIndex + 1]).toBe(
      "127.0.0.1:54321:5432",
    );
    expect(JSON.stringify(runCall?.args)).not.toMatch(/0\.0\.0\.0|\[?::\]?/u);
    expect(runCall?.args).toContain("PGDATA=/var/lib/postgresql/data");
    expect(runCall?.args).toContain(
      "/var/lib/postgresql/data:rw,nosuid,nodev,size=512m",
    );
    expect(runCall?.args).toContain(
      `type=bind,source=${PASSWORD_FILE},target=${PASSWORD_CONTAINER_PATH},readonly`,
    );
    expect(runCall?.args).toContain(
      `POSTGRES_PASSWORD_FILE=${PASSWORD_CONTAINER_PATH}`,
    );
    expect(runCall?.args).not.toContain("POSTGRES_PASSWORD");
    expect(JSON.stringify(runCall?.args)).not.toContain(PASSWORD);
    expect(JSON.stringify(runCall?.environment)).not.toContain(PASSWORD);
    expect(runCall?.environment).toMatchObject({
      PATH: "C:\\runtime\\bin",
      SYSTEMROOT: "C:\\Windows",
      HOME: TASK_HOME,
      USERPROFILE: TASK_HOME,
      APPDATA: path.join(TASK_HOME, "appdata"),
      LOCALAPPDATA: path.join(TASK_HOME, "local-appdata"),
      DOCKER_CONFIG: path.join(TASK_HOME, "docker"),
    });
    expect(JSON.stringify(runCall?.environment)).not.toMatch(
      /ambient-home-canary|ambient-profile-canary|ambient-appdata-canary|ambient-token-canary|ambient-pg-password-canary|ambient-postgres-password-canary|ambient-proxy/u,
    );
    expect(
      fake.calls.every((call) =>
        Number.isSafeInteger(call.timeoutMs) && call.timeoutMs > 0
      ),
    ).toBe(true);
    expect(fixture.container.getIdentity()).toEqual({
      containerId: OWNED_CONTAINER_ID,
      port: 54321,
      database: "learncoding_integration",
      username: "codestead_it",
    });

    fixture.container.cleanup();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("rejects host port 5432 before arming Docker or password cleanup", async () => {
    const module = await loadContainerModule();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    if (!module?.createDisposablePostgresContainer) return;

    const fake = createFakeDocker();
    expect(() => createFixture(module, fake, { port: 5432 })).toThrow(
      "invalid_postgres_host_port",
    );
    expect(fake.calls).toEqual([]);
  });

  it("arms container and password cleanup before Docker run can partially fail", async () => {
    const module = await loadContainerModule();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    if (!module?.createDisposablePostgresContainer) return;

    const fake = createFakeDocker({
      runStatus: 1,
      runCreatesContainer: true,
      runStderr: `daemon echoed ${PASSWORD} ${PASSWORD_FILE}`,
    });
    const fixture = createFixture(module, fake);
    let failure: unknown;
    try {
      fixture.container.start();
    } catch (error) {
      failure = error;
    }

    expect(renderedFailure(failure)).toContain("docker_run_failed");
    expect(renderedFailure(failure)).not.toContain(PASSWORD);
    expect(renderedFailure(failure)).not.toContain(PASSWORD_FILE);
    expect(fake.hasContainer()).toBe(false);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("removes and verifies the exact container and leftover anonymous volume", async () => {
    const module = await loadContainerModule();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    if (!module?.createDisposablePostgresContainer) return;

    const fake = createFakeDocker({ rmRemovesVolumes: false });
    const fixture = createFixture(module, fake);
    fixture.container.start();
    fixture.container.cleanup();

    const rmCall = fake.calls.find((call) =>
      call.args[0] === "container" && call.args[1] === "rm"
    );
    expect(rmCall?.args).toEqual([
      "container",
      "rm",
      "--force",
      "--volumes",
      OWNED_CONTAINER_ID,
    ]);
    expect(rmCall?.timeoutMs).toBe(5_000);
    expect(
      fake.calls.some((call) =>
        call.args.join(" ") === `volume rm --force ${VOLUME_NAME}`
      ),
    ).toBe(true);
    expect(fake.hasContainer()).toBe(false);
    expect(fake.hasVolume(VOLUME_NAME)).toBe(false);
    expect(fake.calls.flatMap((call) => call.args)).not.toContain("prune");
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("accepts auto-removal only after an exact absence probe", async () => {
    const module = await loadContainerModule();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    if (!module?.createDisposablePostgresContainer) return;

    const fake = createFakeDocker();
    const fixture = createFixture(module, fake);
    fixture.container.start();
    const callsBeforeCleanup = fake.calls.length;
    fake.autoRemove();
    fixture.container.cleanup();

    const cleanupCalls = fake.calls.slice(callsBeforeCleanup);
    expect(cleanupCalls[0]?.args).toEqual([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `name=^/${CONTAINER_NAME}$`,
    ]);
    expect(
      cleanupCalls.some((call) =>
        call.args[0] === "container" && call.args[1] === "rm"
      ),
    ).toBe(false);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("does not delete a foreign container but still deletes its own password file", async () => {
    const module = await loadContainerModule();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    if (!module?.createDisposablePostgresContainer) return;

    const fake = createFakeDocker();
    const fixture = createFixture(module, fake);
    fixture.container.start();
    fake.behavior.label = "com.learncoding.purpose=foreign";

    expect(() => fixture.container.cleanup()).toThrow(
      "container_identity_mismatch",
    );
    expect(fake.hasContainer()).toBe(true);
    expect(
      fake.calls.filter((call) =>
        call.args[0] === "container" && call.args[1] === "rm"
      ),
    ).toHaveLength(0);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("does not delete a same-label replacement with a different container ID", async () => {
    const module = await loadContainerModule();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    if (!module?.createDisposablePostgresContainer) return;

    const fake = createFakeDocker();
    const fixture = createFixture(module, fake);
    fixture.container.start();
    fake.replaceWithSameLabel();

    expect(() => fixture.container.cleanup()).toThrow(
      "container_identity_mismatch",
    );
    expect(fake.hasContainer()).toBe(true);
    expect(
      fake.calls.filter((call) =>
        call.args[0] === "container" && call.args[1] === "rm"
      ),
    ).toHaveLength(0);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("never treats an inspect-derived named volume as an anonymous deletion target", async () => {
    const module = await loadContainerModule();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    if (!module?.createDisposablePostgresContainer) return;

    const fake = createFakeDocker();
    const fixture = createFixture(module, fake);
    fixture.container.start();
    fake.setVolumes(["important-named-volume"]);

    expect(() => fixture.container.cleanup()).toThrow(
      "invalid_anonymous_volume_name",
    );
    expect(fake.hasContainer()).toBe(true);
    expect(
      fake.calls.filter((call) =>
        call.args[0] === "container" && call.args[1] === "rm"
      ),
    ).toHaveLength(0);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "a bounded remove timeout",
      overrides: {
        rmStatus: null,
        rmErrorCode: "ETIMEDOUT",
        rmStderr: `timeout echoed ${PASSWORD} ${PASSWORD_FILE}`,
      },
      expectedCode: "container_remove_failed",
    },
    {
      name: "a false successful remove",
      overrides: {
        rmStatus: 0,
        rmRemovesContainer: false,
      },
      expectedCode: "container_still_present",
    },
    {
      name: "a Docker daemon rejection",
      overrides: {
        rmStatus: 1,
        rmStderr: `daemon rejected ${PASSWORD} ${PASSWORD_FILE}`,
      },
      expectedCode: "container_remove_failed",
    },
  ])("reports a nested-safe failure for $name", async ({
    overrides,
    expectedCode,
  }) => {
    const module = await loadContainerModule();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    if (!module?.createDisposablePostgresContainer) return;

    const fake = createFakeDocker(overrides);
    const fixture = createFixture(module, fake);
    fixture.container.start();
    let failure: unknown;
    try {
      fixture.container.cleanup();
    } catch (error) {
      failure = error;
    }

    const rendered = renderedFailure(failure);
    expect(rendered).toContain(expectedCode);
    expect(rendered).not.toContain(PASSWORD);
    expect(rendered).not.toContain(PASSWORD_FILE);
    expect(rendered).not.toMatch(/timeout echoed|daemon rejected/u);
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("reports both container and password cleanup failures without nesting raw errors", async () => {
    const module = await loadContainerModule();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    if (!module?.createDisposablePostgresContainer) return;

    const fake = createFakeDocker({
      rmStatus: null,
      rmErrorCode: "ETIMEDOUT",
      rmStderr: `cleanup ${PASSWORD} ${PASSWORD_FILE}`,
    });
    const fixture = createFixture(module, fake, { passwordCleanupFails: true });
    fixture.container.start();
    let failure: unknown;
    try {
      fixture.container.cleanup();
    } catch (error) {
      failure = error;
    }

    const rendered = renderedFailure(failure);
    expect(rendered).toContain("container_and_password_cleanup_failed");
    expect(rendered).not.toContain(PASSWORD);
    expect(rendered).not.toContain(PASSWORD_FILE);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("uses verified cleanup before exiting for %s", async (
    signal,
    expectedExitCode,
  ) => {
    const module = await loadContainerModule();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    expect(typeof module?.installDisposablePostgresSignalHandlers).toBe("function");
    if (
      !module?.createDisposablePostgresContainer
      || !module.installDisposablePostgresSignalHandlers
    ) return;

    const fake = createFakeDocker();
    const fixture = createFixture(module, fake);
    fixture.container.start();
    const listeners = new Map<SignalName, () => void>();
    const exitCodes: number[] = [];
    const diagnostics: string[] = [];
    module.installDisposablePostgresSignalHandlers({
      container: fixture.container,
      terminateActiveChildren: async () => undefined,
      processTarget: {
        on: (name, listener) => {
          listeners.set(name, listener);
        },
        exit: (code) => {
          exitCodes.push(code);
        },
      },
      writeError: (message) => diagnostics.push(message),
    });

    listeners.get(signal)?.();
    await vi.waitFor(() => expect(exitCodes).toEqual([expectedExitCode]));

    expect(fake.hasContainer()).toBe(false);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual([]);
  });

  it("maps raw operation and cleanup errors to one fixed code without nested canaries", async () => {
    const module = await loadContainerModule();
    expect(typeof module?.createDisposablePostgresContainer).toBe("function");
    expect(typeof module?.runWithDisposablePostgresContainer).toBe("function");
    if (
      !module?.createDisposablePostgresContainer
      || !module.runWithDisposablePostgresContainer
    ) return;

    const fake = createFakeDocker({
      rmStatus: null,
      rmErrorCode: "ETIMEDOUT",
      rmStderr: `cleanup ${PASSWORD} ${PASSWORD_FILE}`,
    });
    const fixture = createFixture(module, fake);
    let failure: unknown;
    try {
      await module.runWithDisposablePostgresContainer(
        fixture.container,
        async () => {
          const raw = new Error(
            `primary-operation-secret-canary ${PASSWORD} ${PASSWORD_FILE}`,
          );
          Object.assign(raw, {
            code: "raw-primary-code-canary",
            cause: new Error("raw-cause-canary"),
          });
          throw raw;
        },
      );
    } catch (error) {
      failure = error;
    }

    const rendered = renderedFailure(failure);
    expect(rendered).toContain("operation_and_cleanup_failed");
    expect(rendered).not.toMatch(
      /primary-operation-secret-canary|raw-primary-code-canary|raw-cause-canary/u,
    );
    expect(rendered).not.toContain(PASSWORD);
    expect(rendered).not.toContain(PASSWORD_FILE);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
  });
});
