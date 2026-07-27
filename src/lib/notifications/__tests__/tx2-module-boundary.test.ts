import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = process.cwd();
const MATERIALIZATION_MODULE =
  "src/lib/notifications/prepared-dispatch-materialization.ts";
const POSTGRES_STORE_MODULE = "src/lib/notifications/postgres-outbox-store.ts";
const INTERNAL_TRANSPORT_MODULE =
  "src/lib/notifications/mailer-transport-internal.ts";
const LEGACY_MAILER_MODULE = "src/lib/notifications/mailer.ts";
const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const CYCLE_PASS_MARKER = "mail_tx2_module_cycle=PASS\n";

const PHYSICAL_SEND_EXPORTS = Object.freeze([
  "authorizePreparedEmail",
  "capturePreparedMailTransportPlan",
  "discardPreparedEmailAuthorization",
  "discardPreparedMailTransportPlan",
  "sendPreparedEmail",
]);

type ModuleAccess = Readonly<{
  importer: string;
  target: "internal-transport" | "materialization";
  form: string;
  importedNames: readonly string[];
}>;

function repositoryPath(filePath: string) {
  return relative(REPOSITORY_ROOT, filePath).split(sep).join("/");
}

function isInventorySource(filePath: string) {
  if (!/\.(?:[cm]?[jt]sx?)$/.test(filePath)) return false;
  const path = repositoryPath(filePath);
  if (path.includes("/node_modules/")) return false;
  if (path.includes("/__tests__/") || path.includes("/fixtures/")) return false;
  if (
    (path.startsWith("src/") || path.startsWith("scripts/")) &&
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  ) {
    return false;
  }
  return true;
}

function inventoryFiles() {
  const files: string[] = [];
  const visit = (entryPath: string) => {
    for (const entry of readdirSync(entryPath, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const childPath = resolve(entryPath, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "__tests__" ||
          entry.name === "fixtures"
        ) {
          continue;
        }
        visit(childPath);
      } else if (entry.isFile() && isInventorySource(childPath)) {
        files.push(childPath);
      }
    }
  };

  for (const root of ["src", "scripts", "integration"]) {
    visit(resolve(REPOSITORY_ROOT, root));
  }
  return files;
}

function moduleTarget(
  moduleSpecifier: string,
): ModuleAccess["target"] | undefined {
  const normalized = moduleSpecifier
    .replaceAll("\\", "/")
    .replace(/\.(?:[cm]?[jt]sx?)$/, "");
  if (normalized.endsWith("/mailer-transport-internal")) {
    return "internal-transport";
  }
  if (normalized.endsWith("/prepared-dispatch-materialization")) {
    return "materialization";
  }
  return undefined;
}

function importedName(specifier: ts.ImportSpecifier | ts.ExportSpecifier) {
  return (specifier.propertyName ?? specifier.name).text;
}

