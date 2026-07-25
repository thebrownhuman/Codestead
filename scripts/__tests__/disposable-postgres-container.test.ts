import { describe, expect, it } from "vitest";

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

type DisposablePostgresContainer = Readonly<{
  cleanup: () => void;
  start: () => void;
}>;

type SignalName = "SIGINT" | "SIGTERM";

type DisposablePostgresModule = Readonly<{
  createDisposablePostgresContainer: (input: Readonly<{
    dockerCommand: string;
    containerName: string;
    image: string;
    port: number;
    database: string;
    username: string;
    password: string;
    sourceEnvironment: NodeJS.ProcessEnv;
    execute: (invocation: DockerInvocation) => DockerCommandResult;
    commandTimeoutMs?: number;
    cleanupTimeoutMs?: number;
  }>) => DisposablePostgresContainer;
  installDisposablePostgresSignalHandlers: (input: Readonly<{
    container: DisposablePostgresContainer;
    processTarget: Readonly<{
      once: (signal: SignalName, listener: () => void) => void;
      exit: (code: number) => void;
    }>;
    writeError: (message: string) => void;
  }>) => void;
  runWithDisposablePostgresContainer: <T>(
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

const PURPOSE_LABEL = "com.learncoding.purpose=disposable-integration-test";
const CONTAINER_NAME = "learncoding-postgres-it-unit123";
const PASSWORD = "docker-password-argv-canary";
const VOLUME_NAME = "9d1c32f7308b4db2a0f5a2d404fa76f9";

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
    label: PURPOSE_LABEL,
    ...overrides,
  };
  let containerExists = false;
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
        stdout: behavior.runStatus === 0 ? "container-id\n" : "",
      };
    }
    if (args[0] === "container" && args[1] === "ls") {
      return {
        status: 0,
        stdout: containerExists ? "container-id\n" : "",
      };
    }
    if (
      args[0] === "container"
      && args[1] === "inspect"
      && args[3]?.includes("Config.Labels")
    ) {
      return {
        status: containerExists ? 0 : 1,
        stdout: containerExists ? `${behavior.label}\n` : "",
      };
    }
    if (
      args[0] === "container"
      && args[1] === "inspect"
      && args[3]?.includes(".Mounts")
    ) {
      return {
        status: containerExists ? 0 : 1,
        stdout: containerExists ? `${[...volumes].join("\n")}\n` : "",
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
      const requestedName = args.at(-1)?.replace(/^name=\^/, "").replace(/\$$/, "");
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

function createContainer(
  module: DisposablePostgresModule,
  fake: ReturnType<typeof createFakeDocker>,
) {
  return module.createDisposablePostgresContainer({
    dockerCommand: "docker.exe",
    containerName: CONTAINER_NAME,
    image: "postgres:18-alpine",
    port: 54321,
    database: "learncoding_integration",
    username: "learncoding_it",
    password: PASSWORD,
    sourceEnvironment: {
      Path: "C:\\runtime\\bin",
      SystemRoot: "C:\\Windows",
      API_TOKEN: "ambient-token-canary",
      PGPASSWORD: "ambient-pg-password-canary",
      HTTPS_PROXY: "http://ambient-proxy.invalid",
      DATABASE_APP_URL: "postgresql://ambient.invalid/app",
    },
    execute: fake.execute,
    commandTimeoutMs: 30_000,
    cleanupTimeoutMs: 5_000,
  });
}

describe("disposable PostgreSQL container", () => {
  it("uses a PG18-safe data path and keeps the password out of Docker argv", async () => {
    const module = await loadContainerModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const fake = createFakeDocker();
    const container = createContainer(module, fake);
    container.start();

    const runCall = fake.calls.find((call) => call.args[0] === "run");
    expect(runCall).toBeDefined();
    expect(runCall?.args).toContain("PGDATA=/var/lib/postgresql/data");
    expect(runCall?.args).toContain(
      "/var/lib/postgresql/data:rw,nosuid,nodev,size=512m",
    );
    expect(runCall?.args).toContain("POSTGRES_PASSWORD");
    expect(JSON.stringify(runCall?.args)).not.toContain(PASSWORD);
    expect(runCall?.environment).toEqual({
      PATH: "C:\\runtime\\bin",
      SYSTEMROOT: "C:\\Windows",
      POSTGRES_PASSWORD: PASSWORD,
    });
    expect(
      fake.calls.every((call) =>
        Number.isSafeInteger(call.timeoutMs) && call.timeoutMs > 0
      ),
    ).toBe(true);

    container.cleanup();
  });

  it("arms cleanup before Docker run can partially create and then fail", async () => {
    const module = await loadContainerModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const fake = createFakeDocker({
      runStatus: 1,
      runCreatesContainer: true,
      runStderr: `daemon echoed ${PASSWORD}`,
    });
    const container = createContainer(module, fake);

    expect(() => container.start()).toThrow("docker_run_failed");
    expect(fake.hasContainer()).toBe(false);
    expect(
      fake.calls.some((call) =>
        call.args.join(" ") ===
        `container rm --force --volumes ${CONTAINER_NAME}`
      ),
    ).toBe(true);
    fake.behavior.runStatus = 0;
    fake.behavior.runStderr = undefined;
    expect(() => container.start()).not.toThrow();
    container.cleanup();
  });

  it("removes and verifies the exact container and any leftover anonymous volumes", async () => {
    const module = await loadContainerModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const fake = createFakeDocker({ rmRemovesVolumes: false });
    const container = createContainer(module, fake);
    container.start();
    container.cleanup();

    const rmCall = fake.calls.find((call) =>
      call.args[0] === "container" && call.args[1] === "rm"
    );
    expect(rmCall?.args).toEqual([
      "container",
      "rm",
      "--force",
      "--volumes",
      CONTAINER_NAME,
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
  });

  it("accepts auto-removal only after an exact absence probe", async () => {
    const module = await loadContainerModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const fake = createFakeDocker();
    const container = createContainer(module, fake);
    container.start();
    const callsBeforeCleanup = fake.calls.length;
    fake.autoRemove();
    container.cleanup();

    const cleanupCalls = fake.calls.slice(callsBeforeCleanup);
    expect(cleanupCalls[0]?.args).toEqual([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `name=^/${CONTAINER_NAME}$`,
    ]);
    expect(
      cleanupCalls.some((call) =>
        call.args[0] === "container" && call.args[1] === "rm"
      ),
    ).toBe(false);
  });

  it("fails closed on identity mismatch without deleting the foreign container", async () => {
    const module = await loadContainerModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const fake = createFakeDocker();
    const container = createContainer(module, fake);
    container.start();
    fake.behavior.label = "com.learncoding.purpose=foreign";

    expect(() => container.cleanup()).toThrow("container_identity_mismatch");
    expect(fake.hasContainer()).toBe(true);
    expect(
      fake.calls.filter((call) =>
        call.args[0] === "container" && call.args[1] === "rm"
      ),
    ).toHaveLength(0);
  });

  it.each([
    {
      name: "a bounded remove timeout",
      overrides: {
        rmStatus: null,
        rmErrorCode: "ETIMEDOUT",
        rmStderr: `timeout echoed ${PASSWORD}`,
      },
      expectedCode: "container_remove_failed",
    },
    {
      name: "a false successful remove that leaves the container",
      overrides: {
        rmStatus: 0,
        rmRemovesContainer: false,
      },
      expectedCode: "container_still_present",
    },
    {
      name: "a Docker daemon remove rejection",
      overrides: {
        rmStatus: 1,
        rmStderr: `daemon rejected ${PASSWORD}`,
      },
      expectedCode: "container_remove_failed",
    },
  ])("reports a sanitized cleanup failure for $name", async ({
    overrides,
    expectedCode,
  }) => {
    const module = await loadContainerModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const fake = createFakeDocker(overrides);
    const container = createContainer(module, fake);
    container.start();

    let rendered = "";
    try {
      container.cleanup();
    } catch (error) {
      rendered = String(error);
    }
    expect(rendered).toContain(expectedCode);
    expect(rendered).not.toContain(PASSWORD);
    expect(rendered).not.toContain("timeout echoed");
    expect(fake.hasContainer()).toBe(true);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("uses verified cleanup before exiting for %s", async (
    signal,
    expectedExitCode,
  ) => {
    const module = await loadContainerModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const fake = createFakeDocker();
    const container = createContainer(module, fake);
    container.start();
    const listeners = new Map<SignalName, () => void>();
    const exitCodes: number[] = [];
    const diagnostics: string[] = [];
    module.installDisposablePostgresSignalHandlers({
      container,
      processTarget: {
        once: (name, listener) => {
          listeners.set(name, listener);
        },
        exit: (code) => {
          exitCodes.push(code);
        },
      },
      writeError: (message) => diagnostics.push(message),
    });

    listeners.get(signal)?.();

    expect(fake.hasContainer()).toBe(false);
    expect(exitCodes).toEqual([expectedExitCode]);
    expect(diagnostics).toEqual([]);
  });

  it("emits only a generic diagnostic when signal cleanup fails", async () => {
    const module = await loadContainerModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const fake = createFakeDocker({
      rmStatus: null,
      rmErrorCode: "ETIMEDOUT",
      rmStderr: `signal cleanup echoed ${PASSWORD}`,
    });
    const container = createContainer(module, fake);
    container.start();
    const listeners = new Map<SignalName, () => void>();
    const exitCodes: number[] = [];
    const diagnostics: string[] = [];
    module.installDisposablePostgresSignalHandlers({
      container,
      processTarget: {
        once: (name, listener) => {
          listeners.set(name, listener);
        },
        exit: (code) => {
          exitCodes.push(code);
        },
      },
      writeError: (message) => diagnostics.push(message),
    });

    listeners.get("SIGTERM")?.();

    expect(exitCodes).toEqual([1]);
    expect(diagnostics).toEqual([
      "Disposable PostgreSQL container failed: signal_cleanup_failed",
    ]);
    expect(diagnostics.join("")).not.toContain(PASSWORD);
    expect(diagnostics.join("")).not.toContain("signal cleanup echoed");
  });

  it("preserves both primary and cleanup failures behind a sanitized aggregate", async () => {
    const module = await loadContainerModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const fake = createFakeDocker({
      rmStatus: null,
      rmErrorCode: "ETIMEDOUT",
      rmStderr: `cleanup ${PASSWORD}`,
    });
    const container = createContainer(module, fake);

    let failure: unknown;
    try {
      await module.runWithDisposablePostgresContainer(container, async () => {
        throw new Error("primary-operation-secret-canary");
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(String(failure)).toContain("operation_and_cleanup_failed");
    expect(String(failure)).not.toContain(PASSWORD);
    expect(String(failure)).not.toContain("primary-operation-secret-canary");
  });
});
