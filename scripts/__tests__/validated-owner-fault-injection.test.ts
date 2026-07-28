import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pgMock = vi.hoisted(() => ({
  Pool: vi.fn(),
}));

const drizzleMock = vi.hoisted(() => ({
  createDrizzle: vi.fn(),
  migrate: vi.fn(),
}));

const migrationManifestMock = vi.hoisted(() => ({
  readMigrationFiles: vi.fn(),
}));

const reviewedLedgerMock = vi.hoisted(() => ({
  verifyAppliedMigrationLedger: vi.fn(),
  verifyReviewedMigrationRepository: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: pgMock.Pool,
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: drizzleMock.createDrizzle,
}));

vi.mock("drizzle-orm/node-postgres/migrator", () => ({
  migrate: drizzleMock.migrate,
}));

vi.mock("drizzle-orm/migrator", () => ({
  readMigrationFiles: migrationManifestMock.readMigrationFiles,
}));

vi.mock("../lib/reviewed-migration-ledger.mjs", () => ({
  verifyAppliedMigrationLedger: reviewedLedgerMock.verifyAppliedMigrationLedger,
  verifyReviewedMigrationRepository:
    reviewedLedgerMock.verifyReviewedMigrationRepository,
}));

import * as ownerFaultModule
  from "../../integration/support/with-validated-owner-fault-injection";

const {
  ageValidatedDisposableTerminalEmailOutboxFixtures,
  readValidatedIntegrationMigrationJournal,
  runValidatedIntegrationMigrations,
  withValidatedOwnerFaultInjection,
} = ownerFaultModule;

const VALID_APP_URL =
  "postgresql://learncoding_app:test-app-password@127.0.0.1:55491/learncoding_integration";
const VALID_OWNER_URL =
  "postgresql://learncoding_migrator:test-password@127.0.0.1:55491/learncoding_integration?options=-c+role%3Dlearncoding_owner";
const VALID_DATABASE_TARGET = Object.freeze({
  databaseApplicationUrl: VALID_APP_URL,
  databaseOwnerUrl: VALID_OWNER_URL,
});
const DECOY_OWNER_URL =
  "postgresql://learncoding_migrator:decoy-password@127.0.0.1:59999/learncoding_integration?options=-c+role%3Dlearncoding_owner";
const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const WORKSPACE_MIGRATIONS_FOLDER = path.resolve(WORKSPACE_ROOT, "drizzle");
const execFile = promisify(execFileCallback);
const REVIEWED_MIGRATIONS = [
  { folderMillis: 1_780_000_000_001, hash: "a".repeat(64) },
  { folderMillis: 1_780_000_000_002, hash: "b".repeat(64) },
] as const;
const REVIEWED_JOURNAL_ROWS = REVIEWED_MIGRATIONS.map(
  ({ folderMillis, hash }) => ({
    created_at: String(folderMillis),
    hash,
  }),
);

const previousEnvironment = {
  DATABASE_OWNER_URL: process.env.DATABASE_OWNER_URL,
  INTEGRATION_TEST: process.env.INTEGRATION_TEST,
};

type FixtureContract = Readonly<{
  cleanupSqlSha256: readonly [string, string];
  context: string;
  functionName: string;
  installSqlSha256: readonly [string, string];
  relativePath: string;
  tableName: string;
  triggerName: string;
}>;

type SourceFixtureContract = Readonly<{
  cleanupSqlSha256: readonly [string, string];
  context: string;
  functionName: string;
  installSqlSha256: readonly [string, string];
  tableName: string;
  triggerName: string;
}>;

type SqlLiteral = Readonly<{
  node: ts.Expression;
  text: string;
}>;

const FIXTURE_CONTRACTS: readonly FixtureContract[] = [
  {
    cleanupSqlSha256: [
      "a74cdefb18c96d959ff3e0ce536a50132cd2a74df81790e044de657b9271d3c6",
      "9f13de2f9af225cfafcc3068613f2e770a3cb92da1e3918cb08ef35934ddab7e",
    ],
    context: "Admin-plan",
    functionName: "fail_plan_change_notification",
    installSqlSha256: [
      "20a3668f2158a28e4666c8fa8df5a3978ff0487d6810cbb1b8342c261386b320",
      "5f3488554619ba5a8fd0414e3bd446c8f1c23561da87ba4f23fdcf96f417949e",
    ],
    relativePath: "integration/admin-plan.integration.test.ts",
    tableName: "notification",
    triggerName: "fail_plan_change_notification",
  },
  {
    cleanupSqlSha256: [
      "3152ef911817ce85470420e1711e8f56584638c43047ded3287397a2085d7518",
      "642941a1823a98083356b58518c48bacbd9ec5f2fc94dac2d089d1ac182f96d1",
    ],
    context: "Auth-recovery",
    functionName: "integration_fail_revocation_decision",
    installSqlSha256: [
      "32b0eac2b98f998f425df3a2ed1b6423ecb2c15f801bf514874b05295bc93860",
      "de7d6470d1aae7e562812e2fef3095fb7692f5864dc566bfddcbfa23cd5557e8",
    ],
    relativePath: "integration/auth-recovery.integration.test.ts",
    tableName: "session_revocation_request",
    triggerName: "integration_fail_revocation_decision_trigger",
  },
  {
    cleanupSqlSha256: [
      "bb97e85a41954eaa9e35125c80d9fec384c2836a8a0ac770b67f571d51dae2e2",
      "bb83b1ae8465e68fbacfe9ecde44d52a47170e0f9535694cd1710da766dff9b7",
    ],
    context: "Exam-autosave",
    functionName: "integration_fail_exam_autosave_receipt",
    installSqlSha256: [
      "a8c805553a4882e72843d7f6228959132066eda2e29d2530e4f5af71cd980196",
      "c3cad100605a14afcd3469884b7307ebf93e8cca0852542f72a43f1d52ab49df",
    ],
    relativePath: "integration/exam-autosave-idempotency.integration.test.ts",
    tableName: "exam_autosave_mutation",
    triggerName: "integration_fail_exam_autosave_receipt",
  },
  {
    cleanupSqlSha256: [
      "c8d2ee0b524d4b81c45f35e7791574e831fcbe8dafb78933fa085a873829e5c9",
      "8884bf3812d7dfaf45da5527eb95735c0dce98ef328dc1f26f82fe0ce0e59d7d",
    ],
    context: "Practice-learning",
    functionName: "practice_help_test_reject",
    installSqlSha256: [
      "42fe6b7255a91af9988d2333ec95187857b65df26abc265abda1b7a00b9f7545",
      "18c4132dbc9dc06fdfb464071eea1ae6c6fb5f46cfde6985162144f9f4dadce8",
    ],
    relativePath: "integration/practice-learning.integration.test.ts",
    tableName: "practice_help_event",
    triggerName: "practice_help_test_reject",
  },
  {
    cleanupSqlSha256: [
      "b8535892a1405805b8e1d57b846f4bc3e78a77bc130b7006122f2af6a74a76bf",
      "1f7972cbe5c88763ce4d164e0547a4c1be424715d226d50697fe83ec1d9a6f98",
    ],
    context: "Power-rehearsal",
    functionName: "integration_fail_rehearsal_audit",
    installSqlSha256: [
      "f364667f6d3a9babe1b652271897cba7118d70d61121f00acc1cc20d46c3804c",
      "bf3dcb8028a0ad6e42c33f592cc97d10689ae4769178f95878b16cb9db12a4eb",
    ],
    relativePath: "integration/runner-power-rehearsal-admin.integration.test.ts",
    tableName: "audit_event",
    triggerName: "integration_fail_rehearsal_audit",
  },
{
    cleanupSqlSha256: [
      "a4c72bb7e0f208eafb96eabf5c83a54e404f032822869c283ea0f3d443c284b3",
      "3dc146f10ca90991d9b75ed689f03f1aafe5430edbb62f48c9a28b7f0a459018",
    ],
    context: "Retention-redaction",
    functionName: "integration_fail_retention_redaction",
    installSqlSha256: [
      "fad5357193d5646cfdd4a95cf2262cf10555a51fdf0632117607acf7737b369a",
      "bba840e99406106c43b5e0699fd8525ceaa1e9293f756980c5b81f1d8cffcc27",
    ],
    relativePath: "integration/retention-ops-session.integration.test.ts",
    tableName: "email_outbox",
    triggerName: "aa_integration_fail_retention_redaction",
  },
];

const RESET_FAULT_CONTRACT = {
  cleanupSqlSha256: [
    "97503c307b27a258d7e273e54668bc5b33762cc338e0ae96a4b9e379ed8d0e26",
    "d3b5066b013e43975d215fc00e98dcc148637c9a3f1b9bb52c5d019b635281a9",
  ],
  context: "disposable reset truncate rollback",
  installSqlSha256: [
    "13cf3531eea8d17804865bd767a0867ff9a4c8fc7cc11811ce0b33f252658076",
    "f3227be9927f3480a6e1b453e303823e2f45d9ad847a30730d541233433b6af2",
  ],
  relativePath: "integration/disposable-integration-reset.integration.test.ts",
} as const;

const RESET_OUTGOING_DEPENDENCY_FAULT_CONTRACT = {
  cleanupSqlSha256: [
    "561e3ddefb2864cb11f5e43d843bb84ae6fb9d68fedc332a88e0cb7a88f53922",
  ],
  context: "disposable reset outgoing dependency closed world",
  installSqlSha256: [
    "40605d4a67eed10e8bc229756b07cedfc1a07567c92e05c76cd6594f871be19a",
  ],
  relativePath: "integration/disposable-integration-reset.integration.test.ts",
} as const;

const DISPATCH_IDENTITY_PROBE_CONTRACT = {
  cleanupSqlSha256: [
    "6606345e39ba4493832a3074b4c1448f71aa8accae1279a54c06673a553b16b6",
    "0db8cefcc23a276e561ca0b2d34852db00bc03103fa8fab4fefc191754870695",
  ],
  context: "0064-dispatch-identity-probe",
  installSqlSha256: [
    "bca90b54b7e120b3941462920314c313a5c248aeab972c8d0277b9b8fca011b4",
    "8ee7b66cd92d88552e96617ba6f333779e4b26bf196fe60d76e6d4d22695cc0c",
    "1a54de019f9eb952d8c070e51c6772c30f044c45dd42da78c9c24015b4042f85",
  ],
  relativePath: "integration/mail-dispatch-binding-0064.integration.test.ts",
} as const;
const RESET_NAMESPACE_FAULT = {
  databaseTarget: VALID_DATABASE_TARGET,
  cleanupSql: [
    "DROP COLLATION IF EXISTS codestead_disposable_test.hostile_reset_collation",
  ],
  context: "disposable reset namespace closed world",
  installSql: [
    "CREATE COLLATION codestead_disposable_test.hostile_reset_collation (provider = libc, locale = 'C')",
  ],
} as const;