function stringArgument(node: ts.CallExpression) {
  const argument = node.arguments[0];
  return argument &&
    (ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function collectModuleAccesses(filePath: string) {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const accesses: ModuleAccess[] = [];
  const importer = repositoryPath(filePath);

  const record = (
    moduleSpecifier: string,
    form: string,
    importedNames: readonly string[],
  ) => {
    const target = moduleTarget(moduleSpecifier);
    if (target) {
      accesses.push({ importer, target, form, importedNames });
    }
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      if (!clause) {
        record(node.moduleSpecifier.text, "side-effect import", []);
      } else {
        if (clause.name) {
          record(node.moduleSpecifier.text, "default import", ["*"]);
        }
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          record(node.moduleSpecifier.text, "namespace import", ["*"]);
        } else if (bindings) {
          record(
            node.moduleSpecifier.text,
            "named import",
            bindings.elements.map(importedName),
          );
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
        record(node.moduleSpecifier.text, "namespace re-export", ["*"]);
      } else {
        record(
          node.moduleSpecifier.text,
          "named re-export",
          node.exportClause.elements.map(importedName),
        );
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      record(node.moduleReference.expression.text, "import-equals require", [
        "*",
      ]);
    } else if (ts.isCallExpression(node)) {
      const requestedModule = stringArgument(node);
      if (
        requestedModule &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        record(
          requestedModule,
          node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? "dynamic import"
            : "require call",
          ["*"],
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return accesses;
}

function staticPropertyName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function isProcessStdoutWrite(node: ts.CallExpression) {
  if (staticPropertyName(node.expression) !== "write") return false;
  const stdoutExpression = ts.isPropertyAccessExpression(node.expression)
    ? node.expression.expression
    : ts.isElementAccessExpression(node.expression)
      ? node.expression.expression
      : undefined;
  if (!stdoutExpression || staticPropertyName(stdoutExpression) !== "stdout") {
    return false;
  }
  const processExpression = ts.isPropertyAccessExpression(stdoutExpression)
    ? stdoutExpression.expression
    : ts.isElementAccessExpression(stdoutExpression)
      ? stdoutExpression.expression
      : undefined;
  return (
    processExpression !== undefined &&
    ts.isIdentifier(processExpression) &&
    processExpression.text === "process"
  );
}

function physicalPrimitiveLocations(filePath: string) {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let gmailSendUrl = false;
  let stdoutWrite = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === GMAIL_SEND_URL
    ) {
      gmailSendUrl = true;
    }
    if (ts.isCallExpression(node) && isProcessStdoutWrite(node)) {
      stdoutWrite = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { gmailSendUrl, stdoutWrite };
}

function strictChildEnvironment() {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "HOME",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

describe("TX2 module authority boundary", () => {
  it("keeps authority-bearing imports on the exact store-to-channel path", () => {
    const accesses = inventoryFiles().flatMap(collectModuleAccesses);
    const violations: string[] = [];
    const physicalAccesses: string[] = [];
    const channelFactoryAccesses: string[] = [];

    for (const access of accesses) {
      if (access.target === "internal-transport") {
        const authorityNames = access.importedNames.includes("*")
          ? ["*"]
          : access.importedNames.filter((name) =>
              PHYSICAL_SEND_EXPORTS.includes(name),
            );
        for (const name of authorityNames) {
          physicalAccesses.push(`${access.importer}:${name}`);
          if (access.importer !== MATERIALIZATION_MODULE) {
            violations.push(
              `${access.importer} has ${access.form} access to ${name}`,
            );
          }
        }
      }

      if (
        access.target === "materialization" &&
        (access.importedNames.includes("*") ||
          access.importedNames.includes(
            "createStoreBoundPreparedDispatchChannel",
          ))
      ) {
        const name = access.importedNames.includes("*")
          ? "*"
          : "createStoreBoundPreparedDispatchChannel";
        channelFactoryAccesses.push(`${access.importer}:${name}`);
        if (access.importer !== POSTGRES_STORE_MODULE) {
          violations.push(
            `${access.importer} has ${access.form} access to ${name}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
    expect(physicalAccesses.sort()).toEqual(
      PHYSICAL_SEND_EXPORTS.map(
        (name) => `${MATERIALIZATION_MODULE}:${name}`,
      ).sort(),
    );
    expect(channelFactoryAccesses).toEqual([
      `${POSTGRES_STORE_MODULE}:createStoreBoundPreparedDispatchChannel`,
    ]);
  });

  it("isolates both physical delivery primitives in the internal transport", () => {
    const notificationFiles = inventoryFiles().filter((filePath) =>
      repositoryPath(filePath).startsWith("src/lib/notifications/"),
    );
    const gmailSendLocations: string[] = [];
    const stdoutWriteLocations: string[] = [];

    for (const filePath of notificationFiles) {
      const locations = physicalPrimitiveLocations(filePath);
      if (locations.gmailSendUrl) {
        gmailSendLocations.push(repositoryPath(filePath));
      }
      if (locations.stdoutWrite) {
        stdoutWriteLocations.push(repositoryPath(filePath));
      }
    }

    expect(gmailSendLocations).toEqual([INTERNAL_TRANSPORT_MODULE]);
    expect(stdoutWriteLocations).toEqual([INTERNAL_TRANSPORT_MODULE]);

    const legacyLocations = physicalPrimitiveLocations(
      resolve(REPOSITORY_ROOT, LEGACY_MAILER_MODULE),
    );
    expect(legacyLocations).toEqual({
      gmailSendUrl: false,
      stdoutWrite: false,
    });
  });

  it("initializes the complete TX2 cycle in a clean process", () => {
    const fixturePath = resolve(
      REPOSITORY_ROOT,
      "src/lib/notifications/__tests__/fixtures/tx2-module-cycle-smoke.ts",
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", fixturePath],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: strictChildEnvironment(),
        timeout: 10_000,
        windowsHide: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(CYCLE_PASS_MARKER);
  });
});
