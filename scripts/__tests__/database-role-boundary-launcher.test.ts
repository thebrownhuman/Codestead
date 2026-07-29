import { spawnSync as nodeSpawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

import {
  buildDisposableIntegrationChildLaunch,
} from "../lib/disposable-integration-child-launch";

type TestLane = Readonly<{
  deadlineMs?: number;
  id: string;
  file: string;
  namePattern?: string;
}>;

type ChildHandle = Readonly<{
  exitCode: number | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (
    event: "close" | "error",
    listener: (...args: unknown[]) => void,
  ) => unknown;
  pid: number;
  signalCode: NodeJS.Signals | null;
}>;

type ChildController = Readonly<{
  spawnAndTrack: <Child extends ChildHandle>(
    spawnChild: () => Child,
  ) => Readonly<{
    child: Child;
    completeAndWait: (signal: "SIGINT" | "SIGTERM") => Promise<void>;
  }>;
}>;

type LauncherDependencies = Readonly<{
  buildChildLaunch?: typeof buildDisposableIntegrationChildLaunch;
  createChildController?: (
    input: Readonly<{
      forceTimeoutMs: number;
      gracefulTimeoutMs: number;
    }>,
  ) => ChildController;
  environment?: NodeJS.ProcessEnv;
  spawn?: (
    command: string,
    args: readonly string[],
    options: Readonly<Record<string, unknown>>,
  ) => ChildHandle;
  deadlineMs?: number;
  heartbeatMs?: number;
  terminationGraceMs?: number;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}>;

type LauncherModule = Readonly<{
  DATABASE_ROLE_BOUNDARY_TEST_LANES: readonly TestLane[];
  runDatabaseRoleBoundaryTests: (
    dependencies?: LauncherDependencies,
  ) => Promise<number>;
}>;

let nextFakePid = 10_000;

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly kill = vi.fn(() => true);
  readonly pid = nextFakePid++;
  signalCode: NodeJS.Signals | null = null;
}

async function loadLauncher(): Promise<LauncherModule | null> {
  const modulePath = "../run-database-role-boundaries-tests";
  try {
    return (await import(/* @vite-ignore */ modulePath)) as LauncherModule;
  } catch {
    return null;
  }
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function minimalLauncherEnvironment(): NodeJS.ProcessEnv {
  return process.platform === "win32"
    ? {
      SYSTEMROOT:
        process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows",
    }
    : {};
}

function topLevelTestNames(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "launcher-partition-input.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const directBindings = new Set<string>();
  const namespaceBindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "node:test"
      || statement.importClause === undefined
    ) {
      continue;
    }
    if (statement.importClause.name !== undefined) {
      directBindings.add(statement.importClause.name.text);
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      namespaceBindings.add(bindings.name.text);
    } else if (bindings !== undefined) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === "test" || imported === "it") {
          directBindings.add(element.name.text);
        }
      }
    }
  }
  if (directBindings.size === 0 && namespaceBindings.size === 0) {
    throw new Error("launcher partition requires a node:test import");
  }

  const propertyChain = (
    expression: ts.Expression,
  ): Readonly<{ properties: string[]; root: string }> | null => {
    const properties: string[] = [];
    let current = expression;
    while (ts.isPropertyAccessExpression(current)) {
      properties.unshift(current.name.text);
      current = current.expression;
    }
    return ts.isIdentifier(current)
      ? { properties, root: current.text }
      : null;
  };
  const classify = (
    call: ts.CallExpression,
  ): "accepted" | "other" | "unsupported" => {
    const chain = propertyChain(call.expression);
    if (chain === null) return "other";
    if (directBindings.has(chain.root)) {
      return chain.properties.length === 0 ? "accepted" : "unsupported";
    }
    if (!namespaceBindings.has(chain.root)) return "other";
    const [registration] = chain.properties;
    if (registration !== "test" && registration !== "it") return "other";
    return chain.properties.length === 1 ? "accepted" : "unsupported";
  };
  const acceptedCalls = new Set<ts.CallExpression>();
  const names: string[] = [];
  const seenTitles = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExpressionStatement(statement)
      || !ts.isCallExpression(statement.expression)
    ) {
      continue;
    }
    const registration = statement.expression;
    const classification = classify(registration);
    if (classification === "unsupported") {
      throw new Error(
        "launcher partition rejects unsupported node:test registration",
      );
    }
    if (classification !== "accepted") continue;
    const title = registration.arguments[0];
    const callback = registration.arguments[1];
    if (
      registration.questionDotToken !== undefined
      || (
        ts.isPropertyAccessExpression(registration.expression)
        && registration.expression.questionDotToken !== undefined
      )
      || registration.arguments.length !== 2
      || title === undefined
      || (
        !ts.isStringLiteral(title)
        && !ts.isNoSubstitutionTemplateLiteral(title)
      )
    ) {
      throw new Error(
        "launcher partition requires an executable static node:test registration",
      );
    }
    if (
      callback === undefined
      || (
        !ts.isArrowFunction(callback)
        && !ts.isFunctionExpression(callback)
      )
    ) {
      throw new Error(
        "launcher partition requires an inline node:test callback",
      );
    }
    if (seenTitles.has(title.text)) {
      throw new Error("launcher partition requires unique node:test titles");
    }
    seenTitles.add(title.text);
    acceptedCalls.add(registration);
    names.push(title.text);
  }
  const rejectHiddenRegistrations = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === "node:test"
    ) {
      return;
    }
    if (ts.isCallExpression(node)) {
      const classification = classify(node);
      if (
        classification === "unsupported"
        || (classification === "accepted" && !acceptedCalls.has(node))
      ) {
        throw new Error(
          "launcher partition requires direct top-level node:test registrations",
        );
      }
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isPropertyName =
        ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isAcceptedDirectCallee =
        ts.isCallExpression(parent)
        && parent.expression === node
        && acceptedCalls.has(parent);
      const isAcceptedNamespaceRoot =
        ts.isPropertyAccessExpression(parent)
        && parent.expression === node
        && ts.isCallExpression(parent.parent)
        && parent.parent.expression === parent
        && acceptedCalls.has(parent.parent);
      if (
        !isPropertyName
        && !isAcceptedDirectCallee
        && !isAcceptedNamespaceRoot
        && (
          directBindings.has(node.text)
          || namespaceBindings.has(node.text)
        )
      ) {
        throw new Error(
          "launcher partition rejects aliased or shadowed node:test registrations",
        );
      }
    }
    ts.forEachChild(node, rejectHiddenRegistrations);
  };
  rejectHiddenRegistrations(sourceFile);
  return names;
}