const OWNER_DDL_PATTERN =
  /(?:^|;)\s*(?:create(?:\s+or\s+replace)?|drop|alter|grant|revoke|truncate|do)\b/i;

function identityResult(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{
      current_database: "learncoding_integration",
      current_user: "learncoding_owner",
      session_user: "learncoding_migrator",
      ...overrides,
    }],
  };
}

function propertyName(property: ts.ObjectLiteralElementLike) {
  if (!ts.isPropertyAssignment(property)) return undefined;
  if (
    ts.isIdentifier(property.name)
    || ts.isStringLiteral(property.name)
    || ts.isNumericLiteral(property.name)
  ) {
    return property.name.text;
  }
  return undefined;
}

function unwrapStaticStringExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticStringValues(
  input: ts.Expression,
  bindings: ReadonlyMap<string, readonly ts.Expression[]>,
  seen: ReadonlySet<string> = new Set(),
): readonly string[] {
  const node = unwrapStaticStringExpression(input);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isTemplateExpression(node)) {
    let values = [node.head.text];
    for (const span of node.templateSpans) {
      const expressions = staticStringValues(span.expression, bindings, seen);
      if (expressions.length === 0) return [];
      values = values.flatMap((prefix) => expressions.map((value) => (
        `${prefix}${value}${span.literal.text}`
      )));
      if (values.length > 64) return [];
    }
    return [...new Set(values)];
  }
  if (
    ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringValues(node.left, bindings, seen);
    const right = staticStringValues(node.right, bindings, seen);
    if (left.length === 0 || right.length === 0) return [];
    const combined = left.flatMap((prefix) => right.map((suffix) => (
      `${prefix}${suffix}`
    )));
    return combined.length <= 64 ? [...new Set(combined)] : [];
  }
  if (
    ts.isCallExpression(node)
    && node.arguments.length <= 1
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "join"
  ) {
    const target = unwrapStaticStringExpression(node.expression.expression);
    if (!ts.isArrayLiteralExpression(target)) return [];
    const separators = node.arguments[0]
      ? staticStringValues(node.arguments[0], bindings, seen)
      : [","];
    const joined = separators.flatMap((separator) => {
      let values = [""];
      for (const [index, element] of target.elements.entries()) {
        if (ts.isSpreadElement(element)) return [];
        const elements = staticStringValues(element, bindings, seen);
        if (elements.length === 0) return [];
        values = values.flatMap((prefix) => elements.map((value) => (
          `${prefix}${index === 0 ? "" : separator}${value}`
        )));
        if (values.length > 64) return [];
      }
      return values;
    });
    return joined.length <= 64 ? [...new Set(joined)] : [];
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return [];
    const nextSeen = new Set(seen);
    nextSeen.add(node.text);
    return [...new Set((bindings.get(node.text) ?? []).flatMap((initializer) => (
      staticStringValues(initializer, bindings, nextSeen)
    )))];
  }
  return [];
}

function scanOwnerAuthoritySource(sourceText: string, fileName: string) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = new Map<string, ts.Expression[]>();
  const collectBindings = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      const current = bindings.get(node.name.text) ?? [];
      current.push(node.initializer);
      bindings.set(node.name.text, current);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const violations = new Set<string>();
  const inspectValue = (value: string) => {
    const candidates = new Set<string>();
    let candidate = value;
    for (let pass = 0; pass < 4; pass += 1) {
      candidates.add(candidate);
      try {
        const decoded = decodeURIComponent(candidate.replaceAll("+", "%20"));
        if (decoded === candidate) break;
        candidate = decoded;
      } catch {
        break;
      }
    }
    for (const candidate of candidates) {
      if (candidate.includes("DATABASE_OWNER_URL")) {
        violations.add("raw DATABASE_OWNER_URL authority");
      }
      const sql = candidate
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\r\n]*/g, " ");
      if (
        /(?:^|;)\s*set\s+(?:(?:local|session)\s+)?role\b/i.test(sql)
        || /(?:^|;)\s*reset\s+role\b/i.test(sql)
        || /(?:^|;)\s*set\s+session\s+authorization\b/i.test(sql)
        || /\bset_config\s*\(\s*[^,]{0,64}\b(?:role|session_authorization)\b/i.test(sql)
      ) {
        violations.add("direct or dynamic database role assumption");
      }
      if (
        /(?:^|[?&;\s])(?:options\s*=\s*)?(?:-c\s+)?role\s*=\s*learncoding_owner\b/i
          .test(sql)
      ) {
        violations.add("encoded learncoding_owner connection role");
      }
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "DATABASE_OWNER_URL") {
      violations.add("raw DATABASE_OWNER_URL identifier");
    }
    if (
      ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateExpression(node)
      || ts.isBinaryExpression(node)
      || ts.isCallExpression(node)
      || ts.isIdentifier(node)
    ) {
      for (const value of staticStringValues(node as ts.Expression, bindings)) {
        inspectValue(value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...violations].sort();
}

function validateReadOnlyOwnerTopologySource(sourceText: string, fileName: string) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const errors: string[] = [];
  const ownerEnvironmentLiterals: ts.StringLiteralLike[] = [];
  const ownerOptionLiterals: ts.StringLiteralLike[] = [];
  const ownerUrlDeclarations: ts.VariableDeclaration[] = [];
  const ownerUrlIdentifiers: ts.Identifier[] = [];
  const ownerParsers: ts.CallExpression[] = [];
  const topologyDeclarations: ts.VariableDeclaration[] = [];
  const poolConnections: string[] = [];
  const poolPositions: number[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) {
      if (node.text === "DATABASE_OWNER_URL") ownerEnvironmentLiterals.push(node);
      if (node.text === "?options=-c+role%3Dlearncoding_owner") {
        ownerOptionLiterals.push(node);
      }
    }
    if (ts.isIdentifier(node) && node.text === "ownerUrl") {
      ownerUrlIdentifiers.push(node);
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "ownerUrl"
    ) {
      ownerUrlDeclarations.push(node);
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "DISPOSABLE_DATABASES"
    ) {
      topologyDeclarations.push(node);
    }
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "parseDisposableRoleUrl"
      && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === "DATABASE_OWNER_URL"
    ) {
      ownerParsers.push(node);
    }
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "Pool"
    ) {
      poolPositions.push(node.getStart(sourceFile));
      const options = node.arguments?.[0];
      if (!options || !ts.isObjectLiteralExpression(options)) {
        errors.push("Pool must receive a direct options object");
      } else {
        const connections = options.properties.filter((property) => (
          propertyName(property) === "connectionString"
        ));
        const connection = connections[0];
        if (
          connections.length !== 1
          || !connection
          || !ts.isPropertyAssignment(connection)
          || !ts.isPropertyAccessExpression(connection.initializer)
          || !ts.isIdentifier(connection.initializer.expression)
          || connection.initializer.expression.text !== "DISPOSABLE_DATABASES"
        ) {
          errors.push("Pool must use only validated lower-role topology");
        } else {
          poolConnections.push(connection.initializer.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const ownerDeclaration = ownerUrlDeclarations[0];
  if (
    ownerUrlDeclarations.length !== 1
    || !ownerDeclaration?.initializer
    || !ts.isCallExpression(ownerDeclaration.initializer)
    || !ts.isIdentifier(ownerDeclaration.initializer.expression)
    || ownerDeclaration.initializer.expression.text !== "requiredEnvironment"
    || ownerDeclaration.initializer.arguments.length !== 1
    || !ts.isStringLiteral(ownerDeclaration.initializer.arguments[0])
    || ownerDeclaration.initializer.arguments[0].text !== "DATABASE_OWNER_URL"
  ) {
    errors.push("owner URL must come from one required environment read");
  }
  const ownerParser = ownerParsers[0];
  if (
    ownerParsers.length !== 1
    || ownerParser.arguments.length !== 4
    || !ts.isStringLiteral(ownerParser.arguments[1])
    || ownerParser.arguments[1].text !== "learncoding_migrator"
    || !ts.isIdentifier(ownerParser.arguments[2])
    || ownerParser.arguments[2].text !== "ownerUrl"
    || !ts.isStringLiteral(ownerParser.arguments[3])
    || ownerParser.arguments[3].text !== "?options=-c+role%3Dlearncoding_owner"
  ) {
    errors.push("owner URL must be parsed only as the exact read-only topology role");
  }
  if (ownerEnvironmentLiterals.length !== 2 || ownerOptionLiterals.length !== 1) {
    errors.push("owner topology literals must have exact cardinality");
  }
  if (ownerUrlIdentifiers.length !== 3) {
    errors.push("owner URL must flow only through its parser and frozen target");
  }
  const topologyDeclaration = topologyDeclarations[0];
  if (
    topologyDeclarations.length !== 1
    || !topologyDeclaration?.initializer
    || !ts.isCallExpression(topologyDeclaration.initializer)
    || !ts.isIdentifier(topologyDeclaration.initializer.expression)
    || topologyDeclaration.initializer.expression.text
      !== "validateDisposableDatabaseTopology"
    || poolPositions.some((position) => (
      position < topologyDeclaration.getStart(sourceFile)
    ))
  ) {
    errors.push("topology validation must complete before Pool construction");
  }
  if (
    poolConnections.length !== 3
    || [...poolConnections].sort().join(",")
      !== "applicationUrl,opsUrl,workerUrl"
  ) {
    errors.push("only app, worker, and ops URLs may reach Pool");
  }
  if (
    !sourceText.includes("ownerTarget: Object.freeze({")
    || !sourceText.includes("databaseApplicationUrl: applicationUrl,")
    || !sourceText.includes("databaseOwnerUrl: ownerUrl,")
    || !sourceText.includes(
      "databaseTarget: DISPOSABLE_DATABASES.ownerTarget,",
    )
  ) {
    errors.push("validated topology must freeze and explicitly hand off one owner/app target");
  }
  return errors;
}
async function scanWorkspaceOwnerAuthority() {
  const integrationRoot = path.resolve(WORKSPACE_ROOT, "integration");
  const privateHelper =
    "integration/support/with-validated-owner-fault-injection.ts";
  const entries = await readdir(integrationRoot, { recursive: true });
  const scannedFiles: string[] = [];
  const violations: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.endsWith(".ts")) continue;
    const relativePath = `integration/${entry.replaceAll("\\", "/")}`;
    if (relativePath === privateHelper) continue;
    scannedFiles.push(relativePath);
    const sourceText = await readFile(path.join(integrationRoot, entry), "utf8");
    let findings = scanOwnerAuthoritySource(sourceText, relativePath);
    if (
      relativePath
        === "integration/mail-dispatch-binding-0064.integration.test.ts"
    ) {
      const topologyErrors = validateReadOnlyOwnerTopologySource(
        sourceText,
        relativePath,
      );
      violations.push(...topologyErrors.map((error) => (
        `${relativePath}: ${error}`
      )));
      if (topologyErrors.length === 0) {
        const topologyOnlyFindings = new Set([
          "encoded learncoding_owner connection role",
          "raw DATABASE_OWNER_URL authority",
        ]);
        findings = findings.filter((finding) => (
          !topologyOnlyFindings.has(finding)
        ));
      }
    }
    violations.push(...findings.map((finding) => `${relativePath}: ${finding}`));
  }
  return {
    scannedFiles: scannedFiles.sort(),
    violations: violations.sort(),
  };
}

function sqlLiteral(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
): SqlLiteral | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { node, text: node.text };
  }
  if (ts.isTemplateExpression(node)) {
    return { node, text: node.getText(sourceFile) };
  }
  return undefined;
}

