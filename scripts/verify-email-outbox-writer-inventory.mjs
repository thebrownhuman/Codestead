#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

export const LIMITS = Object.freeze({
  discoveryBytes: 4 * 1024 * 1024,
  discoveryMilliseconds: 5_000,
  fileBytes: 2 * 1024 * 1024,
  paths: 10_000,
  totalBytes: 64 * 1024 * 1024,
});

export const EXPECTED_WRITERS = Object.freeze([
  Object.freeze({
    functionName: "appendCredentialNotice",
    kind: "drizzle-insert",
    path: "src/lib/admin-credentials/service.ts",
    receiver: "drizzle-transaction",
  }),
  Object.freeze({
    functionName: "decideAppeal",
    kind: "sql-executor",
    path: "src/lib/appeals/admin-service.ts",
    receiver: "pg-client",
  }),
  Object.freeze({
    functionName: "persistOutcome",
    kind: "sql-executor",
    path: "src/lib/assessment-corrections/worker.ts",
    receiver: "pg-client",
  }),
  Object.freeze({
    functionName: "deleteLearnerAccount",
    kind: "sql-executor",
    path: "src/lib/data-lifecycle/deletion.ts",
    receiver: "pg-client",
  }),
  Object.freeze({
    functionName: "persistEmail",
    kind: "sql-executor",
    path: "src/lib/notifications/inactivity.ts",
    receiver: "pg-client",
  }),
  Object.freeze({
    functionName: "queuedEmailInsert",
    kind: "drizzle-sql-executor",
    path: "src/lib/notifications/outbox.ts",
    receiver: "drizzle-db|drizzle-transaction",
  }),
  Object.freeze({
    functionName: "enqueueBackupStatus",
    kind: "delegated-routine-call",
    path: "scripts/backup/enqueue-backup-status.mjs",
    receiver: "pg-client:reporter-factory",
  }),
]);

