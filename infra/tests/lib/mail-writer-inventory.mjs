import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import ts from "typescript";

export const PRODUCTION_ROOTS = Object.freeze([
  "src",
  "scripts",
  "infra",
  "services",
]);

export const PRODUCTION_EXTENSIONS = Object.freeze([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".sh",
  ".bash",
  ".py",
  ".sql",
]);

const EXCLUDED_DIRECTORIES = new Set([
  "__tests__",
  "test",
  "tests",
  "fixture",
  "fixtures",
  "node_modules",
  "dist",
  "coverage",
  ".next",
]);

const TEST_FILE = /(?:^|[._-])(?:test|spec)(?:[._-]|$)/iu;
const JAVASCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const SQL_REQUIRED_COLUMNS = Object.freeze([
  "operation_id",
  "user_id",
  "delivery_scope_key",
  "to_email",
  "template",
  "template_version",
  "variables",
  "idempotency_key",
]);

const ORM_REQUIRED_PROPERTIES = Object.freeze([
  "operationId",
  "userId",
  "deliveryScopeKey",
  "toEmail",
  "template",
  "templateVersion",
  "variables",
  "idempotencyKey",
]);

export const REVIEWED_DIRECT_WRITER_PATHS = Object.freeze([
  "src/lib/admin-credentials/service.ts",
  "src/lib/appeals/admin-service.ts",
  "src/lib/assessment-corrections/worker.ts",
  "src/lib/data-lifecycle/deletion.ts",
  "src/lib/notifications/inactivity.ts",
  "src/lib/notifications/outbox.ts",
]);

export const REVIEWED_DISPATCH_ENABLED_TEMPLATES = Object.freeze([
  "access-rejected",
  "access-request-admin",
  "account-deleted",
  "appeal-updated",
  "assessment-corrected",
  "backup-status",
  "challenge-reminder",
  "credential-changed",
  "credential-revealed",
  "daily-study-reminder",
  "fallback-grant-changed",
  "goal-reminder",
  "inactivity-admin-notice",
  "inactivity-reminder",
  "inactivity-reminder-followup",
  "invitation",
  "learning-plan-changed",
  "learning-request-updated",
  "lost-device-proof",
  "mastery-awarded",
  "new-device",
  "reset-password",
  "revision-reminder",
  "session-revocation-requested",
  "session-revocation-updated",
  "session-revoked",
  "storage-quota-changed",
  "verify-email",
  "weekly-summary",
]);