type ExtractedFaultInjectionInput = Readonly<{
  cleanupSql: readonly [string, string];
  context: string;
  installSql: readonly [string, string];
}>;

function ownerSqlSha256(sql: string) {
  return createHash("sha256")
    .update(sql.replace(/\r\n?/g, "\n"), "utf8")
    .digest("hex");
}

function sqlTupleSha256(sql: readonly [string, string]) {
  return [ownerSqlSha256(sql[0]), ownerSqlSha256(sql[1])] as const;
}

function extractFaultInjectionInput(
  sourceText: string,
  fileName: string,
  expectedContext?: string,
): ExtractedFaultInjectionInput {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "withValidatedOwnerFaultInjection"
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const selectedCalls = expectedContext === undefined
    ? calls
    : calls.filter((call) => {
      const input = call.arguments[0];
      if (!input || !ts.isObjectLiteralExpression(input)) return false;
      const contextProperties = input.properties.filter((candidate) => (
        propertyName(candidate) === "context"
      ));
      return (
        contextProperties.length === 1
        && ts.isPropertyAssignment(contextProperties[0])
        && ts.isStringLiteral(contextProperties[0].initializer)
        && contextProperties[0].initializer.text === expectedContext
      );
    });
  if (selectedCalls.length !== 1) {
    throw new Error(`${fileName} must contain exactly one direct owner fault call.`);
  }
  const input = selectedCalls[0]?.arguments[0];
  if (!input || !ts.isObjectLiteralExpression(input)) {
    throw new Error(`${fileName} owner fault call must use a direct object literal.`);
  }
  const property = (name: string) => {
    const matches = input.properties.filter((candidate) => (
      propertyName(candidate) === name
    ));
    if (matches.length !== 1 || !ts.isPropertyAssignment(matches[0])) {
      throw new Error(`${fileName} must contain one direct ${name} property.`);
    }
    return matches[0].initializer;
  };
  const context = property("context");
  if (!ts.isStringLiteral(context)) {
    throw new Error(`${fileName} context must be a static string literal.`);
  }
  const sqlTuple = (name: "installSql" | "cleanupSql") => {
    const value = property(name);
    if (!ts.isArrayLiteralExpression(value) || value.elements.length !== 2) {
      throw new Error(`${fileName} ${name} must contain exactly two literals.`);
    }
    const sql = value.elements.map((element) => {
      const literal = sqlLiteral(element as ts.Expression, sourceFile);
      if (!literal || ts.isTemplateExpression(element)) {
        throw new Error(`${fileName} ${name} must contain static SQL literals.`);
      }
      return literal.text;
    });
    return sql as unknown as readonly [string, string];
  };
  return {
    cleanupSql: sqlTuple("cleanupSql"),
    context: context.text,
    installSql: sqlTuple("installSql"),
  };
}