function laneMatches(testLane: TestLane, testName: string): boolean {
  return testLane.namePattern === undefined
    || new RegExp(testLane.namePattern, "u").test(testName);
}

function fakeSpawnHarness(
  completion?: (index: number, signal: "SIGINT" | "SIGTERM") => Promise<void>,
): Readonly<{
  children: FakeChild[];
  completeAndWait: ReturnType<typeof vi.fn>[];
  createChildController: NonNullable<
    LauncherDependencies["createChildController"]
  >;
  spawn: ReturnType<typeof vi.fn>;
}> {
  const children: FakeChild[] = [];
  const completeAndWait: ReturnType<typeof vi.fn>[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const createChildController = vi.fn(() => ({
    spawnAndTrack: <Child extends ChildHandle>(spawnChild: () => Child) => {
      const child = spawnChild();
      const index = completeAndWait.length;
      const wait = vi.fn((signal: "SIGINT" | "SIGTERM") =>
        completion?.(index, signal) ?? Promise.resolve()
      );
      completeAndWait.push(wait);
      return { child, completeAndWait: wait };
    },
  }));
  return {
    children,
    completeAndWait,
    createChildController,
    spawn,
  };
}

function completeChildren(
  children: readonly FakeChild[],
  statuses: readonly (number | null)[],
): void {
  children.forEach((child, index) => {
    const status = statuses[index];
    const resolvedStatus = status === undefined ? 0 : status;
    child.exitCode = resolvedStatus;
    child.signalCode = null;
    child.emit("close", resolvedStatus, null);
  });
}

function deferredCompletion(): Readonly<{
  promise: Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
}> {
  let reject: (error: unknown) => void = () => undefined;
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

describe("database role-boundary test launcher", () => {
  it("accepts only direct executable static node:test registrations", () => {
    expect(
      topLevelTestNames(`
        import test, { it as scenario } from "node:test";
        import * as nodeTest from "node:test";
        test(
          "multiline declaration",
          () => undefined,
        );
        scenario('named import declaration', function () {});
        nodeTest.test(\`namespace declaration\`, async () => undefined);
      `),
    ).toEqual([
      "multiline declaration",
      "named import declaration",
      "namespace declaration",
    ]);
    for (const invalidSource of [
      'import test from "node:test"; test.skip("skip", () => undefined);',
      'import test from "node:test"; test.todo("todo", () => undefined);',
      'import test from "node:test"; test.only("only", () => undefined);',
      'import test from "node:test"; const register = test; register("alias", () => undefined);',
      'import * as nodeTest from "node:test"; const register = nodeTest.test; register("alias", () => undefined);',
      'import test from "node:test"; test("duplicate", () => undefined); test("duplicate", () => undefined);',
      'import test from "node:test"; const dynamicName = "dynamic"; test(dynamicName, () => undefined);',
      'import test from "node:test"; const callback = () => undefined; test("callback", callback);',
      'import * as nodeTest from "node:test"; nodeTest["test"]("computed", () => undefined);',
      'import test from "node:test"; test?.("optional", () => undefined);',
      'import test from "node:test"; test("options", { skip: false }, () => undefined);',
      'import test from "node:test"; test("outer", () => { test("nested", () => undefined); });',
      'import test from "node:test"; if (true) test("conditional", () => undefined);',
    ]) {
      expect(() => topLevelTestNames(invalidSource)).toThrow();
    }
  });

  it("partitions every large-suite test exactly once", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["test:database-role-boundaries"]).toBe(
      "tsx scripts/run-database-role-boundaries-tests.ts",
    );
    expect(packageJson.scripts["test:integration"]).toBe(
      "tsx scripts/run-integration-tests.ts",
    );

    const launcher = await loadLauncher();
    expect(launcher).not.toBeNull();
    if (!launcher) return;

    expect(launcher.DATABASE_ROLE_BOUNDARY_TEST_LANES).toHaveLength(10);
    expect(
      launcher.DATABASE_ROLE_BOUNDARY_TEST_LANES.map((testLane) => testLane.id),
    ).toEqual([
      "manifest-inventory",
      "manifest-diff",
      "manifest-metadata",
      "manifest-reconciliation",
      "manifest-phase",
      "bootstrap-missing-grants",
      "bootstrap-core",
      "bootstrap-catalog",
      "standalone-verifier",
      "role-boundary",
    ]);
    expect(
      launcher.DATABASE_ROLE_BOUNDARY_TEST_LANES.filter(
        (testLane) => testLane.deadlineMs !== undefined,
      ),
    ).toEqual([
      expect.objectContaining({
        deadlineMs: 90_000,
        id: "bootstrap-missing-grants",
      }),
    ]);
    const registeredFiles = [
      {
        file: path.resolve(
          repositoryRoot,
          "scripts/database-runtime-capabilities.test.mjs",
        ),
        expectedCount: 24,
        expectedLanes: 5,
        expectedLaneCounts: [9, 6, 1, 6, 2],
      },
      {
        file: path.resolve(
          repositoryRoot,
          "scripts/bootstrap-database-runtime-capabilities.test.mjs",
        ),
        expectedCount: 23,
        expectedLanes: 3,
        expectedLaneCounts: [1, 11, 11],
      },
      {
        file: path.resolve(
          repositoryRoot,
          "scripts/verify-database-runtime-capabilities.test.mjs",
        ),
        expectedCount: 12,
        expectedLanes: 1,
        expectedLaneCounts: [12],
      },
      {
        file: path.resolve(
          repositoryRoot,
          "scripts/database-role-boundaries.test.mjs",
        ),
        expectedCount: 86,
        expectedLanes: 1,
        expectedLaneCounts: [86],
      },
    ] as const;
    let registeredTestCount = 0;

    for (const registeredFile of registeredFiles) {
      const source = await readFile(registeredFile.file, "utf8");
      const names = topLevelTestNames(source);
      registeredTestCount += names.length;
      const lanes = launcher.DATABASE_ROLE_BOUNDARY_TEST_LANES.filter(
        (testLane) =>
          path.normalize(testLane.file) === path.normalize(registeredFile.file),
      );
      expect(names).toHaveLength(registeredFile.expectedCount);
      expect(lanes).toHaveLength(registeredFile.expectedLanes);
      expect(
        lanes.map(
          (testLane) => names.filter((name) => laneMatches(testLane, name)).length,
        ),
      ).toEqual(registeredFile.expectedLaneCounts);
      for (const name of names) {
        expect(
          lanes.filter((testLane) => laneMatches(testLane, name)),
          `expected exactly one launcher lane for ${name}`,
        ).toHaveLength(1);
      }
    }
    expect(registeredTestCount).toBe(145);
    expect(
      [
        ...new Set(
          launcher.DATABASE_ROLE_BOUNDARY_TEST_LANES.map(
            (testLane) => path.normalize(testLane.file),
          ),
        ),
      ],
    ).toEqual(
      registeredFiles.map((registeredFile) =>
        path.normalize(registeredFile.file)
      ),
    );
  });

  it("starts all lanes concurrently with exact arguments and a sanitized environment", async () => {
    const launcher = await loadLauncher();
    expect(launcher).not.toBeNull();
    if (!launcher) return;

    const environment = {
      CI: "true",
      LANG: "C.UTF-8",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Temp",
      NODE_ENV: "test" as const,
      ARBITRARY_TOKEN: "token-canary",
      APP_SECRET: "secret-canary",
      SIGNING_KEY: "key-canary",
      SERVICE_CREDENTIAL: "credential-canary",
      AWS_SECRET_ACCESS_KEY: "cloud-secret-canary",
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "cloud-file-canary",
      HTTPS_PROXY: "proxy-canary",
      DATABASE_READONLY_URL: "alternate-database-canary",
      DATABASE_URL_FILE: "alternate-database-file-canary",
      PGHOST: "pg-host-canary",
      PGPORT: "pg-port-canary",
      PGUSER: "pg-user-canary",
      PGPASSWORD: "pg-password-canary",
      PGOPTIONS: "pg-options-canary",
    };
    const {
      children,
      completeAndWait,
      createChildController,
      spawn,
    } = fakeSpawnHarness();
    const buildChildLaunch = vi.fn(
      (
        input: Parameters<
          typeof buildDisposableIntegrationChildLaunch
        >[0],
      ) => ({
        args: ["--supervised", ...input.args],
        command: "supervisor-canary",
        detached: false,
        environment: {
          ...input.environment,
          CODESTEAD_SUPERVISED: "1",
        },
        treeSupervised: true,
      }),
    );
    const log = vi.fn();
    const logError = vi.fn();
    const result = launcher.runDatabaseRoleBoundaryTests({
      buildChildLaunch,
      createChildController,
      environment,
      spawn: spawn as NonNullable<LauncherDependencies["spawn"]>,
      deadlineMs: 5_000,
      heartbeatMs: 1_000,
      log,
      logError,
    });

    expect(spawn).toHaveBeenCalledTimes(10);
    launcher.DATABASE_ROLE_BOUNDARY_TEST_LANES.forEach((testLane, index) => {
      const args = [
        "--experimental-test-isolation=none",
        "--test",
        ...(testLane.namePattern === undefined
          ? []
          : [`--test-name-pattern=${testLane.namePattern}`]),
        testLane.file,
      ];
      const sanitizedEnvironment = {
        CI: environment.CI,
        LANG: environment.LANG,
        SYSTEMROOT: environment.SYSTEMROOT,
        TEMP: environment.TEMP,
      };
      expect(buildChildLaunch).toHaveBeenNthCalledWith(
        index + 1,
        {
          command: process.execPath,
          args,
          environment: sanitizedEnvironment,
        },
      );
      expect(spawn).toHaveBeenNthCalledWith(
        index + 1,
        "supervisor-canary",
        ["--supervised", ...args],
        {
          detached: false,
          env: {
            ...sanitizedEnvironment,
            CODESTEAD_SUPERVISED: "1",
          },
          stdio: "inherit",
          windowsHide: true,
        },
      );
    });
    expect(
      JSON.stringify([buildChildLaunch.mock.calls, spawn.mock.calls]),
    ).not.toMatch(
      /token-canary|secret-canary|key-canary|credential-canary|cloud-|proxy-canary|alternate-database|pg-/u,
    );
    completeChildren(children, Array.from({ length: 10 }, () => 0));
    await expect(result).resolves.toBe(0);
    expect(completeAndWait).toHaveLength(10);
    expect(completeAndWait.every(
      (wait) => wait.mock.calls.length === 1
        && wait.mock.calls[0]?.[0] === "SIGTERM",
    )).toBe(true);
    expect(logError).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(([message]) => String(message).includes(" START ")))
      .toHaveLength(10);
    expect(log.mock.calls.filter(([message]) => String(message).includes(" PASS ")))
      .toHaveLength(10);
  });

  it("fails closed without spawning when supervised launch construction fails", async () => {
    const launcher = await loadLauncher();
    expect(launcher).not.toBeNull();
    if (!launcher) return;

    const harness = fakeSpawnHarness();
    const logError = vi.fn();
    await expect(launcher.runDatabaseRoleBoundaryTests({
      buildChildLaunch: () => {
        throw new Error("supervisor-secret-canary");
      },
      createChildController: harness.createChildController,
      environment: minimalLauncherEnvironment(),
      spawn: harness.spawn as NonNullable<LauncherDependencies["spawn"]>,
      deadlineMs: 5_000,
      heartbeatMs: 1_000,
      log: vi.fn(),
      logError,
    })).resolves.toBe(1);
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(10);
    expect(JSON.stringify(logError.mock.calls)).not.toContain(
      "supervisor-secret-canary",
    );
  });

  it("preserves lane order for failures and fails closed for null status", async () => {
    const launcher = await loadLauncher();
    expect(launcher).not.toBeNull();
    if (!launcher) return;

    const { children, createChildController, spawn } = fakeSpawnHarness();
    const result = launcher.runDatabaseRoleBoundaryTests({
      createChildController,
      environment: minimalLauncherEnvironment(),
      spawn: spawn as NonNullable<LauncherDependencies["spawn"]>,
      deadlineMs: 5_000,
      heartbeatMs: 1_000,
      log: vi.fn(),
      logError: vi.fn(),
    });
    expect(spawn).toHaveBeenCalledTimes(10);
    completeChildren(children, [0, 7, null, 0, 0, 0, 0, 0, 0, 0]);
    await expect(result).resolves.toBe(7);

    const nullHarness = fakeSpawnHarness();
    const nullResult = launcher.runDatabaseRoleBoundaryTests({
      createChildController: nullHarness.createChildController,
      environment: minimalLauncherEnvironment(),
      spawn: nullHarness.spawn as NonNullable<
        LauncherDependencies["spawn"]
      >,
      deadlineMs: 5_000,
      heartbeatMs: 1_000,
      log: vi.fn(),
      logError: vi.fn(),
    });
    completeChildren(
      nullHarness.children,
      [0, 0, null, 0, 0, 0, 0, 0, 0, 0],
    );
    await expect(nullResult).resolves.toBe(1);
  });

  it("keeps healthy lanes running after spawn and child errors without leaking details", async () => {
    const launcher = await loadLauncher();
    expect(launcher).not.toBeNull();
    if (!launcher) return;

    const children: FakeChild[] = [];
    let invocation = 0;
    const spawn = vi.fn(() => {
      invocation += 1;
      if (invocation === 3) {
        throw new Error("spawn-secret-canary");
      }
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const log = vi.fn();
    const logError = vi.fn();
    const spawnErrorControllers = fakeSpawnHarness();
    const result = launcher.runDatabaseRoleBoundaryTests({
      createChildController: spawnErrorControllers.createChildController,
      environment: minimalLauncherEnvironment(),
      spawn: spawn as NonNullable<LauncherDependencies["spawn"]>,
      deadlineMs: 5_000,
      heartbeatMs: 1_000,
      log,
      logError,
    });
    expect(spawn).toHaveBeenCalledTimes(10);
    completeChildren(children, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    await expect(result).resolves.toBe(1);
    expect(JSON.stringify(logError.mock.calls)).not.toContain(
      "spawn-secret-canary",
    );

    const childErrorHarness = fakeSpawnHarness();
    const childErrorLog = vi.fn();
    const childErrorResult = launcher.runDatabaseRoleBoundaryTests({
      createChildController: childErrorHarness.createChildController,
      environment: minimalLauncherEnvironment(),
      spawn: childErrorHarness.spawn as NonNullable<
        LauncherDependencies["spawn"]
      >,
      deadlineMs: 5_000,
      heartbeatMs: 1_000,
      log: vi.fn(),
      logError: childErrorLog,
    });
    childErrorHarness.children[0]?.emit(
      "error",
      new Error("child-secret-canary"),
    );
    completeChildren(
      childErrorHarness.children,
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    await expect(childErrorResult).resolves.toBe(1);
    expect(JSON.stringify(childErrorLog.mock.calls)).not.toContain(
      "child-secret-canary",
    );
  });

  it("times out only the stalled lane and cleans every timer", async () => {
    vi.useFakeTimers();
    try {
      const launcher = await loadLauncher();
      expect(launcher).not.toBeNull();
      if (!launcher) return;

      const termination = deferredCompletion();
      const {
        children,
        completeAndWait,
        createChildController,
        spawn,
      } = fakeSpawnHarness((index) =>
        index === 0 ? termination.promise : Promise.resolve()
      );
      const log = vi.fn();
      const logError = vi.fn();
      const result = launcher.runDatabaseRoleBoundaryTests({
        createChildController,
        environment: minimalLauncherEnvironment(),
        spawn: spawn as NonNullable<LauncherDependencies["spawn"]>,
        deadlineMs: 60_000,
        heartbeatMs: 15_000,
        terminationGraceMs: 1_000,
        log,
        logError,
      });
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      completeChildren(children.slice(1), Array.from({ length: 9 }, () => 0));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(log).toHaveBeenCalledWith(
        "database-role-boundary lane HEARTBEAT manifest-inventory",
      );
      await vi.advanceTimersByTimeAsync(45_000);
      expect(settled).toBe(false);
      expect(completeAndWait[0]).toHaveBeenCalledWith("SIGTERM");
      expect(children.every((child) => child.kill.mock.calls.length === 0))
        .toBe(true);
      termination.resolve();
      await expect(result).resolves.toBe(1);
      expect(logError).toHaveBeenCalledWith(
        "database-role-boundary lane TIMEOUT manifest-inventory",
      );
      children[0]?.emit("close", 0, null);
      expect(
        log.mock.calls.filter(
          ([message]) => String(message).includes(" PASS manifest-inventory"),
        ),
      ).toHaveLength(0);
      expect(
        logError.mock.calls.filter(
          ([message]) => String(message).includes(" manifest-inventory"),
        ),
      ).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when timeout cleanup cannot prove tree termination", async () => {
    vi.useFakeTimers();
    try {
      const launcher = await loadLauncher();
      expect(launcher).not.toBeNull();
      if (!launcher) return;

      const cleanup = deferredCompletion();
      const rejected = fakeSpawnHarness((index) =>
        index === 0 ? cleanup.promise : Promise.resolve()
      );
      const rejectedLog = vi.fn();
      const rejectedResult = launcher.runDatabaseRoleBoundaryTests({
        createChildController: rejected.createChildController,
        environment: minimalLauncherEnvironment(),
        spawn: rejected.spawn as NonNullable<LauncherDependencies["spawn"]>,
        deadlineMs: 60_000,
        heartbeatMs: 15_000,
        terminationGraceMs: 1_000,
        log: vi.fn(),
        logError: rejectedLog,
      });
      completeChildren(
        rejected.children.slice(1),
        Array.from({ length: 9 }, () => 0),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      let settled = false;
      void rejectedResult.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      cleanup.reject(new Error("cleanup-secret-canary"));
      await expect(rejectedResult).resolves.toBe(1);
      expect(rejectedLog).toHaveBeenCalledWith(
        "database-role-boundary lane FAIL manifest-inventory",
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(JSON.stringify(rejectedLog.mock.calls)).not.toContain(
        "cleanup-secret-canary",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("executes the real CLI entrypoint from an unrelated working directory", () => {
    const tokenCanary = "launcher-cli-token-canary";
    const result = nodeSpawnSync(
      process.execPath,
      [
        path.join(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
        path.join(
          repositoryRoot,
          "scripts/run-database-role-boundaries-tests.ts",
        ),
      ],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        env: {
          ...process.env,
          ARBITRARY_TOKEN: tokenCanary,
        },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).toContain(
      "publishes the exact migration-derived 0069 public and Drizzle inventory",
    );
    expect(output).toContain(
      "independently normalizes and accepts the exact current catalog",
    );
    expect(output).toContain(
      "database-role-boundary lane PASS role-boundary",
    );
    expect(output).not.toContain(tokenCanary);
  }, 135_000);
});