export const REVIEWED_TEMPLATE_PRODUCERS = Object.freeze([
  {
    template: "access-rejected",
    path: "src/app/api/admin/access-requests/[id]/reject/route.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "access-request-admin",
    path: "src/app/api/access-requests/route.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "account-deleted",
    path: "src/lib/data-lifecycle/deletion.ts",
    call: "direct-sql",
  },
  {
    template: "appeal-updated",
    path: "src/lib/appeals/admin-service.ts",
    call: "direct-sql",
  },
  {
    template: "assessment-corrected",
    path: "src/lib/assessment-corrections/worker.ts",
    call: "direct-sql",
  },
  {
    template: "backup-status",
    path: "scripts/backup/enqueue-backup-status.mjs",
    call: "authority-sql",
  },
  {
    template: "challenge-reminder",
    path: "src/lib/notifications/smart-reminders.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "credential-changed",
    path: "src/lib/admin-credentials/service.ts",
    call: "direct-orm",
  },
  {
    template: "credential-changed",
    path: "src/lib/credential-notifications.ts",
    call: "enqueueEmail",
  },
  {
    template: "credential-revealed",
    path: "src/app/api/admin/credentials/[id]/reveal/route.ts",
    call: "enqueueEmail",
  },
  {
    template: "daily-study-reminder",
    path: "src/lib/notifications/smart-reminders.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "fallback-grant-changed",
    path: "src/lib/ai/fallback-notifications.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "goal-reminder",
    path: "src/lib/notifications/smart-reminders.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "inactivity-admin-notice",
    path: "src/lib/notifications/inactivity.ts",
    call: "persistEmail",
  },
  {
    template: "inactivity-reminder",
    path: "src/lib/notifications/inactivity.ts",
    call: "persistEmail",
  },
  {
    template: "inactivity-reminder-followup",
    path: "src/lib/notifications/inactivity.ts",
    call: "persistEmail",
  },
  {
    template: "invitation",
    path: "src/app/api/admin/access-requests/[id]/approve/route.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "learning-plan-changed",
    path: "src/lib/admin-plan/notifications.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "learning-request-updated",
    path: "src/app/api/admin/learning-requests/[id]/decision/route.ts",
    call: "enqueueEmail",
  },
  {
    template: "lost-device-proof",
    path: "src/lib/security/lost-device-recovery.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "mastery-awarded",
    path: "src/lib/achievements/exam-mastery.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "new-device",
    path: "src/lib/auth.ts",
    call: "enqueueEmail",
  },
  {
    template: "reset-password",
    path: "src/lib/auth.ts",
    call: "enqueueEmail",
  },
  {
    template: "revision-reminder",
    path: "src/lib/notifications/smart-reminders.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "session-revocation-requested",
    path: "src/app/api/session-revocation-requests/route.ts",
    call: "enqueueEmail",
  },
  {
    template: "session-revocation-requested",
    path: "src/lib/security/lost-device-recovery.ts",
    call: "enqueueEmailInTransaction",
  },
  {
    template: "session-revocation-updated",
    path: "src/lib/session-notifications.ts",
    call: "enqueueEmail",
  },
  {
    template: "session-revoked",
    path: "src/lib/session-notifications.ts",
    call: "enqueueEmail",
  },
  {
    template: "storage-quota-changed",
    path: "src/lib/storage/quota-notifications.ts",
    call: "enqueueEmail",
  },
  {
    template: "verify-email",
    path: "src/lib/auth.ts",
    call: "enqueueEmail",
  },
  {
    template: "weekly-summary",
    path: "src/lib/notifications/smart-reminders.ts",
    call: "enqueueEmailInTransaction",
  },
]);

function asRepositoryPath(repositoryRoot, path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function walk(directory, repositoryRoot, output) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
        walk(path, repositoryRoot, output);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    const stem = entry.name.slice(0, -extension.length);
    if (PRODUCTION_EXTENSIONS.includes(extension) && !TEST_FILE.test(stem)) {
      output.push(asRepositoryPath(repositoryRoot, path));
    }
  }
}

export function scanProductionFiles(repositoryRoot) {
  const files = [];
  for (const root of PRODUCTION_ROOTS) {
    const directory = resolve(repositoryRoot, root);
    try {
      walk(directory, repositoryRoot, files);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function sourceWithoutComments(source, extension) {
  if (JAVASCRIPT_EXTENSIONS.has(extension)) {
    const variant =
      extension === ".tsx"
        ? ts.LanguageVariant.JSX
        : ts.LanguageVariant.Standard;
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      variant,
      source,
    );
    const chunks = [];
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (
        token !== ts.SyntaxKind.SingleLineCommentTrivia &&
        token !== ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        chunks.push(scanner.getTokenText());
      } else {
        chunks.push(" ");
      }
    }
    return chunks.join("");
  }

  const withoutBlockComments =
    extension === ".sql"
      ? source.replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
      : source;
  return withoutBlockComments
    .split(/\r?\n/u)
    .map((line) =>
      new RegExp(extension === ".sql" ? "^\\s*--" : "^\\s*#", "u").test(line)
        ? ""
        : line,
    )
    .join("\n");
}

function normalizeSqlColumns(value) {
  return value
    .split(",")
    .map((column) => column.replaceAll(/["`\s]/gu, "").toLowerCase())
    .filter(Boolean);
}

function extractSqlWriters(source) {
  const writers = [];
  const pattern =
    /\binsert\s+into\s+(?:(?:"?public"?)\s*\.\s*)?"?email_outbox"?\s*\(([^)]*)\)/giu;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const conflict = source.slice(start).search(/\bon\s+conflict\b/iu);
    const end =
      conflict === -1
        ? Math.min(source.length, start + 5_000)
        : start + conflict + "on conflict".length;
    writers.push({
      kind: "sql",
      columns: normalizeSqlColumns(match[1] ?? ""),
      source: source.slice(start, end),
    });
  }
  return writers;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function objectProperties(node) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  return node.properties
    .map((property) =>
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property)
        ? propertyName(property.name)
        : null,
    )
    .filter(Boolean);
}

function callName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name.text;
  }
  return null;
}