const AST_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const TEXT_EXTENSIONS = new Set([
  ...AST_EXTENSIONS,
  ".bash",
  ".bat",
  ".c",
  ".cc",
  ".cfg",
  ".cmd",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".dockerfile",
  ".env",
  ".example",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".json",
  ".jsonc",
  ".kt",
  ".kts",
  ".lock",
  ".md",
  ".nft",
  ".path",
  ".php",
  ".properties",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".pyw",
  ".rb",
  ".rs",
  ".service",
  ".sha256",
  ".sh",
  ".sql",
  ".svg",
  ".template",
  ".timer",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".pyc",
  ".tar",
  ".tgz",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);
const TEXT_BASENAMES = new Set([
  ".dockerignore",
  ".gitattributes",
  ".gitignore",
  "Dockerfile",
  "LICENSE",
]);
const TEXT_EXTENSIONLESS_PATHS = new Set([
  "infra/runner-vm/cloud-init/meta-data",
  "infra/runtime/production-load-network-attestation",
]);
const REVIEWED_SQL_WRITER_FILES = new Map([
  ["drizzle/0065_backup_status_mail_authority.sql", 1],
  ["drizzle/0067_mail_outbox_durable_replay_authority.sql", 1],
]);
const OUTBOX_WRITE =
  /\b(?:insert\s+into|copy(?:\s+\w+)*\s+|merge\s+into)\s+(?:"?public"?\s*\.\s*)?"?email_outbox"?(?![a-z0-9_])/iu;
const OUTBOX_TOKEN = /(?:^|[^a-z0-9_])email_outbox(?![a-z0-9_])/iu;
const ROUTINE_CALL =
  /\b(?:call|from|select(?:\s+\*)?\s+from)\s+(?:"?public"?\s*\.\s*)?"?enqueue_backup_status_mail_authority"?\s*\(/iu;
const TEST_PATH =
  /(?:^|\/)(?:__fixtures__|__tests__|fixtures|test|tests)(?:\/|$)|\.(?:spec|test)\.[^/]+$/iu;
const EXCLUDED_PATH =
  /(?:^|\/)(?:\.git|\.next|\.superpowers|coverage|node_modules|vendor)(?:\/|$)/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(detail) {
  throw new Error(`email-outbox-writer-inventory:${detail}`);
}

function decodeUtf8(bytes, label) {
  try {
    return decoder.decode(bytes);
  } catch {
    fail(`non-utf8:${label}`);
  }
}

function compactLexical(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function hasCompactWrite(value) {
  const compact = compactLexical(value);
  return (
    compact.includes("insertintopublicemailoutbox")
    || compact.includes("insertintoemailoutbox")
    || compact.includes("copypublicemailoutbox")
    || compact.includes("copyemailoutbox")
    || compact.includes("mergeintopublicemailoutbox")
    || compact.includes("mergeintoemailoutbox")
  );
}

function hasWriteVerb(value) {
  const compact = compactLexical(value);
  return (
    compact.includes("insertinto")
    || compact.includes("copy")
    || compact.includes("mergeinto")
  );
}

function hasOutboxTaint(value) {
  return OUTBOX_TOKEN.test(value) || compactLexical(value).includes("emailoutbox");
}

function hasRoutineTaint(value) {
  return compactLexical(value).includes(
    "enqueuebackupstatusmailauthority",
  );
}

function hasRoutineCall(value) {
  if (ROUTINE_CALL.test(value)) return true;
  const compact = compactLexical(value);
  return (
    compact.includes("frompublicenqueuebackupstatusmailauthority")
    || compact.includes("fromenqueuebackupstatusmailauthority")
    || compact.includes("callpublicenqueuebackupstatusmailauthority")
    || compact.includes("callenqueuebackupstatusmailauthority")
  );
}

function hasOutboxWrite(value) {
  return OUTBOX_WRITE.test(value) || hasCompactWrite(value);
}

export function validateRepositoryPath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || path.posix.isAbsolute(value)
    || /^[a-z]:/iu.test(value)
  ) {
    fail(`unsafe-path:${JSON.stringify(value)}`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
    || path.posix.normalize(value) !== value
  ) {
    fail(`unsafe-path:${JSON.stringify(value)}`);
  }
  return value;
}

export function parseGitPathOutput(
  output,
  { discoveryBytes = LIMITS.discoveryBytes, paths = LIMITS.paths } = {},
) {
  if (!Buffer.isBuffer(output) || output.length > discoveryBytes) {
    fail("git-output-limit");
  }
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) fail("git-output-not-nul-terminated");
  const fields = output.subarray(0, -1).toString("binary").split("\0");
  if (fields.length > paths) fail("path-count-limit");
  const observed = new Set();
  for (const field of fields) {
    const value = validateRepositoryPath(
      decodeUtf8(Buffer.from(field, "binary"), "git-path"),
    );
    if (observed.has(value)) fail(`duplicate-path:${value}`);
    observed.add(value);
  }
  return [...observed].sort();
}

export function listRepositoryPaths(
  repositoryRoot,
  { limits = LIMITS, spawn = spawnSync } = {},
) {
  const result = spawn(
    "git",
    [
      "-C",
      repositoryRoot,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
    ],
    {
      encoding: null,
      maxBuffer: limits.discoveryBytes,
      timeout: limits.discoveryMilliseconds,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) {
    fail(`git-discovery:${result.error.code ?? result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`git-discovery-status:${String(result.status)}`);
  }
  if (!Buffer.isBuffer(result.stdout)) fail("git-discovery-output");
  return parseGitPathOutput(result.stdout, limits);
}

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function createBoundedByteReader(
  repositoryRoot,
  { limits = LIMITS } = {},
) {
  const lexicalRoot = path.resolve(repositoryRoot);
  const rootStat = lstatSync(lexicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("repository-root-not-real-directory");
  }
  const realRoot = realpathSync(lexicalRoot);
  let totalBytes = 0;
  return (relativePath) => {
    validateRepositoryPath(relativePath);
    const segments = relativePath.split("/");
    let candidate = lexicalRoot;
    let lexicalStat;
    for (const [index, segment] of segments.entries()) {
      candidate = path.join(candidate, segment);
      lexicalStat = lstatSync(candidate);
      if (lexicalStat.isSymbolicLink()) {
        fail(`symlink-or-reparse-path:${relativePath}`);
      }
      if (index < segments.length - 1 && !lexicalStat.isDirectory()) {
        fail(`non-directory-component:${relativePath}`);
      }
    }
    if (lexicalStat === undefined || !lexicalStat.isFile()) {
      fail(`non-regular-file:${relativePath}`);
    }
    const realCandidate = realpathSync(candidate);
    if (!containedBy(realRoot, realCandidate)) {
      fail(`path-escape:${relativePath}`);
    }
    const flags =
      fsConstants.O_RDONLY
      | (typeof fsConstants.O_NOFOLLOW === "number"
        ? fsConstants.O_NOFOLLOW
        : 0);
    let descriptor;
    try {
      descriptor = openSync(candidate, flags);
      const openedStat = fstatSync(descriptor);
      if (
        !openedStat.isFile()
        || openedStat.size !== lexicalStat.size
        || (
          lexicalStat.dev !== 0
          && openedStat.dev !== 0
          && (
            openedStat.dev !== lexicalStat.dev
            || openedStat.ino !== lexicalStat.ino
          )
        )
      ) {
        fail(`file-changed-before-read:${relativePath}`);
      }
      if (
        openedStat.size > limits.fileBytes
        || totalBytes + openedStat.size > limits.totalBytes
      ) {
        fail(`file-size-limit:${relativePath}`);
      }
      const bytes = Buffer.alloc(openedStat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(
          descriptor,
          bytes,
          offset,
          bytes.length - offset,
          null,
        );
        if (count === 0) break;
        offset += count;
      }
      if (offset !== openedStat.size) {
        fail(`file-changed-during-read:${relativePath}`);
      }
      totalBytes += offset;
      return bytes.subarray(0, offset);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
}

export function createBoundedReader(repositoryRoot, options = {}) {
  const readBytes = createBoundedByteReader(repositoryRoot, options);
  return (relativePath) => decodeUtf8(readBytes(relativePath), relativePath);
}

function scriptKind(relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression !== undefined
    && (
      ts.isStringLiteral(expression.argumentExpression)
      || ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)
    )
  ) {
    return expression.argumentExpression.text;
  }
  return null;
}

function hasExportModifier(node) {
  return node.modifiers?.some(
    ({ kind }) => kind === ts.SyntaxKind.ExportKeyword,
  ) ?? false;
}

function declaredFunctionName(node) {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
  if (
    (
      ts.isArrowFunction(node)
      || ts.isFunctionExpression(node)
    )
    && ts.isVariableDeclaration(node.parent)
    && ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return null;
}

function enclosingFunctionName(node) {
  let current = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isFunctionDeclaration(current)) {
      return current.name?.text ?? null;
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const name = declaredFunctionName(current);
      if (name !== null) return name;
    }
    current = current.parent;
  }
  return null;
}

function collectBindings(sourceFile) {
  const assignments = new Map();
  const declarations = new Map();
  const functions = new Map();
  const imports = new Map();
  const outboxNames = new Set();
  const schemaNamespaces = new Set();
  const sqlNames = new Set();
  const drizzleNamespaces = new Set();
  const typeAliases = new Map();
  const rememberDeclaration = (name, declaration) => {
    const entries = declarations.get(name) ?? [];
    entries.push(declaration);
    declarations.set(name, entries);
  };
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.importClause !== undefined
    ) {
      const moduleName = node.moduleSpecifier.text;
      if (node.importClause.name !== undefined) {
        imports.set(node.importClause.name.text, {
          imported: "default",
          moduleName,
        });
      }
      const bindings = node.importClause.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          imports.set(element.name.text, { imported, moduleName });
          if (
            imported === "emailOutbox"
            && /(?:^|\/)(?:db\/)?schema$/u.test(moduleName)
          ) {
            outboxNames.add(element.name.text);
          }
          if (imported === "sql" && moduleName === "drizzle-orm") {
            sqlNames.add(element.name.text);
          }
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        imports.set(bindings.name.text, { imported: "*", moduleName });
        if (/(?:^|\/)(?:db\/)?schema$/u.test(moduleName)) {
          schemaNamespaces.add(bindings.name.text);
        }
        if (moduleName === "drizzle-orm") {
          drizzleNamespaces.add(bindings.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      rememberDeclaration(node.name.text, node);
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(unwrap(node.left))
    ) {
      const name = unwrap(node.left).text;
      const entries = assignments.get(name) ?? [];
      entries.push(node);
      assignments.set(name, entries);
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      functions.set(node.name.text, node);
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined
      && (
        ts.isArrowFunction(unwrap(node.initializer))
        || ts.isFunctionExpression(unwrap(node.initializer))
      )
    ) {
      functions.set(node.name.text, unwrap(node.initializer));
    }
    if (ts.isTypeAliasDeclaration(node)) {
      typeAliases.set(node.name.text, node.type);
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer !== undefined
      && ts.isIdentifier(unwrap(node.initializer))
      && schemaNamespaces.has(unwrap(node.initializer).text)
    ) {
      for (const element of node.name.elements) {
        const imported = element.propertyName !== undefined
          && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null;
        if (imported === "emailOutbox" && ts.isIdentifier(element.name)) {
          outboxNames.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    assignments,
    declarations,
    drizzleNamespaces,
    functions,
    imports,
    outboxNames,
    schemaNamespaces,
    sourceFile,
    sqlNames,
    typeAliases,
  };
}

function declarationScopeName(node) {
  return enclosingFunctionName(node);
}

function findVariableDeclaration(bindings, name, usage) {
  const entries = bindings.declarations.get(name) ?? [];
  const scope = enclosingFunctionName(usage);
  const scoped = entries.filter(
    (entry) =>
      declarationScopeName(entry) === scope
      && entry.getStart() <= usage.getStart(),
  );
  if (scoped.length > 0) return scoped.at(-1);
  const topLevel = entries.filter(
    (entry) => declarationScopeName(entry) === null,
  );
  return topLevel.length === 1 ? topLevel[0] : null;
}

function findParameter(bindings, name, usage) {
  let current = usage.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      ts.isFunctionDeclaration(current)
      || ts.isFunctionExpression(current)
      || ts.isArrowFunction(current)
      || ts.isMethodDeclaration(current)
    ) {
      const parameter = current.parameters.find(
        ({ name: parameterName }) =>
          ts.isIdentifier(parameterName) && parameterName.text === name,
      );
      if (parameter !== undefined) return parameter;
    }
    current = current.parent;
  }
  return null;
}

function localInitializer(bindings, name, usage) {
  const declaration = findVariableDeclaration(bindings, name, usage);
  if (declaration?.initializer !== undefined) return declaration.initializer;
  const scope = enclosingFunctionName(usage);
  const assigned = (bindings.assignments.get(name) ?? []).filter(
    (entry) =>
      enclosingFunctionName(entry) === scope
      && entry.getStart() <= usage.getStart(),
  );
  return assigned.at(-1)?.right ?? null;
}

function aliasResolver(bindings) {
  const resolveAlias = (expression, predicate, usage, seen = new Set()) => {
    const current = unwrap(expression);
    if (predicate(current)) return true;
    if (!ts.isIdentifier(current) || seen.has(current.text)) return false;
    const initializer = localInitializer(bindings, current.text, usage);
    if (initializer === null) return false;
    seen.add(current.text);
    return resolveAlias(initializer, predicate, usage, seen);
  };
  const mayReferenceOutbox = (expression, usage, seen = new Set()) => {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) {
      if (bindings.outboxNames.has(current.text)) return true;
      if (seen.has(current.text)) return false;
      const initializer = localInitializer(bindings, current.text, usage);
      if (initializer === null) return false;
      seen.add(current.text);
      return mayReferenceOutbox(initializer, usage, seen);
    }
    if (
      (
        ts.isPropertyAccessExpression(current)
        || ts.isElementAccessExpression(current)
      )
      && ts.isIdentifier(unwrap(current.expression))
      && bindings.schemaNamespaces.has(unwrap(current.expression).text)
    ) {
      return propertyName(current) === "emailOutbox";
    }
    let observed = false;
    ts.forEachChild(current, (child) => {
      observed ||= mayReferenceOutbox(child, usage, new Set(seen));
    });
    return observed;
  };
  return {
    isOutbox(expression, usage) {
      return resolveAlias(expression, (candidate) => {
        if (ts.isIdentifier(candidate)) {
          return bindings.outboxNames.has(candidate.text);
        }
        return (
          (
            ts.isPropertyAccessExpression(candidate)
            || ts.isElementAccessExpression(candidate)
          )
          && ts.isIdentifier(unwrap(candidate.expression))
          && bindings.schemaNamespaces.has(unwrap(candidate.expression).text)
          && propertyName(candidate) === "emailOutbox"
        );
      }, usage);
    },
    isSqlTag(expression, usage) {
      return resolveAlias(expression, (candidate) => {
        if (ts.isIdentifier(candidate)) {
          return bindings.sqlNames.has(candidate.text);
        }
        return (
          (
            ts.isPropertyAccessExpression(candidate)
            || ts.isElementAccessExpression(candidate)
          )
          && ts.isIdentifier(unwrap(candidate.expression))
          && bindings.drizzleNamespaces.has(unwrap(candidate.expression).text)
          && propertyName(candidate) === "sql"
        );
      }, usage);
    },
    mayReferenceOutbox,
  };
}

function staticStringArrays(expression, bindings, usage, seen, depth) {
  if (depth > 24) return { unknown: true, values: [] };
  const current = unwrap(expression);
  if (ts.isArrayLiteralExpression(current)) {
    const values = [];
    let unknown = false;
    for (const element of current.elements) {
      const result = staticStrings(
        element,
        bindings,
        usage,
        new Set(seen),
        depth + 1,
      );
      unknown ||= result.unknown;
      if (result.values.length !== 1) unknown = true;
      values.push(result.values[0] ?? "?");
    }
    return { unknown, values };
  }
  if (ts.isIdentifier(current) && !seen.has(current.text)) {
    const initializer = localInitializer(bindings, current.text, usage);
    if (initializer !== null) {
      seen.add(current.text);
      return staticStringArrays(
        initializer,
        bindings,
        usage,
        seen,
        depth + 1,
      );
    }
  }
  return { unknown: true, values: [] };
}

function functionReturnExpressions(bindings, name) {
  const fn = bindings.functions.get(name);
  if (fn === undefined) return [];
  const returns = [];
  const visit = (node) => {
    if (
      node !== fn
      && (
        ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node)
      )
    ) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    returns.push(fn.body);
  } else {
    visit(fn);
  }
  return returns;
}

function staticStrings(
  expression,
  bindings,
  usage = expression,
  seen = new Set(),
  depth = 0,
) {
  if (depth > 24) return { nodes: new Set(), unknown: true, values: [] };
  const current = unwrap(expression);
  if (
    ts.isStringLiteral(current)
    || ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return { nodes: new Set([current]), unknown: false, values: [current.text] };
  }
  if (ts.isTemplateExpression(current)) {
    let states = [current.head.text];
    const nodes = new Set([current]);
    let unknown = false;
    for (const span of current.templateSpans) {
      const resolved = staticStrings(
        span.expression,
        bindings,
        usage,
        new Set(seen),
        depth + 1,
      );
      for (const node of resolved.nodes) nodes.add(node);
      unknown ||= resolved.unknown;
      const substitutions = resolved.values.length === 0
        ? ["?"]
        : resolved.values;
      states = states.flatMap((prefix) =>
        substitutions.map((value) => `${prefix}${value}${span.literal.text}`)
      );
      if (states.length > 32) return { nodes, unknown: true, values: [] };
    }
    return { nodes, unknown, values: states };
  }
  if (
    ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStrings(
      current.left,
      bindings,
      usage,
      new Set(seen),
      depth + 1,
    );
    const right = staticStrings(
      current.right,
      bindings,
      usage,
      new Set(seen),
      depth + 1,
    );
    const values = left.values.flatMap((prefix) =>
      right.values.map((suffix) => `${prefix}${suffix}`)
    );
    return {
      nodes: new Set([...left.nodes, ...right.nodes]),
      unknown: left.unknown || right.unknown || values.length > 32,
      values: values.length > 32 ? [] : values,
    };
  }
  if (ts.isConditionalExpression(current)) {
    const yes = staticStrings(
      current.whenTrue,
      bindings,
      usage,
      new Set(seen),
      depth + 1,
    );
    const no = staticStrings(
      current.whenFalse,
      bindings,
      usage,
      new Set(seen),
      depth + 1,
    );
    const values = [...new Set([...yes.values, ...no.values])];
    return {
      nodes: new Set([...yes.nodes, ...no.nodes]),
      unknown: yes.unknown || no.unknown || values.length > 32,
      values: values.length > 32 ? [] : values,
    };
  }
  if (ts.isCallExpression(current)) {
    if (
      propertyName(current.expression) === "join"
      && (
        ts.isPropertyAccessExpression(current.expression)
        || ts.isElementAccessExpression(current.expression)
      )
    ) {
      const array = staticStringArrays(
        current.expression.expression,
        bindings,
        usage,
        new Set(seen),
        depth + 1,
      );
      const separator = current.arguments.length === 0
        ? { unknown: false, values: [","] }
        : staticStrings(
          current.arguments[0],
          bindings,
          usage,
          new Set(seen),
          depth + 1,
        );
      if (separator.values.length === 1 && array.values.length > 0) {
        return {
          nodes: new Set(separator.nodes ?? []),
          unknown: array.unknown || separator.unknown,
          values: [array.values.join(separator.values[0])],
        };
      }
    }
    if (
      propertyName(current.expression) === "concat"
      && (
        ts.isPropertyAccessExpression(current.expression)
        || ts.isElementAccessExpression(current.expression)
      )
    ) {
      const parts = [
        staticStrings(
          current.expression.expression,
          bindings,
          usage,
          new Set(seen),
          depth + 1,
        ),
        ...current.arguments.map((argument) =>
          staticStrings(
            argument,
            bindings,
            usage,
            new Set(seen),
            depth + 1,
          )
        ),
      ];
      let values = [""];
      const nodes = new Set();
      let unknown = false;
      for (const part of parts) {
        for (const node of part.nodes) nodes.add(node);
        unknown ||= part.unknown;
        values = values.flatMap((prefix) =>
          part.values.map((suffix) => `${prefix}${suffix}`)
        );
      }
      return {
        nodes,
        unknown: unknown || values.length > 32,
        values: values.length > 32 ? [] : values,
      };
    }
    if (
      ts.isIdentifier(current.expression)
      && current.arguments.length === 0
      && !seen.has(`function:${current.expression.text}`)
    ) {
      const returns = functionReturnExpressions(
        bindings,
        current.expression.text,
      );
      if (returns.length > 0) {
        seen.add(`function:${current.expression.text}`);
        const results = returns.map((returned) =>
          staticStrings(
            returned,
            bindings,
            usage,
            new Set(seen),
            depth + 1,
          )
        );
        return {
          nodes: new Set(results.flatMap(({ nodes }) => [...nodes])),
          unknown: results.some(({ unknown }) => unknown),
          values: [...new Set(results.flatMap(({ values }) => values))],
        };
      }
    }
  }
  if (ts.isIdentifier(current) && !seen.has(`value:${current.text}`)) {
    const initializer = localInitializer(bindings, current.text, usage);
    if (initializer !== null) {
      seen.add(`value:${current.text}`);
      return staticStrings(
        initializer,
        bindings,
        usage,
        seen,
        depth + 1,
      );
    }
  }
  return { nodes: new Set(), unknown: true, values: [] };
}

function resolvedSource(expression, bindings, usage, seen = new Set(), depth = 0) {
  if (depth > 24) return "";
  const current = unwrap(expression);
  let output = current.getText(bindings.sourceFile);
  if (ts.isIdentifier(current) && !seen.has(`value:${current.text}`)) {
    const initializer = localInitializer(bindings, current.text, usage);
    if (initializer !== null) {
      seen.add(`value:${current.text}`);
      output += resolvedSource(
        initializer,
        bindings,
        usage,
        seen,
        depth + 1,
      );
    }
  }
  if (
    ts.isCallExpression(current)
    && ts.isIdentifier(current.expression)
    && !seen.has(`function:${current.expression.text}`)
  ) {
    seen.add(`function:${current.expression.text}`);
    for (const returned of functionReturnExpressions(
      bindings,
      current.expression.text,
    )) {
      output += resolvedSource(
        returned,
        bindings,
        usage,
        seen,
        depth + 1,
      );
    }
  }
  ts.forEachChild(current, (child) => {
    output += resolvedSource(child, bindings, usage, new Set(seen), depth + 1);
  });
  return output;
}

function importedAs(bindings, localName, moduleName, imported) {
  const binding = bindings.imports.get(localName);
  return binding?.moduleName === moduleName && binding.imported === imported;
}

function parameterReceiverKind(parameter, bindings) {
  if (parameter?.type === undefined) return null;
  const typeText = parameter.type.getText(bindings.sourceFile);
  if (
    ts.isTypeReferenceNode(parameter.type)
    && ts.isIdentifier(parameter.type.typeName)
  ) {
    const local = parameter.type.typeName.text;
    if (importedAs(bindings, local, "pg", "PoolClient")) return "pg-client";
    if (
      importedAs(
        bindings,
        local,
        "@/lib/security/audit-writer",
        "AuditTransaction",
      )
    ) {
      return "drizzle-transaction";
    }
    const alias = bindings.typeAliases.get(local);
    if (alias !== undefined) {
      const compact = alias.getText(bindings.sourceFile).replace(/\s+/gu, "");
      const dbImports = [...bindings.imports.entries()].filter(
        ([, value]) =>
          value.moduleName === "@/lib/db/client" && value.imported === "db",
      );
      if (
        dbImports.some(([name]) =>
          compact ===
            `Parameters<Parameters<typeof${name}.transaction>[0]>[0]`
        )
      ) {
        return "drizzle-transaction";
      }
    }
  }
  if (typeText === "PoolClient") {
    const binding = bindings.imports.get("PoolClient");
    if (binding?.moduleName === "pg") return "pg-client";
  }
  return null;
}

function isUnshadowedGlobalType(bindings, name) {
  if (bindings.imports.has(name) || bindings.typeAliases.has(name)) {
    return false;
  }
  return !bindings.sourceFile.statements.some((statement) =>
    (
      ts.isInterfaceDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement)
    )
    && statement.name?.text === name
  );
}

function typeLiteralFrom(typeNode, bindings, seen = new Set()) {
  if (ts.isTypeLiteralNode(typeNode)) return typeNode;
  if (
    !ts.isTypeReferenceNode(typeNode)
    || !ts.isIdentifier(typeNode.typeName)
    || seen.has(typeNode.typeName.text)
  ) {
    return null;
  }
  const alias = bindings.typeAliases.get(typeNode.typeName.text);
  if (alias === undefined) return null;
  seen.add(typeNode.typeName.text);
  return typeLiteralFrom(alias, bindings, seen);
}

function readonlyTypeLiteralFrom(typeNode, bindings, seen = new Set()) {
  if (
    !ts.isTypeReferenceNode(typeNode)
    || !ts.isIdentifier(typeNode.typeName)
    || seen.has(typeNode.typeName.text)
  ) {
    return null;
  }
  const name = typeNode.typeName.text;
  const alias = bindings.typeAliases.get(name);
  if (alias !== undefined) {
    seen.add(name);
    return readonlyTypeLiteralFrom(alias, bindings, seen);
  }
  if (
    name !== "Readonly"
    || !isUnshadowedGlobalType(bindings, name)
    || typeNode.typeArguments?.length !== 1
  ) {
    return null;
  }
  return typeLiteralFrom(typeNode.typeArguments[0], bindings);
}

function isExactPgClientFactoryType(typeNode, bindings) {
  if (
    typeNode === undefined
    || !ts.isFunctionTypeNode(typeNode)
    || typeNode.parameters.length !== 0
    || !ts.isTypeReferenceNode(typeNode.type)
    || !ts.isIdentifier(typeNode.type.typeName)
    || typeNode.type.typeName.text !== "Promise"
    || !isUnshadowedGlobalType(bindings, "Promise")
    || typeNode.type.typeArguments?.length !== 1
  ) {
    return false;
  }
  const clientType = typeNode.type.typeArguments[0];
  return (
    ts.isTypeReferenceNode(clientType)
    && ts.isIdentifier(clientType.typeName)
    && clientType.typeArguments === undefined
    && importedAs(bindings, clientType.typeName.text, "pg", "PoolClient")
  );
}

function isExactOptionalPgClientProperty(parameter, property, bindings) {
  if (
    parameter?.type === undefined
    || parameter.questionToken !== undefined
    || parameter.dotDotDotToken !== undefined
  ) {
    return false;
  }
  const literal = readonlyTypeLiteralFrom(parameter.type, bindings);
  if (literal === null) return false;
  const matches = literal.members.filter((member) =>
    ts.isPropertySignature(member)
    && ts.isIdentifier(member.name)
    && member.name.text === property
  );
  return (
    matches.length === 1
    && matches[0].questionToken !== undefined
    && isExactPgClientFactoryType(matches[0].type, bindings)
  );
}

function isConstVariableDeclaration(declaration) {
  return (
    declaration !== null
    && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function isExactImportedPoolConnect(expression, bindings) {
  const current = unwrap(expression);
  if (
    !ts.isCallExpression(current)
    || current.arguments.length !== 0
    || current.typeArguments?.length > 0
    || current.questionDotToken !== undefined
    || !ts.isPropertyAccessExpression(current.expression)
    || current.expression.questionDotToken !== undefined
    || current.expression.name.text !== "connect"
  ) {
    return false;
  }
  const owner = unwrap(current.expression.expression);
  return (
    ts.isIdentifier(owner)
    && importedAs(bindings, owner.text, "@/lib/db/client", "pool")
  );
}

function trustedOptionalPgClientFactoryCall(
  expression,
  bindings,
  usage,
) {
  const current = unwrap(expression);
  if (
    !ts.isCallExpression(current)
    || current.arguments.length !== 0
    || current.typeArguments?.length > 0
    || current.questionDotToken !== undefined
    || !ts.isIdentifier(unwrap(current.expression))
  ) {
    return false;
  }
  const factoryName = unwrap(current.expression).text;
  const factoryDeclaration = findVariableDeclaration(
    bindings,
    factoryName,
    usage,
  );
  if (
    !isConstVariableDeclaration(factoryDeclaration)
    || declarationScopeName(factoryDeclaration)
      !== enclosingFunctionName(usage)
    || (bindings.assignments.get(factoryName) ?? []).length !== 0
    || factoryDeclaration.initializer === undefined
  ) {
    return false;
  }
  const selection = unwrap(factoryDeclaration.initializer);
  if (
    !ts.isBinaryExpression(selection)
    || selection.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
  ) {
    return false;
  }
  const injected = unwrap(selection.left);
  const fallback = unwrap(selection.right);
  if (
    !ts.isPropertyAccessExpression(injected)
    || injected.questionDotToken !== undefined
    || injected.name.text !== "acquireClient"
    || !ts.isIdentifier(unwrap(injected.expression))
    || !ts.isIdentifier(fallback)
  ) {
    return false;
  }
  const dependencyName = unwrap(injected.expression).text;
  const dependencyParameter = findParameter(
    bindings,
    dependencyName,
    selection,
  );
  if (
    !isExactOptionalPgClientProperty(
      dependencyParameter,
      "acquireClient",
      bindings,
    )
    || (bindings.assignments.get(dependencyName) ?? []).length !== 0
  ) {
    return false;
  }
  const fallbackDeclaration = findVariableDeclaration(
    bindings,
    fallback.text,
    selection,
  );
  if (
    !isConstVariableDeclaration(fallbackDeclaration)
    || declarationScopeName(fallbackDeclaration) !== null
    || (bindings.assignments.get(fallback.text) ?? []).length !== 0
    || fallbackDeclaration.initializer === undefined
  ) {
    return false;
  }
  const fallbackFunction = unwrap(fallbackDeclaration.initializer);
  return (
    ts.isArrowFunction(fallbackFunction)
    && fallbackFunction.parameters.length === 0
    && fallbackFunction.typeParameters === undefined
    && !ts.isBlock(fallbackFunction.body)
    && isExactImportedPoolConnect(fallbackFunction.body, bindings)
  );
}

function trustedPoolFactory(expression, bindings) {
  const current = unwrap(expression);
  if (
    !ts.isBinaryExpression(current)
    || current.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
  ) {
    return false;
  }
  let hasPgPoolFallback = false;
  const visit = (node) => {
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(unwrap(node.expression))
      && importedAs(bindings, unwrap(node.expression).text, "pg", "Pool")
    ) {
      hasPgPoolFallback = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(current);
  return hasPgPoolFallback;
}

function poolKind(expression, bindings, usage, seen = new Set()) {
  const current = unwrap(expression);
  if (ts.isIdentifier(current)) {
    if (importedAs(bindings, current.text, "@/lib/db/client", "pool")) {
      return "pg-pool";
    }
    if (seen.has(`pool:${current.text}`)) return null;
    const initializer = localInitializer(bindings, current.text, usage);
    if (initializer !== null) {
      seen.add(`pool:${current.text}`);
      return poolKind(initializer, bindings, usage, seen);
    }
  }
  if (
    ts.isNewExpression(current)
    && ts.isIdentifier(unwrap(current.expression))
    && importedAs(bindings, unwrap(current.expression).text, "pg", "Pool")
  ) {
    return "pg-pool";
  }
  if (
    ts.isCallExpression(current)
    && ts.isIdentifier(unwrap(current.expression))
  ) {
    const factory = localInitializer(
      bindings,
      unwrap(current.expression).text,
      usage,
    );
    if (
      factory !== null
      && trustedPoolFactory(factory, bindings)
    ) {
      return "pg-pool:reporter-factory";
    }
  }
  return null;
}

function connectReceiverFrom(expression, bindings, usage, seen) {
  const current = unwrap(expression);
  if (trustedOptionalPgClientFactoryCall(current, bindings, usage)) {
    return "pg-client";
  }
  if (
    ts.isCallExpression(current)
    && propertyName(current.expression) === "connect"
    && (
      ts.isPropertyAccessExpression(current.expression)
      || ts.isElementAccessExpression(current.expression)
    )
  ) {
    const owner = poolKind(
      current.expression.expression,
      bindings,
      usage,
      seen,
    );
    if (owner === "pg-pool:reporter-factory") {
      return "pg-client:reporter-factory";
    }
    if (owner === "pg-pool") return "pg-client";
  }
  if (ts.isCallExpression(current)) {
    for (const argument of current.arguments) {
      const candidate = unwrap(argument);
      if (
        ts.isArrowFunction(candidate)
        || ts.isFunctionExpression(candidate)
      ) {
        if (!ts.isBlock(candidate.body)) {
          const resolved = connectReceiverFrom(
            candidate.body,
            bindings,
            usage,
            seen,
          );
          if (resolved !== null) return resolved;
        }
      }
    }
  }
  return null;
}

function receiverKind(expression, bindings, usage, seen = new Set()) {
  const current = unwrap(expression);
  if (ts.isIdentifier(current)) {
    if (importedAs(bindings, current.text, "@/lib/db/client", "db")) {
      return "drizzle-db";
    }
    if (importedAs(bindings, current.text, "@/lib/db/client", "pool")) {
      return "pg-pool";
    }
    const parameter = findParameter(bindings, current.text, usage);
    const typed = parameterReceiverKind(parameter, bindings);
    if (typed !== null) return typed;
    if (seen.has(`receiver:${current.text}`)) return null;
    const initializer = localInitializer(bindings, current.text, usage);
    if (initializer !== null) {
      seen.add(`receiver:${current.text}`);
      const connected = connectReceiverFrom(
        initializer,
        bindings,
        usage,
        seen,
      );
      if (connected !== null) return connected;
      const pooled = poolKind(initializer, bindings, usage, seen);
      if (pooled !== null) return pooled;
      return receiverKind(initializer, bindings, usage, seen);
    }
    return null;
  }
  return connectReceiverFrom(current, bindings, usage, seen)
    ?? poolKind(current, bindings, usage, seen);
}

function isExecutorCall(node) {
  return (
    ts.isCallExpression(node)
    && ["execute", "query"].includes(propertyName(unwrap(node.expression)))
    && (
      ts.isPropertyAccessExpression(unwrap(node.expression))
      || ts.isElementAccessExpression(unwrap(node.expression))
    )
  );
}

function executorReceiver(node) {
  const expression = unwrap(node.expression);
  return expression.expression;
}

function isObservedDrizzleCall(node) {
  let current = node.parent;
  while (
    current !== undefined
    && !ts.isExpressionStatement(current)
    && !ts.isVariableDeclaration(current)
    && !ts.isSourceFile(current)
  ) {
    if (ts.isAwaitExpression(current) || ts.isReturnStatement(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isStaticallyUnreachable(node) {
  let current = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      ts.isIfStatement(current)
      && current.thenStatement.pos <= node.pos
      && node.end <= current.thenStatement.end
      && current.expression.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return true;
    }
    if (
      (
        ts.isWhileStatement(current)
        || ts.isDoStatement(current)
      )
      && current.expression.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function buildReachability(sourceFile, bindings) {
  const edges = new Map();
  const roots = new Set();
  for (const [name, fn] of bindings.functions) {
    edges.set(name, new Set());
    const declaration = ts.isVariableDeclaration(fn.parent)
      ? fn.parent.parent.parent
      : fn;
    if (hasExportModifier(fn) || hasExportModifier(declaration)) {
      roots.add(name);
    }
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(unwrap(node.expression))
      && bindings.functions.has(unwrap(node.expression).text)
    ) {
      const owner = enclosingFunctionName(node);
      if (owner !== null && edges.has(owner)) {
        edges.get(owner).add(unwrap(node.expression).text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const reachable = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const target of edges.get(current) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  return reachable;
}

function location(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return `${position.line + 1}:${position.character + 1}`;
}

function expressionCallsFunction(expression, functionName) {
  const current = unwrap(expression);
  return (
    ts.isCallExpression(current)
    && ts.isIdentifier(unwrap(current.expression))
    && unwrap(current.expression).text === functionName
  );
}

function expressionCallsTaggedStatement(expression, bindings) {
  const current = unwrap(expression);
  if (
    !ts.isCallExpression(current)
    || !ts.isIdentifier(unwrap(current.expression))
  ) {
    return false;
  }
  return functionReturnExpressions(
    bindings,
    unwrap(current.expression).text,
  ).some((returned) => ts.isTaggedTemplateExpression(unwrap(returned)));
}

export function analyzeAstSource(relativePath, source) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(relativePath),
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    fail(`parse:${relativePath}:${sourceFile.parseDiagnostics[0].start ?? 0}`);
  }
  const bindings = collectBindings(sourceFile);
  const resolve = aliasResolver(bindings);
  const reachable = buildReachability(sourceFile, bindings);
  const consumed = new Set();
  const policyReferenceFile = relativePath ===
    "scripts/verify-email-outbox-writer-inventory.mjs";
  const candidates = [];
  const violations = [];
  const executorCalls = [];
  const writerTags = [];
  const addViolation = (kind, node) => {
    violations.push(`${kind}:${location(sourceFile, node)}`);
  };
  const requireReachable = (node) => {
    const functionName = enclosingFunctionName(node);
    if (
      isStaticallyUnreachable(node)
      || (functionName !== null && !reachable.has(functionName))
    ) {
      addViolation("dead-writer", node);
      return false;
    }
    return true;
  };

  const visit = (node) => {
    if (isExecutorCall(node)) executorCalls.push(node);
    if (
      ts.isCallExpression(node)
      && propertyName(unwrap(node.expression)) === "insert"
      && (
        ts.isPropertyAccessExpression(unwrap(node.expression))
        || ts.isElementAccessExpression(unwrap(node.expression))
      )
      && node.arguments.length > 0
    ) {
      if (resolve.isOutbox(node.arguments[0], node)) {
        const receiver = receiverKind(
          unwrap(node.expression).expression,
          bindings,
          node,
        );
        if (receiver !== "drizzle-transaction" && receiver !== "drizzle-db") {
          addViolation("untrusted-drizzle-receiver", node);
        } else if (!isObservedDrizzleCall(node)) {
          addViolation("unobserved-drizzle", node);
        } else if (requireReachable(node)) {
          candidates.push({
            functionName: enclosingFunctionName(node),
            kind: "drizzle-insert",
            node,
            receiver,
          });
        }
      } else if (
        resolve.mayReferenceOutbox(node.arguments[0], node)
        || /email\s*Outbox/iu.test(node.arguments[0].getText(sourceFile))
      ) {
        addViolation("unresolved-drizzle", node);
      }
    }

    if (isExecutorCall(node) && node.arguments.length > 0) {
      const argument = unwrap(node.arguments[0]);
      if (
        !ts.isTaggedTemplateExpression(argument)
        && !expressionCallsTaggedStatement(argument, bindings)
      ) {
        const evaluated = staticStrings(argument, bindings, node);
        const writes = evaluated.values.filter(hasOutboxWrite);
        const routines = evaluated.values.filter(hasRoutineCall);
        if (writes.length > 0 || routines.length > 0) {
          for (const literal of evaluated.nodes) consumed.add(literal);
          const receiver = receiverKind(executorReceiver(node), bindings, node);
          const method = propertyName(unwrap(node.expression));
          const trusted = method === "query"
            ? receiver?.startsWith("pg-")
            : receiver === "drizzle-db"
              || receiver === "drizzle-transaction";
          if (!trusted) {
            addViolation("untrusted-sql-receiver", node);
          } else if (requireReachable(node)) {
            candidates.push({
              functionName: enclosingFunctionName(node),
              kind: writes.length > 0
                ? "sql-executor"
                : "delegated-routine-call",
              node,
              receiver,
            });
          }
        } else if (evaluated.unknown) {
          const dataflow = resolvedSource(argument, bindings, node);
          if (
            (hasOutboxTaint(dataflow) && hasWriteVerb(dataflow))
            || hasRoutineTaint(dataflow)
          ) {
            addViolation("dynamic-or-split-executor", node);
          }
        }
      }
    }

    if (ts.isTaggedTemplateExpression(node)) {
      const evaluated = staticStrings(node.template, bindings, node);
      if (evaluated.values.some(hasOutboxWrite)) {
        for (const literal of evaluated.nodes) consumed.add(literal);
        writerTags.push(node);
        if (!resolve.isSqlTag(node.tag, node)) {
          addViolation("unresolved-sql-tag", node);
        }
      } else if (
        evaluated.unknown
        && hasOutboxTaint(resolvedSource(node.template, bindings, node))
        && hasWriteVerb(resolvedSource(node.template, bindings, node))
      ) {
        addViolation("dynamic-or-split-sql-tag", node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const tag of writerTags) {
    if (!resolve.isSqlTag(tag.tag, tag)) continue;
    const functionName = enclosingFunctionName(tag);
    const executions = executorCalls.filter((call) => {
      if (call.arguments.length === 0) return false;
      const argument = unwrap(call.arguments[0]);
      return argument === tag
        || (
          functionName !== null
          && expressionCallsFunction(argument, functionName)
        );
    });
    if (executions.length === 0) {
      addViolation("unexecuted-sql-tag", tag);
      continue;
    }
    const receivers = new Set();
    for (const execution of executions) {
      const receiver = receiverKind(
        executorReceiver(execution),
        bindings,
        execution,
      );
      if (
        propertyName(unwrap(execution.expression)) !== "execute"
        || (
          receiver !== "drizzle-db"
          && receiver !== "drizzle-transaction"
        )
      ) {
        addViolation("untrusted-sql-receiver", execution);
      } else {
        receivers.add(receiver);
      }
    }
    if (
      executions.every((execution) => {
        const receiver = receiverKind(
          executorReceiver(execution),
          bindings,
          execution,
        );
        return (
          propertyName(unwrap(execution.expression)) === "execute"
          && ["drizzle-db", "drizzle-transaction"].includes(receiver)
        );
      })
      && requireReachable(tag)
    ) {
      candidates.push({
        functionName,
        kind: "drizzle-sql-executor",
        node: tag,
        receiver: [...receivers].sort().join("|"),
      });
    }
  }

  const inspectInert = (node) => {
    if (
      (
        ts.isStringLiteral(node)
        || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateExpression(node)
      )
      && !policyReferenceFile
      && !consumed.has(node)
      && hasOutboxWrite(node.getText(sourceFile))
    ) {
      addViolation("inert-write-literal", node);
    }
    if (
      ts.isVariableDeclaration(node)
      && node.initializer !== undefined
    ) {
      const evaluated = staticStrings(node.initializer, bindings, node);
      if (
        !policyReferenceFile
        && evaluated.values.some(hasOutboxWrite)
        && [...evaluated.nodes].every((literal) => !consumed.has(literal))
      ) {
        addViolation("inert-composed-write", node);
      }
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const evaluated = staticStrings(node.expression, bindings, node);
      if (
        !policyReferenceFile
        && evaluated.values.some(hasOutboxWrite)
        && [...evaluated.nodes].every((literal) => !consumed.has(literal))
      ) {
        addViolation("inert-composed-write", node);
      }
    }
    ts.forEachChild(node, inspectInert);
  };
  inspectInert(sourceFile);

  if (violations.length > 0) {
    fail(`${relativePath}:${[...new Set(violations)].sort().join(",")}`);
  }
  return candidates.map(
    ({ functionName, kind, node, receiver }) => ({
      functionName,
      kind,
      line:
        sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      path: relativePath,
      receiver,
    }),
  );
}

function classifyPath(relativePath) {
  if (EXCLUDED_PATH.test(relativePath) || TEST_PATH.test(relativePath)) {
    return "excluded";
  }
  const basename = path.posix.basename(relativePath);
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (
    TEXT_EXTENSIONS.has(extension)
    || TEXT_BASENAMES.has(basename)
    || TEXT_EXTENSIONLESS_PATHS.has(relativePath)
  ) {
    return AST_EXTENSIONS.has(extension) ? "ast" : "text";
  }
  if (BINARY_EXTENSIONS.has(extension)) return "binary";
  fail(`unknown-file-type:${relativePath}`);
}

function countDirectWrites(source) {
  const expression = new RegExp(OUTBOX_WRITE.source, "giu");
  return [...source.matchAll(expression)].length;
}

function inspectTextFile(relativePath, source) {
  const directCount = countDirectWrites(source);
  const compactWriter = hasCompactWrite(source);
  if (REVIEWED_SQL_WRITER_FILES.has(relativePath)) {
    const expected = REVIEWED_SQL_WRITER_FILES.get(relativePath);
    if (directCount !== expected || !compactWriter) {
      fail(
        `reviewed-sql-writer-count:${relativePath}:expected=${expected}:observed=${directCount}`,
      );
    }
    if (
      /\bexecute\s+(?:format\s*\(|['"$a-z_])/iu.test(source)
      && !/\bexecute\s+(?:function|procedure)\b/iu.test(source)
    ) {
      fail(`dynamic-reviewed-sql-writer:${relativePath}`);
    }
    return;
  }
  if (directCount > 0 || compactWriter) {
    fail(`prohibited-direct-text-writer:${relativePath}`);
  }
  if (hasRoutineCall(source)) {
    fail(`prohibited-text-routine-delegation:${relativePath}`);
  }
}

function inspectBinaryFile(relativePath, bytes) {
  const ascii = bytes.toString("latin1");
  if (
    hasCompactWrite(ascii)
    || hasRoutineTaint(ascii)
    || hasOutboxTaint(ascii)
  ) {
    fail(`prohibited-binary-writer-token:${relativePath}`);
  }
}

function expectedKey(writer) {
  return [
    writer.path,
    writer.kind,
    writer.receiver,
    writer.functionName,
  ].join("\0");
}

export function verifyWriterInventory({
  repositoryRoot,
  paths,
  limits = LIMITS,
} = {}) {
  const root = repositoryRoot === undefined
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    : path.resolve(repositoryRoot);
  const discovered = paths ?? listRepositoryPaths(root, { limits });
  if (discovered.length > limits.paths) fail("path-count-limit");
  const read = createBoundedByteReader(root, { limits });
  const observed = [];
  for (const relativePath of discovered) {
    validateRepositoryPath(relativePath);
    const classification = classifyPath(relativePath);
    if (classification === "excluded") continue;
    const bytes = read(relativePath);
    if (classification === "binary") {
      inspectBinaryFile(relativePath, bytes);
      continue;
    }
    const source = decodeUtf8(bytes, relativePath);
    if (classification === "ast") {
      observed.push(...analyzeAstSource(relativePath, source));
    } else {
      inspectTextFile(relativePath, source);
    }
  }

  const expectedCounts = new Map();
  for (const writer of EXPECTED_WRITERS) {
    const key = expectedKey(writer);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  const observedCounts = new Map();
  for (const writer of observed) {
    const key = expectedKey(writer);
    observedCounts.set(key, (observedCounts.get(key) ?? 0) + 1);
  }
  const keys = new Set([...expectedCounts.keys(), ...observedCounts.keys()]);
  const differences = [...keys]
    .filter((key) => expectedCounts.get(key) !== observedCounts.get(key))
    .sort()
    .map((key) => {
      const [writerPath, kind, receiver, functionName] = key.split("\0");
      return `${writerPath}:${kind}:${receiver}:${functionName}:expected=${expectedCounts.get(key) ?? 0}:observed=${observedCounts.get(key) ?? 0}`;
    });
  if (differences.length > 0) {
    fail(`manifest:${differences.join(",")}`);
  }
  return Object.freeze({
    catalogWriters: 1,
    delegatedEdges: observed.filter(
      ({ kind }) => kind === "delegated-routine-call",
    ).length,
    runtimeWriters: observed.filter(
      ({ kind }) => kind !== "delegated-routine-call",
    ).length,
  });
}

export function verifyRoutineCatalogModel({
  reviewed,
  routines,
  triggers = [],
}) {
  const userRoutines = routines.filter(({ extensionOwned }) => !extensionOwned);
  if (userRoutines.some(({ dynamic }) => dynamic)) {
    fail("catalog-model:dynamic-routine");
  }
  const direct = userRoutines.filter(({ directWrites }) => directWrites > 0);
  if (direct.length !== 1) fail("catalog-model:direct-writer-count");
  const bySignature = new Map(
    userRoutines.map((routine) => [routine.signature, routine]),
  );
  const reachesWriter = new Set(direct.map(({ signature }) => signature));
  let changed = true;
  while (changed) {
    changed = false;
    for (const routine of userRoutines) {
      if (
        !reachesWriter.has(routine.signature)
        && routine.calls.some(
          (signature) =>
            bySignature.has(signature) && reachesWriter.has(signature),
        )
      ) {
        reachesWriter.add(routine.signature);
        changed = true;
      }
    }
  }
  if (reachesWriter.size !== 1 || !reachesWriter.has(reviewed.signature)) {
    fail("catalog-model:writer-call-graph");
  }
  if (triggers.some(({ functionSignature }) =>
    reachesWriter.has(functionSignature)
  )) {
    fail("catalog-model:trigger-writer");
  }
  const writer = direct[0];
  if (
    writer.signature !== reviewed.signature
    || writer.kind !== "f"
    || writer.language !== "plpgsql"
    || writer.identityArguments !== reviewed.identityArguments
    || writer.bodySha256 !== reviewed.bodySha256
    || writer.definitionSha256 !== reviewed.definitionSha256
    || writer.directWrites !== 1
    || writer.calls.some((signature) => bySignature.has(signature))
  ) {
    fail("catalog-model:reviewed-writer-contract");
  }
  return Object.freeze({
    directWriters: 1,
    reachableWriters: 1,
    triggerWriters: 0,
  });
}

function isMain() {
  return (
    process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

if (isMain()) {
  const result = verifyWriterInventory({});
  process.stdout.write(
    `email_outbox_writer_inventory=runtime:${result.runtimeWriters}:catalog:${result.catalogWriters}:delegated:${result.delegatedEdges}:pass\n`,
  );
}