function extractVariableLengthFaultInjectionInput(
  sourceText: string,
  fileName: string,
  expectedContext: string,
  expectedInstallCount: number,
  expectedCleanupCount: number,
) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inputs: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "withValidatedOwnerFaultInjection"
    ) {
      const input = node.arguments[0];
      if (input && ts.isObjectLiteralExpression(input)) {
        const context = input.properties.find((property) => (
          propertyName(property) === "context"
        ));
        if (
          context
          && ts.isPropertyAssignment(context)
          && ts.isStringLiteral(context.initializer)
          && context.initializer.text === expectedContext
        ) {
          inputs.push(input);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (inputs.length !== 1) {
    throw new Error(`${fileName} must contain one ${expectedContext} call.`);
  }
  const input = inputs[0];
  const sqlArray = (
    name: "installSql" | "cleanupSql",
    expectedCount: number,
  ) => {
    const properties = input.properties.filter((property) => (
      propertyName(property) === name
    ));
    const property = properties[0];
    if (
      properties.length !== 1
      || !property
      || !ts.isPropertyAssignment(property)
      || !ts.isArrayLiteralExpression(property.initializer)
      || property.initializer.elements.length !== expectedCount
    ) {
      throw new Error(`${fileName} must contain ${expectedCount} ${name} literals.`);
    }
    return property.initializer.elements.map((element) => {
      const literal = sqlLiteral(element as ts.Expression, sourceFile);
      if (!literal || ts.isTemplateExpression(element)) {
        throw new Error(`${fileName} ${name} must be static.`);
      }
      return literal.text;
    });
  };
  return {
    cleanupSql: sqlArray("cleanupSql", expectedCleanupCount),
    installSql: sqlArray("installSql", expectedInstallCount),
  };
}
async function approvedFaultInput(contract = FIXTURE_CONTRACTS[0]) {
  const source = await readFile(path.resolve(WORKSPACE_ROOT, contract.relativePath), "utf8");
  return {
    ...extractFaultInjectionInput(source, contract.relativePath, contract.context),
    databaseTarget: VALID_DATABASE_TARGET,
  };
}

function normalizedSql(sql: string) {
  return sql.trim().replace(/\s+/g, " ");
}

function hasExactCreateFunctionStatement(sql: string, functionName: string) {
  const opening = new RegExp(
    `^\\s*create\\s+function\\s+public\\.${escaped(functionName)}\\s*\\([^)]*\\)[\\s\\S]*?\\bas\\s+(\\$[A-Za-z_][A-Za-z0-9_]*\\$|\\$\\$)`,
    "i",
  ).exec(sql);
  const delimiter = opening?.[1];
  if (!opening || !delimiter) return false;
  const closingIndex = sql.indexOf(
    delimiter,
    opening.index + opening[0].length,
  );
  return (
    closingIndex >= 0
    && /^\s*;?\s*$/.test(sql.slice(closingIndex + delimiter.length))
  );
}

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateFaultInjectionSource(
  sourceText: string,
  fileName: string,
  contract: SourceFixtureContract,
) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const errors: string[] = [];
  const wrapperCalls: ts.CallExpression[] = [];
  const ownerDdl: SqlLiteral[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "withValidatedOwnerFaultInjection"
    ) {
      wrapperCalls.push(node);
    }
    if (
      ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateExpression(node)
    ) {
      const literal = sqlLiteral(node, sourceFile);
      if (literal && OWNER_DDL_PATTERN.test(literal.text)) ownerDdl.push(literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (wrapperCalls.length !== 1) {
    errors.push(`expected exactly one wrapper call, found ${wrapperCalls.length}`);
  }
  const wrapper = wrapperCalls[0];
  const input = wrapper?.arguments[0];
  if (!input || !ts.isObjectLiteralExpression(input)) {
    errors.push("wrapper must receive a direct object literal");
    return errors;
  }

  if (contract.context !== undefined) {
    const contextProperties = input.properties.filter((property) => (
      propertyName(property) === "context"
    ));
    const contextProperty = contextProperties[0];
    if (
      contextProperties.length !== 1
      || !contextProperty
      || !ts.isPropertyAssignment(contextProperty)
      || !ts.isStringLiteral(contextProperty.initializer)
      || contextProperty.initializer.text !== contract.context
    ) {
      errors.push("context must be the exact approved static literal");
    }
  }

  const readSqlArray = (name: "installSql" | "cleanupSql") => {
    const properties = input.properties.filter((property) => propertyName(property) === name);
    if (properties.length !== 1 || !ts.isPropertyAssignment(properties[0])) {
      errors.push(`${name} must be exactly one direct object property`);
      return [] as SqlLiteral[];
    }
    const initializer = properties[0].initializer;
    if (!ts.isArrayLiteralExpression(initializer)) {
      errors.push(`${name} must be a direct array literal`);
      return [] as SqlLiteral[];
    }
    if (initializer.elements.length !== 2) {
      errors.push(`${name} must contain exactly two SQL literals`);
    }
    return initializer.elements.flatMap((element, index) => {
      const literal = sqlLiteral(element as ts.Expression, sourceFile);
      if (!literal || ts.isTemplateExpression(element)) {
        errors.push(`${name}[${index}] must be a static SQL literal`);
        return [];
      }
      return [literal];
    });
  };

  const installSql = readSqlArray("installSql");
  const cleanupSql = readSqlArray("cleanupSql");
  const expectedNodes = new Set([
    ...installSql.map(({ node }) => node),
    ...cleanupSql.map(({ node }) => node),
  ]);

  for (const literal of ownerDdl) {
    if (!expectedNodes.has(literal.node)) {
      errors.push("owner DDL exists outside installSql/cleanupSql");
    }
    if (/\bcascade\b/i.test(literal.text)) {
      errors.push("owner DDL must not use CASCADE");
    }
  }
  for (const literal of [...installSql, ...cleanupSql]) {
    if (!OWNER_DDL_PATTERN.test(literal.text)) {
      errors.push("installSql/cleanupSql contains non-owner DDL");
    }
  }
  if (ownerDdl.length !== 4) {
    errors.push(`expected exactly four owner DDL literals, found ${ownerDdl.length}`);
  }

  const functionName = escaped(contract.functionName);
  const triggerName = escaped(contract.triggerName);
  const tableName = escaped(contract.tableName);
  const installFunction = installSql[0] ? normalizedSql(installSql[0].text) : "";
  const installTrigger = installSql[1] ? normalizedSql(installSql[1].text) : "";
  const cleanupTrigger = cleanupSql[0] ? normalizedSql(cleanupSql[0].text) : "";
  const cleanupFunction = cleanupSql[1] ? normalizedSql(cleanupSql[1].text) : "";

  const exactHashesMatch = (
    literals: readonly SqlLiteral[],
    expected: readonly [string, string],
  ) => (
    literals.length === expected.length
    && literals.every((literal, index) => (
      ownerSqlSha256(literal.text) === expected[index]
    ))
  );

  if (!new RegExp(
    `^create\\s+function\\s+public\\.${functionName}\\s*\\(`,
    "i",
  ).test(installFunction)) {
    errors.push("installSql[0] must create the expected public function");
  }
  if (!new RegExp(
    `^create\\s+trigger\\s+${triggerName}\\b[\\s\\S]*\\bon\\s+public\\.${tableName}\\b[\\s\\S]*\\bexecute\\s+function\\s+public\\.${functionName}\\s*\\(\\s*\\)`,
    "i",
  ).test(installTrigger)) {
    errors.push("installSql[1] must create the expected trigger on the public table and public function");
  }
  if (!new RegExp(
    `^drop\\s+trigger\\s+if\\s+exists\\s+${triggerName}\\s+on\\s+public\\.${tableName}\\s*;?$`,
    "i",
  ).test(cleanupTrigger)) {
    errors.push("cleanupSql[0] must drop the expected trigger from the public table");
  }
  if (!new RegExp(
    `^drop\\s+function\\s+if\\s+exists\\s+public\\.${functionName}\\s*\\(\\s*\\)\\s*;?$`,
    "i",
  ).test(cleanupFunction)) {
    errors.push("cleanupSql[1] must drop the expected public function");
  }

  const exactFunctionStatement = hasExactCreateFunctionStatement(
    installSql[0]?.text ?? "",
    contract.functionName,
  );
  const exactTriggerStatement = new RegExp(
    `^create\\s+trigger\\s+${triggerName}\\b[\\s\\S]*\\bon\\s+public\\.${tableName}\\b[\\s\\S]*\\bexecute\\s+function\\s+public\\.${functionName}\\s*\\(\\s*\\)\\s*$`,
    "i",
  ).test(installTrigger);
  const exactCleanupStatements = new RegExp(
    `^drop\\s+trigger\\s+if\\s+exists\\s+${triggerName}\\s+on\\s+public\\.${tableName}\\s*;?$`,
    "i",
  ).test(cleanupTrigger) && new RegExp(
    `^drop\\s+function\\s+if\\s+exists\\s+public\\.${functionName}\\s*\\(\\s*\\)\\s*;?$`,
    "i",
  ).test(cleanupFunction);
  if (
    !exactFunctionStatement
    || !exactTriggerStatement
    || !exactCleanupStatements
    || !exactHashesMatch(installSql, contract.installSqlSha256)
    || !exactHashesMatch(cleanupSql, contract.cleanupSqlSha256)
  ) {
    errors.push("owner SQL must be one exact approved statement");
  }

  return errors;
}

function syntheticFixtureSource(options: Readonly<{
  appendedInstallSql?: string;
  cleanupCascade?: boolean;
  extraSource?: string;
  installProperty?: string;
  reverseInstall?: boolean;
}> = {}) {
  const functionSql =
    `create function public.fixture_function() returns trigger language plpgsql as $$ begin return new; end $$${options.appendedInstallSql ?? ""}`;
  const triggerSql =
    "create trigger fixture_trigger before insert on public.fixture_table for each row execute function public.fixture_function()";
  const install = options.reverseInstall
    ? [triggerSql, functionSql]
    : [functionSql, triggerSql];
  const cleanup = [
    `drop trigger if exists fixture_trigger on public.fixture_table${options.cleanupCascade ? " cascade" : ""}`,
    "drop function if exists public.fixture_function()",
  ];
  return `
    withValidatedOwnerFaultInjection({
      context: "Synthetic",
      ${options.installProperty ?? "installSql"}: ${JSON.stringify(install)},
      cleanupSql: ${JSON.stringify(cleanup)},
      run: async () => undefined,
    });
    ${options.extraSource ?? ""}
  `;
}

beforeEach(() => {
  vi.clearAllMocks();
  migrationManifestMock.readMigrationFiles.mockReturnValue(REVIEWED_MIGRATIONS);
  reviewedLedgerMock.verifyReviewedMigrationRepository.mockReturnValue({
    entryCount: REVIEWED_MIGRATIONS.length,
    ledgerSha256: "c".repeat(64),
    tailIndex: 1,
    tailTag: "0001_test",
  });
  reviewedLedgerMock.verifyAppliedMigrationLedger.mockResolvedValue({
    appliedCount: REVIEWED_MIGRATIONS.length,
    complete: true,
    ledgerSha256: "c".repeat(64),
  });
  process.env.DATABASE_OWNER_URL = VALID_OWNER_URL;
  process.env.INTEGRATION_TEST = "1";
});

afterEach(() => {
  if (previousEnvironment.DATABASE_OWNER_URL === undefined) {
    delete process.env.DATABASE_OWNER_URL;
  } else {
    process.env.DATABASE_OWNER_URL = previousEnvironment.DATABASE_OWNER_URL;
  }
  if (previousEnvironment.INTEGRATION_TEST === undefined) {
    delete process.env.INTEGRATION_TEST;
  } else {
    process.env.INTEGRATION_TEST = previousEnvironment.INTEGRATION_TEST;
  }
});

describe("validated disposable owner fault injection", () => {
  it.each([
    ["missing owner URL", ""],
    ["invalid owner URL", "not-a-url"],
    ["alternate owner protocol", VALID_OWNER_URL.replace("postgresql:", "postgres:")],
    ["owner localhost alias", VALID_OWNER_URL.replace("127.0.0.1", "localhost")],
    ["owner protected port", VALID_OWNER_URL.replace("55491", "5432")],
    ["owner implicit port", VALID_OWNER_URL.replace(":55491", "")],
    ["wrong owner database", VALID_OWNER_URL.replace("learncoding_integration", "postgres")],
    ["wrong owner login", VALID_OWNER_URL.replace("learncoding_migrator", "learncoding_app")],
    ["missing owner password", VALID_OWNER_URL.replace(":test-password@", "@")],
    ["missing owner role option", VALID_OWNER_URL.split("?")[0]],
    ["extra owner role option", `${VALID_OWNER_URL}&options=-c+statement_timeout%3D5000`],
    ["extra owner query option", `${VALID_OWNER_URL}&sslmode=disable`],
    ["owner fragment", `${VALID_OWNER_URL}#unsafe`],
  ])("rejects %s before a connection is constructed", async (_label, databaseOwnerUrl) => {
    await expect(runValidatedIntegrationMigrations({
      databaseTarget: {
        databaseApplicationUrl: VALID_APP_URL,
        databaseOwnerUrl,
      },
      migrationsFolder: WORKSPACE_MIGRATIONS_FOLDER,
    })).rejects.toThrow(/PostgreSQL migration contract requires/);
    expect(pgMock.Pool).not.toHaveBeenCalled();
  });

  it.each([
    ["missing app URL", ""],
    ["invalid app URL", "not-a-url"],
    ["alternate app protocol", VALID_APP_URL.replace("postgresql:", "postgres:")],
    ["app localhost alias", VALID_APP_URL.replace("127.0.0.1", "localhost")],
    ["app protected port", VALID_APP_URL.replace("55491", "5432")],
    ["wrong app database", VALID_APP_URL.replace("learncoding_integration", "postgres")],
    ["wrong app login", VALID_APP_URL.replace("learncoding_app", "learncoding_worker")],
    ["missing app password", VALID_APP_URL.replace(":test-app-password@", "@")],
    ["app query option", `${VALID_APP_URL}?sslmode=disable`],
    ["app/owner topology mismatch", VALID_APP_URL.replace(":55491", ":55492")],
  ])("rejects %s before a connection is constructed", async (_label, databaseApplicationUrl) => {
    await expect(runValidatedIntegrationMigrations({
      databaseTarget: {
        databaseApplicationUrl,
        databaseOwnerUrl: VALID_OWNER_URL,
      },
      migrationsFolder: WORKSPACE_MIGRATIONS_FOLDER,
    })).rejects.toThrow(/PostgreSQL migration contract requires/);
    expect(pgMock.Pool).not.toHaveBeenCalled();
  });

  it("rejects an invalid terminal-fixture aging timestamp before connecting", async () => {
    await expect(ageValidatedDisposableTerminalEmailOutboxFixtures({
      agedAt: new Date(Number.NaN),
      databaseTarget: VALID_DATABASE_TARGET,
      fixtures: [],
    })).rejects.toThrow(/valid aging timestamp/);
    expect(pgMock.Pool).not.toHaveBeenCalled();
  });

  it("rejects the wrong terminal-fixture cardinality before connecting", async () => {
    await expect(ageValidatedDisposableTerminalEmailOutboxFixtures({
      agedAt: new Date("2026-06-01T00:00:00.000Z"),
      databaseTarget: VALID_DATABASE_TARGET,
      fixtures: [],
    })).rejects.toThrow(/exactly two terminal outbox fixtures/);
    expect(pgMock.Pool).not.toHaveBeenCalled();
  });

  it("uses the frozen target after ambient mutation, validates identity, brackets DDL, and closes", async () => {
    const approved = await approvedFaultInput();
    const order: string[] = [];
    const run = vi.fn(async (...args: unknown[]) => {
      expect(args).toEqual([]);
      order.push("run-app-operation");
      return "expected-result";
    });
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) {
          order.push("identity");
          return identityResult();
        }
        order.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(() => order.push("release")),
    };
    const ownerPool = {
      connect: vi.fn(async () => {
        order.push("connect");
        return client;
      }),
      end: vi.fn(async () => {
        order.push("end");
      }),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    process.env.DATABASE_OWNER_URL = DECOY_OWNER_URL;
    const result = await withValidatedOwnerFaultInjection({
      ...approved,
      databaseTarget: VALID_DATABASE_TARGET,
      run,
    });

    expect(result).toBe("expected-result");
    expect(run).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "connect",
      "identity",
      ...approved.installSql,
      "run-app-operation",
      ...approved.cleanupSql,
      "release",
      "end",
    ]);
    expect(pgMock.Pool).toHaveBeenCalledWith({
      application_name: "codestead.integration-validated-owner",
      connectionString: VALID_OWNER_URL,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      idle_in_transaction_session_timeout: 5_000,
      lock_timeout: 5_000,
      max: 1,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
  });

  it("snapshots approved SQL and callback authority before the first await", async () => {
    const approved = await approvedFaultInput();
    let releaseConnect!: (client: unknown) => void;
    const connectGate = new Promise((resolve) => {
      releaseConnect = resolve;
    });
    const originalRun = vi.fn(async () => "original-result");
    const replacementRun = vi.fn(async () => "replacement-result");
    const installSql = [...approved.installSql];
    const cleanupSql = [...approved.cleanupSql];
    const input = {
      context: approved.context,
      databaseTarget: approved.databaseTarget,
      installSql,
      cleanupSql,
      run: originalRun,
    };
    const observedSql: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) return identityResult();
        observedSql.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const ownerPool = {
      connect: vi.fn(() => connectGate),
      end: vi.fn(async () => undefined),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    const pending = withValidatedOwnerFaultInjection(input);
    installSql[0] = "drop table public.email_outbox";
    installSql[1] = "grant all on schema public to public";
    cleanupSql.length = 0;
    input.context = "mutated context";
    input.run = replacementRun;
    releaseConnect(client);

    await expect(pending).resolves.toBe("original-result");
    expect(observedSql).toEqual([
      ...approved.installSql,
      ...approved.cleanupSql,
    ]);
    expect(originalRun).toHaveBeenCalledOnce();
    expect(replacementRun).not.toHaveBeenCalled();
  });

  it("bounds pool shutdown, destroys the socket, and observes late close failure", async () => {
    vi.useFakeTimers();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const approved = await approvedFaultInput();
      const primary = new Error("primary before hanging shutdown");
      const lateCloseFailure = new Error("late pool close failure");
      let rejectPoolClose!: (reason: unknown) => void;
      const poolClose = new Promise<never>((_resolve, reject) => {
        rejectPoolClose = reject;
      });
      const client = {
        query: vi.fn(async (sql: string) => (
          sql.includes("current_database()") ? identityResult() : { rows: [] }
        )),
        release: vi.fn(),
      };
      const ownerPool = {
        connect: vi.fn(async () => client),
        end: vi.fn(() => poolClose),
      };
      pgMock.Pool.mockImplementation(function PoolMock() {
        return ownerPool;
      });

      const pending = withValidatedOwnerFaultInjection({
        ...approved,
        databaseTarget: VALID_DATABASE_TARGET,
        run: async () => {
          throw primary;
        },
      });
      void pending.catch(() => undefined);
      for (let attempt = 0; attempt < 10 && ownerPool.end.mock.calls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(ownerPool.end).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      let failure: unknown;
      try {
        await pending;
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toBe(primary);
      expect((failure as AggregateError).errors[1]).toMatchObject({
        name: "ValidatedOwnerPoolShutdownTimeoutError",
      });
      expect((failure as AggregateError & { cause?: unknown }).cause).toBe(primary);
      expect(client.release).toHaveBeenCalledOnce();
      expect(client.release).toHaveBeenCalledWith(true);
      rejectPoolClose(lateCloseFailure);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      vi.useRealTimers();
    }
  });

  it.each([
    ["DROP SCHEMA", "drop schema public cascade"],
    ["DROP TABLE", "drop table public.notification"],
    ["ALTER", "alter table public.notification disable trigger all"],
    ["GRANT", "grant all on schema public to public"],
    ["REVOKE", "revoke all on schema public from public"],
    ["TRUNCATE", "truncate table public.notification"],
    ["DO", "do $$ begin null; end $$"],
    ["INSERT", "insert into public.notification default values"],
    ["UPDATE", "update public.notification set type = type"],
    ["DELETE", "delete from public.notification"],
    ["MERGE", "merge into public.notification using public.notification on false when not matched then do nothing"],
    ["SELECT", "select current_user"],
  ])("rejects standalone %s owner SQL before constructing a pool", async (_label, sql) => {
    const approved = await approvedFaultInput();
    pgMock.Pool.mockImplementation(function UnexpectedOwnerPool() {
      throw new Error("owner pool must not be constructed");
    });

    await expect(withValidatedOwnerFaultInjection({
      ...approved,
      databaseTarget: VALID_DATABASE_TARGET,
      installSql: [sql, approved.installSql[1]],
      run: vi.fn(async () => undefined),
    })).rejects.toThrow(/closed-world owner fault contract/);
    expect(pgMock.Pool).not.toHaveBeenCalled();
  });

  it.each([
    ["approved-prefix plus DROP TABLE", "; drop table public.notification"],
    ["approved-prefix plus DML", "; update public.notification set type = type"],
    ["approved-prefix plus comment drift", " -- unreviewed drift"],
    ["approved cleanup plus CASCADE", " cascade"],
  ])("rejects %s as whole-literal drift", async (_label, suffix) => {
    const approved = await approvedFaultInput();
    pgMock.Pool.mockImplementation(function UnexpectedOwnerPool() {
      throw new Error("owner pool must not be constructed");
    });

    await expect(withValidatedOwnerFaultInjection({
      ...approved,
      databaseTarget: VALID_DATABASE_TARGET,
      cleanupSql: [approved.cleanupSql[0], `${approved.cleanupSql[1]}${suffix}`],
      run: vi.fn(async () => undefined),
    })).rejects.toThrow(/closed-world owner fault contract/);
    expect(pgMock.Pool).not.toHaveBeenCalled();
  });

  it("binds the 0064 identity probe to one exact clone-table capability", async () => {
    const source = await readFile(
      path.resolve(WORKSPACE_ROOT, DISPATCH_IDENTITY_PROBE_CONTRACT.relativePath),
      "utf8",
    );
    const approved = extractVariableLengthFaultInjectionInput(
      source,
      DISPATCH_IDENTITY_PROBE_CONTRACT.relativePath,
      DISPATCH_IDENTITY_PROBE_CONTRACT.context,
      DISPATCH_IDENTITY_PROBE_CONTRACT.installSqlSha256.length,
      DISPATCH_IDENTITY_PROBE_CONTRACT.cleanupSqlSha256.length,
    );
    expect(approved.installSql.map(ownerSqlSha256)).toEqual(
      DISPATCH_IDENTITY_PROBE_CONTRACT.installSqlSha256,
    );
    expect(approved.cleanupSql.map(ownerSqlSha256)).toEqual(
      DISPATCH_IDENTITY_PROBE_CONTRACT.cleanupSqlSha256,
    );
    expect(normalizedSql(approved.installSql[0] ?? "")).toMatch(
      /^CREATE TABLE public\.integration_dispatch_binding_identity_probe \(/,
    );
    expect(normalizedSql(approved.installSql[1] ?? "")).toMatch(
      /EXECUTE FUNCTION public\.enforce_email_outbox_dispatch_binding\(\)$/,
    );
    expect(normalizedSql(approved.installSql[2] ?? "")).toBe(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "
      + "public.integration_dispatch_binding_identity_probe TO learncoding_app",
    );
    expect(approved.installSql.join("\n")).not.toMatch(/\bCASCADE\b/i);
    expect(approved.cleanupSql.join("\n")).not.toMatch(/\bCASCADE\b/i);

    const order: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) return identityResult();
        order.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const ownerPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });
    await expect(withValidatedOwnerFaultInjection({
      ...approved,
      databaseTarget: VALID_DATABASE_TARGET,
      context: DISPATCH_IDENTITY_PROBE_CONTRACT.context,
      run: async () => {
        order.push("run-0064-identity-probe");
      },
    })).resolves.toBeUndefined();
    expect(order).toEqual([
      ...approved.installSql,
      "run-0064-identity-probe",
      ...approved.cleanupSql,
    ]);
  });
  it("approves only the exact reset truncate rollback tuple", async () => {
    const source = await readFile(
      path.resolve(WORKSPACE_ROOT, RESET_FAULT_CONTRACT.relativePath),
      "utf8",
    );
    const approved = extractFaultInjectionInput(
      source,
      RESET_FAULT_CONTRACT.relativePath,
      RESET_FAULT_CONTRACT.context,
    );
    expect(approved.context).toBe(RESET_FAULT_CONTRACT.context);
    expect(sqlTupleSha256(approved.installSql)).toEqual(
      RESET_FAULT_CONTRACT.installSqlSha256,
    );
    expect(sqlTupleSha256(approved.cleanupSql)).toEqual(
      RESET_FAULT_CONTRACT.cleanupSqlSha256,
    );

    const order: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) return identityResult();
        order.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const ownerPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    await expect(withValidatedOwnerFaultInjection({
      ...approved,
      databaseTarget: VALID_DATABASE_TARGET,
      run: async () => {
        order.push("run-reset-proof");
        return "reset-fault-approved";
      },
    })).resolves.toBe("reset-fault-approved");
    expect(order).toEqual([
      ...approved.installSql,
      "run-reset-proof",
      ...approved.cleanupSql,
    ]);

    const poolConstructions = pgMock.Pool.mock.calls.length;
    await expect(withValidatedOwnerFaultInjection({
      ...approved,
      databaseTarget: VALID_DATABASE_TARGET,
      installSql: [`${approved.installSql[0]} `, approved.installSql[1]],
      run: vi.fn(async () => undefined),
    })).rejects.toThrow(/closed-world owner fault contract/);
    expect(pgMock.Pool).toHaveBeenCalledTimes(poolConstructions);
  });

  it("allows only the exact one-statement hostile reset namespace tuple", async () => {
    const order: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) return identityResult();
        order.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const ownerPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    await expect(withValidatedOwnerFaultInjection({
      ...RESET_NAMESPACE_FAULT,
      run: async () => {
        order.push("run-hostile-namespace-proof");
      },
    })).resolves.toBeUndefined();
    expect(order).toEqual([
      ...RESET_NAMESPACE_FAULT.installSql,
      "run-hostile-namespace-proof",
      ...RESET_NAMESPACE_FAULT.cleanupSql,
    ]);

    await expect(withValidatedOwnerFaultInjection({
      ...RESET_NAMESPACE_FAULT,
      cleanupSql: [],
      run: vi.fn(async () => undefined),
    })).rejects.toThrow(/closed-world owner fault contract/);
  });

  it("allows only the exact reset outgoing-dependency tuple", async () => {
    const source = await readFile(
      path.resolve(
        WORKSPACE_ROOT,
        RESET_OUTGOING_DEPENDENCY_FAULT_CONTRACT.relativePath,
      ),
      "utf8",
    );
    const approved = extractVariableLengthFaultInjectionInput(
      source,
      RESET_OUTGOING_DEPENDENCY_FAULT_CONTRACT.relativePath,
      RESET_OUTGOING_DEPENDENCY_FAULT_CONTRACT.context,
      1,
      1,
    );
    expect(approved.installSql.map(ownerSqlSha256)).toEqual(
      RESET_OUTGOING_DEPENDENCY_FAULT_CONTRACT.installSqlSha256,
    );
    expect(approved.cleanupSql.map(ownerSqlSha256)).toEqual(
      RESET_OUTGOING_DEPENDENCY_FAULT_CONTRACT.cleanupSqlSha256,
    );

    const order: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) return identityResult();
        order.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const ownerPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    await expect(withValidatedOwnerFaultInjection({
      ...approved,
      databaseTarget: VALID_DATABASE_TARGET,
      context: RESET_OUTGOING_DEPENDENCY_FAULT_CONTRACT.context,
      run: async () => {
        order.push("run-outgoing-dependency-proof");
      },
    })).resolves.toBeUndefined();
    expect(order).toEqual([
      ...approved.installSql,
      "run-outgoing-dependency-proof",
      ...approved.cleanupSql,
    ]);

    await expect(withValidatedOwnerFaultInjection({
      ...approved,
      databaseTarget: VALID_DATABASE_TARGET,
      context: RESET_OUTGOING_DEPENDENCY_FAULT_CONTRACT.context,
      installSql: [`${approved.installSql[0]} `],
      run: vi.fn(async () => undefined),
    })).rejects.toThrow(/closed-world owner fault contract/);
  });

  it("runs only the exact workspace migration folder and returns only the applied count", async () => {
    const ownerDatabase = { kind: "validated-owner-drizzle-database" };
    drizzleMock.createDrizzle.mockReturnValue(ownerDatabase);
    drizzleMock.migrate.mockResolvedValue(undefined);
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) return identityResult();
        if (sql.includes("drizzle.__drizzle_migrations")) {
          return {
            rows: REVIEWED_MIGRATIONS.map(({ folderMillis, hash }) => ({
              created_at: String(folderMillis),
              hash,
            })),
          };
        }
        throw new Error(`unexpected owner query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const ownerPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    const count = await runValidatedIntegrationMigrations({
      databaseTarget: VALID_DATABASE_TARGET,
      migrationsFolder: WORKSPACE_MIGRATIONS_FOLDER,
    });

    expect(count).toBe(REVIEWED_MIGRATIONS.length);
    expect(reviewedLedgerMock.verifyReviewedMigrationRepository)
      .toHaveBeenCalledWith({ drizzleDirectory: WORKSPACE_MIGRATIONS_FOLDER });
    expect(reviewedLedgerMock.verifyAppliedMigrationLedger.mock.calls).toEqual([
      [client, { requireComplete: false }],
      [client, { requireComplete: true }],
    ]);
    expect(drizzleMock.createDrizzle).toHaveBeenCalledWith(client);
    expect(drizzleMock.migrate).toHaveBeenCalledWith(ownerDatabase, {
      migrationsFolder: WORKSPACE_MIGRATIONS_FOLDER,
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining(
      "drizzle.__drizzle_migrations",
    ));
    expect(client.release).toHaveBeenCalledOnce();
    expect(ownerPool.end).toHaveBeenCalledOnce();
  });

  it("reads and verifies the exact journal without running migrations", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) return identityResult();
        if (sql.includes("drizzle.__drizzle_migrations")) {
          return {
            rows: REVIEWED_MIGRATIONS.map(({ folderMillis, hash }) => ({
              created_at: String(folderMillis),
              hash,
            })),
          };
        }
        throw new Error(`unexpected owner query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const ownerPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    await expect(readValidatedIntegrationMigrationJournal({
      databaseTarget: VALID_DATABASE_TARGET,
      migrationsFolder: WORKSPACE_MIGRATIONS_FOLDER,
    })).resolves.toBe(REVIEWED_MIGRATIONS.length);
    expect(reviewedLedgerMock.verifyReviewedMigrationRepository)
      .toHaveBeenCalledWith({ drizzleDirectory: WORKSPACE_MIGRATIONS_FOLDER });
    expect(reviewedLedgerMock.verifyAppliedMigrationLedger)
      .toHaveBeenCalledExactlyOnceWith(client, { requireComplete: true });
    expect(drizzleMock.createDrizzle).not.toHaveBeenCalled();
    expect(drizzleMock.migrate).not.toHaveBeenCalled();
  });

  it.each([
    ["a deleted tail", (rows: typeof REVIEWED_JOURNAL_ROWS) => rows.slice(0, -1)],
    ["a rogue equal-count hash", (rows: typeof REVIEWED_JOURNAL_ROWS) => (
      rows.map((row, index) => index === 0
        ? { ...row, hash: "f".repeat(64) }
        : row)
    )],
    ["wrong ordering", (rows: typeof REVIEWED_JOURNAL_ROWS) => [...rows].reverse()],
    ["a wrong timestamp", (rows: typeof REVIEWED_JOURNAL_ROWS) => (
      rows.map((row, index) => index === 0
        ? { ...row, created_at: "1" }
        : row)
    )],
  ])("read-only verification rejects %s", async (_label, mutateRows) => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) return identityResult();
        if (sql.includes("drizzle.__drizzle_migrations")) {
          return { rows: mutateRows(REVIEWED_JOURNAL_ROWS) };
        }
        throw new Error(`unexpected owner query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const ownerPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    await expect(readValidatedIntegrationMigrationJournal({
      databaseTarget: VALID_DATABASE_TARGET,
      migrationsFolder: WORKSPACE_MIGRATIONS_FOLDER,
    })).rejects.toThrow(/ordered migration journal mismatch/);
    expect(drizzleMock.createDrizzle).not.toHaveBeenCalled();
    expect(drizzleMock.migrate).not.toHaveBeenCalled();
  });

  it.each([
    ["a relative folder", "drizzle"],
    ["a sibling folder", path.resolve(WORKSPACE_ROOT, "drizzle-other")],
    ["a syntactically different traversal", `${WORKSPACE_MIGRATIONS_FOLDER}${path.sep}..${path.sep}drizzle`],
  ])("rejects %s before constructing an owner pool", async (_label, migrationsFolder) => {
    await expect(runValidatedIntegrationMigrations({
      databaseTarget: VALID_DATABASE_TARGET,
      migrationsFolder,
    })).rejects.toThrow(
      /exact workspace drizzle folder/,
    );
    expect(pgMock.Pool).not.toHaveBeenCalled();
    expect(drizzleMock.createDrizzle).not.toHaveBeenCalled();
    expect(drizzleMock.migrate).not.toHaveBeenCalled();
  });

  it("anchors the migration folder to this module instead of mutable cwd", async () => {
    const originalCwd = process.cwd();
    const alternateCwd = path.parse(originalCwd).root;
    pgMock.Pool.mockImplementation(function UnexpectedOwnerPool() {
      throw new Error("owner pool must not be constructed");
    });

    try {
      process.chdir(alternateCwd);
      await expect(runValidatedIntegrationMigrations({
        databaseTarget: VALID_DATABASE_TARGET,
        migrationsFolder: path.resolve(alternateCwd, "drizzle"),
      })).rejects.toThrow(/exact workspace drizzle folder/);
    } finally {
      process.chdir(originalCwd);
    }

    expect(pgMock.Pool).not.toHaveBeenCalled();
  });

  it("anchors the migration folder when a fresh process launches from a decoy cwd", async () => {
    const decoyRoot = await mkdtemp(path.join(tmpdir(), "codestead-owner-launch-decoy-"));
    const helperModuleUrl = pathToFileURL(path.resolve(
      WORKSPACE_ROOT,
      "integration/support/with-validated-owner-fault-injection.ts",
    )).href;
    const tsxLoaderUrl = pathToFileURL(path.resolve(
      WORKSPACE_ROOT,
      "node_modules/tsx/dist/loader.mjs",
    )).href;
    const childEnvironment = Object.fromEntries(
      ["HOME", "PATH", "SystemRoot", "TEMP", "TMP"]
        .flatMap((name) => (
          process.env[name] === undefined ? [] : [[name, process.env[name]]]
        )),
    );
    const childSource = `
      void import(${JSON.stringify(helperModuleUrl)}).then(async (ownerFaultModule) => {
        try {
          const ownerFaultApi = ownerFaultModule.runValidatedIntegrationMigrations
            ? ownerFaultModule
            : ownerFaultModule.default;
          await ownerFaultApi.runValidatedIntegrationMigrations({
            databaseTarget: {
              databaseApplicationUrl: "invalid-app-url",
              databaseOwnerUrl: "invalid-owner-url",
            },
            migrationsFolder: ${JSON.stringify(WORKSPACE_MIGRATIONS_FOLDER)},
          });
          process.stdout.write("unexpected-success");
          process.exitCode = 2;
        } catch (error) {
          process.stdout.write(error instanceof Error ? error.message : String(error));
        }
      });
    `;

    try {
      const { stdout } = await execFile(
        process.execPath,
        ["--import", tsxLoaderUrl, "--eval", childSource],
        {
          cwd: decoyRoot,
          env: childEnvironment,
          timeout: 15_000,
          windowsHide: true,
        },
      );
      expect(stdout).not.toContain("exact workspace drizzle folder");
      expect(stdout).toContain("requires a valid frozen disposable database target");
    } finally {
      await rm(decoyRoot, { force: true, recursive: true });
    }
  });

  it("keeps the PostgreSQL integration migration callsite module-root anchored", async () => {
    const originalCwd = process.cwd();
    const decoyRoot = await mkdtemp(path.join(tmpdir(), "codestead-postgres-callsite-decoy-"));

    try {
      process.chdir(decoyRoot);
      const source = await readFile(
        path.resolve(WORKSPACE_ROOT, "integration/postgres.integration.test.ts"),
        "utf8",
      );
      expect(source).toContain("fileURLToPath(import.meta.url)");
      expect(source).not.toMatch(
        /path\.resolve\(\s*process\.cwd\(\)\s*,\s*["']drizzle["']\s*\)/,
      );
      expect(source).toMatch(
        /const WORKSPACE_MIGRATIONS_FOLDER\s*=\s*path\.resolve\(\s*WORKSPACE_ROOT\s*,\s*["']drizzle["']\s*\)/,
      );
      expect(source).toMatch(
        /runValidatedIntegrationMigrations\(\{\s*databaseTarget:\s*validatedDisposableOwnerDatabaseTarget\(process\.env\),\s*migrationsFolder:\s*WORKSPACE_MIGRATIONS_FOLDER,\s*\}\)/,
      );
    } finally {
      process.chdir(originalCwd);
      await rm(decoyRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ["database", { current_database: "postgres" }],
    ["session role", { session_user: "learncoding_app" }],
    ["current role", { current_user: "learncoding_migrator" }],
  ])("rejects a mismatched live %s before installing DDL", async (_label, overrides) => {
    const approved = await approvedFaultInput();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) return identityResult(overrides);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const ownerPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    await expect(withValidatedOwnerFaultInjection({
      ...approved,
      databaseTarget: VALID_DATABASE_TARGET,
      run: vi.fn(),
    })).rejects.toThrow(/owner identity mismatch/);

    expect(client.query).not.toHaveBeenCalledWith(approved.installSql[0]);
    expect(client.query).not.toHaveBeenCalledWith(approved.cleanupSql[0]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(ownerPool.end).toHaveBeenCalledOnce();
  });

  it("preserves the primary operation error together with every cleanup error", async () => {
    const approved = await approvedFaultInput();
    const primary = new Error("primary app failure");
    const ddlCleanup = new Error("DDL cleanup failure");
    const poolCleanup = new Error("pool cleanup failure");
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) return identityResult();
        if (sql === approved.cleanupSql[0]) throw ddlCleanup;
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const ownerPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {
        throw poolCleanup;
      }),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    let failure: unknown;
    try {
      await withValidatedOwnerFaultInjection({
        ...approved,
        databaseTarget: VALID_DATABASE_TARGET,
        run: async () => {
          throw primary;
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      primary,
      ddlCleanup,
      poolCleanup,
    ]);
    expect((failure as AggregateError & { cause?: unknown }).cause).toBe(primary);
    expect(client.query).toHaveBeenCalledWith(approved.cleanupSql[1]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("runs both cleanup statements after a partial install failure without invoking the app", async () => {
    const approved = await approvedFaultInput();
    const installFailure = new Error("second owner install failed");
    const order: string[] = [];
    const run = vi.fn(async () => undefined);
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) {
          order.push("identity");
          return identityResult();
        }
        order.push(sql);
        if (sql === approved.installSql[1]) throw installFailure;
        return { rows: [] };
      }),
      release: vi.fn(() => order.push("release")),
    };
    const ownerPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {
        order.push("end");
      }),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    await expect(withValidatedOwnerFaultInjection({
      ...approved,
      databaseTarget: VALID_DATABASE_TARGET,
      run,
    })).rejects.toBe(installFailure);

    expect(run).not.toHaveBeenCalled();
    expect(order).toEqual([
      "identity",
      ...approved.installSql,
      ...approved.cleanupSql,
      "release",
      "end",
    ]);
  });

  it("preserves every cleanup-only failure after successful app work", async () => {
    const approved = await approvedFaultInput();
    const cleanupFailures = [
      new Error("trigger cleanup failed"),
      new Error("function cleanup failed"),
      new Error("release failed"),
      new Error("pool end failed"),
    ];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) return identityResult();
        if (sql === approved.cleanupSql[0]) throw cleanupFailures[0];
        if (sql === approved.cleanupSql[1]) throw cleanupFailures[1];
        return { rows: [] };
      }),
      release: vi.fn(() => {
        throw cleanupFailures[2];
      }),
    };
    const ownerPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {
        throw cleanupFailures[3];
      }),
    };
    pgMock.Pool.mockImplementation(function PoolMock() {
      return ownerPool;
    });

    let failure: unknown;
    try {
      await withValidatedOwnerFaultInjection({
        ...approved,
        databaseTarget: VALID_DATABASE_TARGET,
        run: async () => "app-result",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(cleanupFailures);
    expect(client.query).toHaveBeenCalledWith(approved.cleanupSql[1]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(ownerPool.end).toHaveBeenCalledOnce();
  });

  it("keeps the exact owner-session API private and omits server-port identity probes", async () => {
    const helperSource = await readFile(
      path.resolve(
        WORKSPACE_ROOT,
        "integration/support/with-validated-owner-fault-injection.ts",
      ),
      "utf8",
    );

    expect(Object.keys(ownerFaultModule).sort()).toEqual([
      "ageValidatedDisposableTerminalEmailOutboxFixtures",
      "readValidatedIntegrationMigrationJournal",
      "runValidatedIntegrationMigrations",
      "withValidatedOwnerFaultInjection",
    ]);
    expect(helperSource).not.toContain("withValidatedIntegrationOwnerClient");
    expect(helperSource).not.toMatch(
      /\bexport\s+(?:async\s+)?function\s+parseDisposableOwnerDatabaseUrl\b/,
    );
    expect(helperSource).not.toMatch(
      /\bexport\s+(?:async\s+)?function\s+withValidatedOwnerSession\b/,
    );
    expect(helperSource).toMatch(
      /\bexport\s+async\s+function\s+ageValidatedDisposableTerminalEmailOutboxFixtures\b/,
    );
    expect(helperSource).toMatch(
      /alter\s+table\s+only\s+public\.email_outbox\s+disable\s+trigger\s+email_outbox_delivery_hold_final/i,
    );
    expect(helperSource).toMatch(
      /alter\s+table\s+only\s+public\.email_outbox\s+enable\s+always\s+trigger\s+email_outbox_delivery_hold_final/i,
    );
    expect(helperSource).not.toMatch(/\bdisable\s+trigger\s+user\b/i);
    expect(helperSource).toMatch(/run:\s*\(\)\s*=>\s*Promise<T>/);
    const helperFile = ts.createSourceFile(
      "with-validated-owner-fault-injection.ts",
      helperSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const publicFaultInjection = helperFile.statements.find((statement) => (
      ts.isFunctionDeclaration(statement)
      && statement.name?.text === "withValidatedOwnerFaultInjection"
    ));
    if (!publicFaultInjection || !ts.isFunctionDeclaration(publicFaultInjection)) {
      throw new Error("public fault-injection function is missing");
    }
    const publicBridgeSource = publicFaultInjection.getText(helperFile);
    expect(publicBridgeSource).toContain("return snapshot.run();");
    expect(publicBridgeSource).not.toMatch(/snapshot\.run\s*\([^)]*\bclient\b/);

    expect(helperSource).not.toMatch(/\binet_server_addr\b/i);
    expect(helperSource).not.toMatch(/\binet_server_port\b/i);
    expect(helperSource).not.toMatch(/\bcurrent_setting\s*\(/i);
  });

  it("detects receiver-independent, misplaced, reordered, unqualified, and cascading owner DDL", () => {
    const validSource = syntheticFixtureSource();
    const validInput = extractFaultInjectionInput(validSource, "valid.ts");
    const contract = {
      cleanupSqlSha256: sqlTupleSha256(validInput.cleanupSql),
      context: validInput.context,
      functionName: "fixture_function",
      installSqlSha256: sqlTupleSha256(validInput.installSql),
      tableName: "fixture_table",
      triggerName: "fixture_trigger",
    };
    expect(validateFaultInjectionSource(
      validSource,
      "valid.ts",
      contract,
    )).toEqual([]);

    expect(validateFaultInjectionSource(
      syntheticFixtureSource({
        extraSource:
          "rogue.query(`drop function if exists public.fixture_function()`);",
      }),
      "rogue-receiver.ts",
      contract,
    )).toContain("owner DDL exists outside installSql/cleanupSql");

    for (const [label, sql] of [
      ["drop-schema", "drop schema public cascade"],
      ["drop-table", "drop table public.fixture_table cascade"],
      ["alter", "alter table public.fixture_table disable trigger all"],
      ["grant", "grant all on schema public to public"],
      ["revoke", "revoke all on schema public from public"],
      ["truncate", "truncate table public.fixture_table"],
      ["do", "do $$ begin null; end $$"],
    ] as const) {
      expect(validateFaultInjectionSource(
        syntheticFixtureSource({
          extraSource: `rogue.query(${JSON.stringify(sql)});`,
        }),
        `${label}.ts`,
        contract,
      )).toContain("owner DDL exists outside installSql/cleanupSql");
    }

    for (const [label, sql] of [
      ["drop-table", "drop table public.fixture_table"],
      ["alter", "alter table public.fixture_table disable trigger all"],
      ["grant", "grant all on schema public to public"],
      ["revoke", "revoke all on schema public from public"],
      ["truncate", "truncate table public.fixture_table"],
      ["do", "do $$ begin null; end $$"],
      ["insert", "insert into public.fixture_table default values"],
      ["update", "update public.fixture_table set id = id"],
      ["delete", "delete from public.fixture_table"],
      ["merge", "merge into public.fixture_table using public.fixture_table on false when not matched then do nothing"],
      ["select", "select current_user"],
    ] as const) {
      expect(validateFaultInjectionSource(
        syntheticFixtureSource({ appendedInstallSql: `; ${sql}` }),
        `appended-${label}.ts`,
        contract,
      )).toContain("owner SQL must be one exact approved statement");
    }

    const delimiterBypassSource = syntheticFixtureSource({
      appendedInstallSql: "; do $$ begin null; end $$",
    });
    const delimiterBypassInput = extractFaultInjectionInput(
      delimiterBypassSource,
      "delimiter-bypass.ts",
    );
    expect(validateFaultInjectionSource(
      delimiterBypassSource,
      "delimiter-bypass.ts",
      {
        ...contract,
        installSqlSha256: sqlTupleSha256(delimiterBypassInput.installSql),
      },
    )).toContain("owner SQL must be one exact approved statement");
    expect(validateFaultInjectionSource(
      syntheticFixtureSource({ installProperty: "setupSql" }),
      "misplaced.ts",
      contract,
    )).toContain("installSql must be exactly one direct object property");

    expect(validateFaultInjectionSource(
      syntheticFixtureSource({ reverseInstall: true }),
      "reordered.ts",
      contract,
    )).toContain("installSql[0] must create the expected public function");

    expect(validateFaultInjectionSource(
      syntheticFixtureSource({ cleanupCascade: true }),
      "cascade.ts",
      contract,
    )).toContain("owner DDL must not use CASCADE");

    expect(validateFaultInjectionSource(
      syntheticFixtureSource().replaceAll("public.fixture_table", "fixture_table"),
      "unqualified.ts",
      contract,
    )).toContain("installSql[1] must create the expected trigger on the public table and public function");
  });

  it("keeps owner URL and role-assumption authority private to the validated helper", async () => {
    const explicitScannerFixtures = new Map([
      ["direct-env", 'requiredEnvironment("DATABASE_OWNER_URL")'],
      ["computed-env", 'process.env["DATABASE_" + "OWNER_URL"]'],
      ["joined-env", 'process.env[["DATABASE", "OWNER", "URL"].join("_")]'],
      ["split-set-role", 'client.query("SET " + "ROLE learncoding_owner")'],
      ["joined-set-role", 'client.query(["SET", "ROLE learncoding_owner"].join(" "))'],
      ["dynamic-role", "client.query(\"select set_config('role', 'learncoding_owner', false)\")"],
      ["encoded-role", 'const options = "-c+role%3Dlearncoding_owner"'],
      ["double-encoded-role", 'const options = "%252Dc%2520role%253Dlearncoding_owner"'],
    ]);
    for (const [label, fixture] of explicitScannerFixtures) {
      expect(
        scanOwnerAuthoritySource(fixture, `owner-authority-${label}.fixture.ts`),
        label,
      ).not.toEqual([]);
    }
    expect(scanOwnerAuthoritySource(
      `client.query("select set_config('application_name', 'test', false)");
       expect(owner).toBe("learncoding_owner");`,
      "owner-authority-benign.fixture.ts",
    )).toEqual([]);

    expect((await scanWorkspaceOwnerAuthority()).violations).toEqual([]);
  });

  it("anchors the workspace owner-authority scan against cwd decoys", async () => {
    const baseline = await scanWorkspaceOwnerAuthority();
    const originalCwd = process.cwd();
    const decoyRoot = await mkdtemp(path.join(tmpdir(), "codestead-owner-decoy-"));
    await mkdir(path.join(decoyRoot, "integration"));
    await writeFile(
      path.join(decoyRoot, "integration", "decoy.ts"),
      'requiredEnvironment("DATABASE_OWNER_URL");\n',
      "utf8",
    );

    try {
      process.chdir(decoyRoot);
      const fromDecoyCwd = await scanWorkspaceOwnerAuthority();
      expect(fromDecoyCwd).toEqual(baseline);
      expect(fromDecoyCwd.scannedFiles).toContain(
        "integration/mail-dispatch-binding-0064.integration.test.ts",
      );
      expect(fromDecoyCwd.scannedFiles).not.toContain("integration/decoy.ts");
      expect(fromDecoyCwd.violations).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      await rm(decoyRoot, { force: true, recursive: true });
    }
  });

  it("exhaustively inventories every helper import, receiver, alias, and callsite", async () => {
    const helperModuleSuffix = "support/with-validated-owner-fault-injection";
    const exportedOperations = new Set([
      "ageValidatedDisposableTerminalEmailOutboxFixtures",
      "readValidatedIntegrationMigrationJournal",
      "runValidatedIntegrationMigrations",
      "withValidatedOwnerFaultInjection",
    ]);
    const expectedImports = new Map<string, Readonly<{
      calls: readonly string[];
      imports: readonly string[];
    }>>([
      ...FIXTURE_CONTRACTS.map((contract) => (
        [contract.relativePath, {
          calls: ["withValidatedOwnerFaultInjection"],
          imports: ["withValidatedOwnerFaultInjection"],
        }] as const
      )),
      [RESET_FAULT_CONTRACT.relativePath, {
        calls: [
          "readValidatedIntegrationMigrationJournal",
          "withValidatedOwnerFaultInjection",
          "withValidatedOwnerFaultInjection",
          "withValidatedOwnerFaultInjection",
        ],
        imports: [
          "readValidatedIntegrationMigrationJournal",
          "withValidatedOwnerFaultInjection",
        ],
      }],
            [DISPATCH_IDENTITY_PROBE_CONTRACT.relativePath, {
        calls: ["withValidatedOwnerFaultInjection"],
        imports: ["withValidatedOwnerFaultInjection"],
      }],
["integration/postgres.integration.test.ts", {
        calls: [
          "ageValidatedDisposableTerminalEmailOutboxFixtures",
          "runValidatedIntegrationMigrations",
        ],
        imports: [
          "ageValidatedDisposableTerminalEmailOutboxFixtures",
          "runValidatedIntegrationMigrations",
        ],
      }],
    ]);
    const integrationRoot = path.resolve(WORKSPACE_ROOT, "integration");
    const entries = await readdir(integrationRoot, { recursive: true });
    const observedFiles = new Set<string>();
    const violations: string[] = [];

    for (const entry of entries) {
      if (typeof entry !== "string" || !entry.endsWith(".ts")) continue;
      const relativePath = `integration/${entry.replaceAll("\\", "/")}`;
      const sourceText = await readFile(path.join(integrationRoot, entry), "utf8");
      const sourceFile = ts.createSourceFile(
        relativePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const importedLocals = new Map<string, string>();
      const importedOperations: string[] = [];
      const calledOperations: string[] = [];
      let importsHelper = false;

      for (const statement of sourceFile.statements) {
        if (
          !ts.isImportDeclaration(statement)
          || !ts.isStringLiteral(statement.moduleSpecifier)
          || !statement.moduleSpecifier.text.endsWith(helperModuleSuffix)
        ) continue;
        importsHelper = true;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.name) {
          violations.push(`${relativePath}: helper import must use named imports only`);
          continue;
        }
        for (const element of bindings.elements) {
          const exportedName = element.propertyName?.text ?? element.name.text;
          const localName = element.name.text;
          if (!exportedOperations.has(exportedName)) {
            violations.push(`${relativePath}: unknown helper export ${exportedName}`);
          }
          if (localName !== exportedName) {
            violations.push(`${relativePath}: helper alias ${localName} is forbidden`);
          }
          importedLocals.set(localName, exportedName);
          importedOperations.push(exportedName);
        }
      }

      const visit = (node: ts.Node) => {
        if (
          ts.isStringLiteral(node)
          && node.text.endsWith(helperModuleSuffix)
          && !(ts.isImportDeclaration(node.parent) && node.parent.moduleSpecifier === node)
        ) {
          violations.push(`${relativePath}: dynamic/indirect helper loading is forbidden`);
        }
        if (ts.isIdentifier(node) && importedLocals.has(node.text)) {
          const isImportName = ts.isImportSpecifier(node.parent)
            && (node.parent.name === node || node.parent.propertyName === node);
          const isDirectCall = ts.isCallExpression(node.parent)
            && node.parent.expression === node;
          if (!isImportName && !isDirectCall) {
            violations.push(`${relativePath}: indirect helper binding use ${node.text}`);
          }
        }
        if (ts.isCallExpression(node)) {
          let calledName: string | undefined;
          if (ts.isIdentifier(node.expression)) {
            calledName = importedLocals.get(node.expression.text)
              ?? (exportedOperations.has(node.expression.text)
                ? node.expression.text
                : undefined);
          } else if (ts.isPropertyAccessExpression(node.expression)) {
            calledName = exportedOperations.has(node.expression.name.text)
              ? node.expression.name.text
              : undefined;
            if (calledName) {
              violations.push(`${relativePath}: receiver helper call ${calledName} is forbidden`);
            }
          } else if (
            ts.isElementAccessExpression(node.expression)
            && ts.isStringLiteral(node.expression.argumentExpression)
            && exportedOperations.has(node.expression.argumentExpression.text)
          ) {
            calledName = node.expression.argumentExpression.text;
            violations.push(`${relativePath}: computed helper call ${calledName} is forbidden`);
          }
          if (calledName) calledOperations.push(calledName);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      if (!importsHelper && calledOperations.length === 0) continue;
      observedFiles.add(relativePath);
      const expected = expectedImports.get(relativePath);
      if (!expected) {
        violations.push(`${relativePath}: unapproved helper callsite`);
        continue;
      }
      expect(importedOperations.sort(), `${relativePath} imports`).toEqual(
        [...expected.imports].sort(),
      );
      expect(calledOperations.sort(), `${relativePath} calls`).toEqual(
        [...expected.calls].sort(),
      );
    }

    expect(violations).toEqual([]);
    expect([...observedFiles].sort()).toEqual([...expectedImports.keys()].sort());
  });
  it("binds every privileged fixture literal to the validated wrapper with exact safe ordering", async () => {
    for (const contract of FIXTURE_CONTRACTS) {
      const source = await readFile(
        path.resolve(WORKSPACE_ROOT, contract.relativePath),
        "utf8",
      );
const extracted = extractFaultInjectionInput(
        source,
        contract.relativePath,
        contract.context,
      );
      expect(source).toMatch(
        /from\s+"\.\/support\/with-validated-owner-fault-injection"/,
      );
      expect(validateFaultInjectionSource(
        source,
        contract.relativePath,
        contract,
      )).toEqual([]);
      expect(extracted.context).toBe(contract.context);
      expect(extracted.installSql.map(ownerSqlSha256)).toEqual(
        contract.installSqlSha256,
      );
      expect(extracted.cleanupSql.map(ownerSqlSha256)).toEqual(
        contract.cleanupSqlSha256,
      );
    }
  });
});