function templatePropertyValues(sourceFile) {
  const templates = new Set();
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === "template" &&
      (ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer))
    ) {
      templates.add(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return templates;
}

function extractJavaScriptEvidence(source, path) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const ormWriters = [];
  const calls = new Set();

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (name) calls.add(name);
      if (
        name === "values" &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isCallExpression(node.expression.expression)
      ) {
        const insertCall = node.expression.expression;
        if (
          callName(insertCall) === "insert" &&
          insertCall.arguments.some(
            (argument) =>
              ts.isIdentifier(argument) && argument.text === "emailOutbox",
          )
        ) {
          ormWriters.push({
            kind: "orm",
            properties: objectProperties(node.arguments[0]),
            source: node.getText(sourceFile),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return {
    calls,
    ormWriters,
    templateProperties: templatePropertyValues(sourceFile),
  };
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

const DISPATCH_POLICY_FUNCTIONS = new Set([
  "accountMailAuthorityPredicate",
  "systemMailAuthorityPredicate",
  "deletionNoticeCapabilityPredicate",
]);

function dispatchAuthoritySource(source) {
  const sourceFile = ts.createSourceFile(
    "policy.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return sourceFile.statements
    .filter((statement) => ts.isFunctionDeclaration(statement))
    .filter(
      (statement) =>
        statement.name && DISPATCH_POLICY_FUNCTIONS.has(statement.name.text),
    )
    .map((statement) => statement.getText(sourceFile))
    .join("\n");
}

export function extractDispatchEnabledTemplates(source) {
  const templates = [];
  const policySource = sourceWithoutComments(
    dispatchAuthoritySource(source),
    ".ts",
  );
  for (const match of policySource.matchAll(
    /\btemplate\s*=\s*'([a-z][a-z0-9-]*)'/giu,
  )) {
    templates.push(match[1]);
  }
  for (const match of policySource.matchAll(
    /\btemplate\s+in\s*\(([^)]*)\)/giu,
  )) {
    for (const value of (match[1] ?? "").matchAll(/'([a-z][a-z0-9-]*)'/giu)) {
      templates.push(value[1]);
    }
  }
  return sortedUnique(templates);
}

function unwrapConstExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function extractProductionEmailTemplates(source) {
  const sourceFile = ts.createSourceFile(
    "template-authority-policy.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== "PRODUCTION_EMAIL_TEMPLATE_DEFINITIONS" ||
        !declaration.initializer
      ) {
        continue;
      }

      let initializer = unwrapConstExpression(declaration.initializer);
      if (
        ts.isCallExpression(initializer) &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        ts.isIdentifier(initializer.expression.expression) &&
        initializer.expression.expression.text === "Object" &&
        initializer.expression.name.text === "freeze" &&
        initializer.arguments.length === 1
      ) {
        initializer = unwrapConstExpression(initializer.arguments[0]);
      }
      if (!ts.isArrayLiteralExpression(initializer)) return [];

      const templates = [];
      for (const element of initializer.elements) {
        const value = unwrapConstExpression(element);
        if (
          !ts.isStringLiteral(value) &&
          !ts.isNoSubstitutionTemplateLiteral(value)
        ) {
          return [];
        }
        templates.push(value.text);
      }
      return sortedUnique(templates);
    }
  }
  return [];
}

function missingFields(actual, required) {
  const values = new Set(actual ?? []);
  return required.filter((field) => !values.has(field));
}

function directWriterTemplates(writer) {
  if (writer.kind === "orm") {
    return [
      ...writer.source.matchAll(
        /\btemplate\s*:\s*["'`]([a-z][a-z0-9-]*)["'`]/giu,
      ),
    ].map((match) => match[1]);
  }
  return [...writer.source.matchAll(/'([a-z][a-z0-9-]*)'/giu)].map(
    (match) => match[1],
  );
}

function producerKey(producer) {
  return `${producer.template}\0${producer.path}\0${producer.call}`;
}

export function auditMailWriterInventory(repositoryRoot, options = {}) {
  const productionFiles = scanProductionFiles(repositoryRoot);
  const sources = new Map(
    productionFiles.map((path) => {
      const source = readFileSync(resolve(repositoryRoot, path), "utf8");
      const extension = extname(path).toLowerCase();
      const uncommented = sourceWithoutComments(source, extension);
      const javascript = JAVASCRIPT_EXTENSIONS.has(extension)
        ? extractJavaScriptEvidence(source, path)
        : {
            calls: new Set(),
            ormWriters: [],
            templateProperties: new Set(),
          };
      return [
        path,
        {
          source,
          uncommented,
          javascript,
          writers: [
            ...extractSqlWriters(uncommented),
            ...javascript.ormWriters,
          ],
        },
      ];
    }),
  );

  const reviewedDirectWriterPaths =
    options.reviewedDirectWriterPaths ?? REVIEWED_DIRECT_WRITER_PATHS;
  const reviewedTemplateProducers =
    options.reviewedTemplateProducers ?? REVIEWED_TEMPLATE_PRODUCERS;
  const centralWriterPath =
    options.centralWriterPath === undefined
      ? "src/lib/notifications/outbox.ts"
      : options.centralWriterPath;
  const reviewedDispatchTemplates =
    options.reviewedDispatchEnabledTemplates ??
    options.dispatchEnabledTemplates ??
    REVIEWED_DISPATCH_ENABLED_TEMPLATES;

  let dispatchEnabledTemplates = options.dispatchEnabledTemplates;
  if (dispatchEnabledTemplates === undefined) {
    const boundary = sources.get(
      "src/lib/notifications/postgres-outbox-store.ts",
    );
    const policy = sources.get(
      "src/lib/notifications/template-authority-policy.ts",
    );
    dispatchEnabledTemplates =
      boundary?.uncommented.includes("TEMPLATE_AUTHORITY_POLICIES") && policy
        ? extractProductionEmailTemplates(policy.source)
        : [];
  }
  dispatchEnabledTemplates = sortedUnique(dispatchEnabledTemplates);

  const errors = [];
  const directWriters = [];
  for (const [path, evidence] of sources) {
    for (const writer of evidence.writers) {
      directWriters.push({ path, ...writer });
    }
  }

  const actualWriterPaths = sortedUnique(directWriters.map(({ path }) => path));
  const reviewedWriterSet = new Set(reviewedDirectWriterPaths);
  for (const path of actualWriterPaths) {
    if (!reviewedWriterSet.has(path)) {
      errors.push(`unreviewed direct email_outbox writer: ${path}`);
    }
  }
  const actualWriterSet = new Set(actualWriterPaths);
  for (const path of reviewedDirectWriterPaths) {
    if (!actualWriterSet.has(path)) {
      errors.push(`reviewed direct email_outbox writer is missing: ${path}`);
    }
  }

  for (const writer of directWriters) {
    if (writer.kind === "sql") {
      for (const field of missingFields(writer.columns, SQL_REQUIRED_COLUMNS)) {
        errors.push(
          `${writer.path}: direct SQL email_outbox writer is missing ${field}`,
        );
      }
      if (!/'[aso]:'\s*\|\|/iu.test(writer.source)) {
        errors.push(
          `${writer.path}: direct SQL email_outbox writer has no canonical delivery scope expression`,
        );
      }
      continue;
    }

    if (writer.path === centralWriterPath) continue;
    if (writer.properties === null) {
      errors.push(
        `${writer.path}: ORM email_outbox writer must use an inline reviewed payload`,
      );
      continue;
    }
    for (const field of missingFields(
      writer.properties,
      ORM_REQUIRED_PROPERTIES,
    )) {
      errors.push(
        `${writer.path}: direct ORM email_outbox writer is missing ${field}`,
      );
    }
  }

  if (centralWriterPath !== null) {
    const central = sources.get(centralWriterPath);
    if (!central) {
      errors.push(
        `central email_outbox writer is missing: ${centralWriterPath}`,
      );
    } else {
      const requiredFragments = [
        ...ORM_REQUIRED_PROPERTIES,
        "_mailOperationId",
        "_mailRecipient",
        "_mailProducer",
        "_mailSourceId",
        "`s:${operationId}`",
        "`a:${input.userId}`",
      ];
      for (const fragment of requiredFragments) {
        if (!central.source.includes(fragment)) {
          errors.push(
            `${centralWriterPath}: central writer is missing ${fragment}`,
          );
        }
      }
    }
  }

  const reviewedProducerKeys = new Set(
    reviewedTemplateProducers.map(producerKey),
  );
  const producers = [];
  for (const producer of reviewedTemplateProducers) {
    const evidence = sources.get(producer.path);
    if (!evidence) {
      errors.push(
        `reviewed producer source is missing: ${producer.template} -> ${producer.path}`,
      );
      continue;
    }
    const hasAuthorityRoutine =
      producer.call === "authority-sql" &&
      evidence.uncommented.includes(
        "public.enqueue_backup_status_mail_authority(",
      );
    const hasTemplate =
      hasAuthorityRoutine ||
      evidence.javascript.templateProperties.has(producer.template) ||
      evidence.writers.some((writer) =>
        directWriterTemplates(writer).includes(producer.template),
      );
    const hasCall =
      hasAuthorityRoutine ||
      (producer.call === "direct-sql"
        ? evidence.writers.some(
            (writer) =>
              writer.kind === "sql" &&
              directWriterTemplates(writer).includes(producer.template),
          )
        : producer.call === "direct-orm"
          ? evidence.writers.some(
              (writer) =>
                writer.kind === "orm" &&
                directWriterTemplates(writer).includes(producer.template),
            )
          : evidence.javascript.calls.has(producer.call));
    if (!hasTemplate || !hasCall) {
      errors.push(
        `reviewed producer evidence is missing: ${producer.template} -> ${producer.path} (${producer.call})`,
      );
      continue;
    }
    producers.push({ ...producer });
  }

  const standardCalls = new Set(["enqueueEmail", "enqueueEmailInTransaction"]);
  for (const [path, evidence] of sources) {
    for (const call of standardCalls) {
      if (!evidence.javascript.calls.has(call)) continue;
      for (const template of evidence.javascript.templateProperties) {
        const producer = { template, path, call };
        if (
          dispatchEnabledTemplates.includes(template) &&
          !reviewedProducerKeys.has(producerKey(producer))
        ) {
          errors.push(
            `unreviewed production mail producer: ${template} -> ${path} (${call})`,
          );
        }
      }
    }
  }

  const reviewedDispatchSet = new Set(reviewedDispatchTemplates);
  const actualDispatchSet = new Set(dispatchEnabledTemplates);
  for (const template of dispatchEnabledTemplates) {
    if (!reviewedDispatchSet.has(template)) {
      errors.push(`dispatch-enabled template is not reviewed: ${template}`);
    }
  }
  for (const template of reviewedDispatchTemplates) {
    if (!actualDispatchSet.has(template)) {
      errors.push(
        `reviewed dispatch template is no longer enabled: ${template}`,
      );
    }
  }

  const producedTemplates = new Set(producers.map(({ template }) => template));
  for (const template of dispatchEnabledTemplates) {
    if (!producedTemplates.has(template)) {
      errors.push(
        `dispatch-enabled template has no reviewed production producer: ${template}`,
      );
    }
  }

  return {
    productionFiles,
    dispatchEnabledTemplates,
    directWriters: directWriters.map((writer) => {
      const publicWriter = { ...writer };
      delete publicWriter.source;
      return publicWriter;
    }),
    producers: producers.sort((left, right) =>
      producerKey(left).localeCompare(producerKey(right)),
    ),
    errors: sortedUnique(errors),
  };
}

export function assertMailWriterInventory(repositoryRoot, options) {
  const report = auditMailWriterInventory(repositoryRoot, options);
  if (report.errors.length > 0) {
    throw new Error(
      `Mail writer inventory rejected the repository:\n- ${report.errors.join("\n- ")}`,
    );
  }
  return report;
}
