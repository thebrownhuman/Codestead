import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export type ApiBoundary = "public" | "auth-handler" | "authenticated" | "admin";

export type ApiSurfaceEntry = Readonly<{
  file: string;
  route: string;
  methods: readonly string[];
  boundary: ApiBoundary;
  sourceSha256: string;
}>;

const PUBLIC_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  "src/app/api/access-requests/route.ts": ["POST"],
  "src/app/api/invitations/activate/route.ts": ["POST"],
  "src/app/api/invitations/validate/route.ts": ["GET"],
  "src/app/api/lost-device/request/route.ts": ["POST"],
  "src/app/api/lost-device/verify/route.ts": ["POST"],
};
const AUTH_HANDLER = "src/app/api/auth/[...all]/route.ts";
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function posixPath(value: string) {
  return value.replaceAll(path.sep, "/");
}

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(absolute);
    return entry.isFile() && entry.name === "route.ts" ? [absolute] : [];
  }));
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

export function extractExportedHttpOperations(source: string, file: string) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods = new Map<string, string>();
  for (const statement of parsed.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name && HTTP_METHODS.has(statement.name.text)) {
      methods.set(statement.name.text, statement.getText(parsed));
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isObjectBindingPattern(declaration.name)) continue;
      for (const element of declaration.name.elements) {
        if (ts.isIdentifier(element.name) && HTTP_METHODS.has(element.name.text)) {
          methods.set(element.name.text, statement.getText(parsed));
        }
      }
    }
  }
  return methods;
}

function boundaryFor(file: string): ApiBoundary {
  if (file === AUTH_HANDLER) return "auth-handler";
  if (PUBLIC_OPERATIONS[file]) return "public";
  if (file.startsWith("src/app/api/admin/")) return "admin";
  return "authenticated";
}

function routeFor(file: string) {
  return `/${file.slice("src/app/".length, -"/route.ts".length)}`;
}

function equalStringSets(left: readonly string[], right: readonly string[]) {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

export async function auditApiSurface(root: string) {
  const absoluteApiRoot = path.join(root, "src", "app", "api");
  const files = await routeFiles(absoluteApiRoot);
  const entries: ApiSurfaceEntry[] = [];
  const errors: string[] = [];

  for (const absolute of files) {
    const file = posixPath(path.relative(root, absolute));
    const source = await readFile(absolute, "utf8");
    const methods = extractExportedHttpOperations(source, file);
    const boundary = boundaryFor(file);
    const names = [...methods.keys()].sort();
    if (names.length === 0) errors.push(`${file}: no exported HTTP operation was found.`);

    if (boundary === "public") {
      const expected = PUBLIC_OPERATIONS[file] ?? [];
      if (!equalStringSets(names, expected)) {
        errors.push(`${file}: public methods changed from the reviewed allowlist (${expected.join(", ")}).`);
      }
      for (const [method, body] of methods) {
        if (!body.includes("withRateLimit")) errors.push(`${file}#${method}: public operation is not rate limited.`);
      }
    } else if (boundary === "auth-handler") {
      if (!equalStringSets(names, ["GET", "POST"]) || !source.includes("toNextJsHandler(auth)")) {
        errors.push(`${file}: Better Auth handler export changed from the reviewed GET/POST adapter.`);
      }
    } else {
      const requiredCall = boundary === "admin" ? "requireAdmin(" : "requireAuth(";
      for (const [method, body] of methods) {
        if (!body.includes(requiredCall)) {
          errors.push(`${file}#${method}: expected direct ${requiredCall.slice(0, -1)} authorization.`);
        }
      }
    }

    entries.push({
      file,
      route: routeFor(file),
      methods: names,
      boundary,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
    });
  }

  for (const publicFile of Object.keys(PUBLIC_OPERATIONS)) {
    if (!entries.some((entry) => entry.file === publicFile)) {
      errors.push(`${publicFile}: reviewed public operation is missing.`);
    }
  }
  if (!entries.some((entry) => entry.file === AUTH_HANDLER)) {
    errors.push(`${AUTH_HANDLER}: Better Auth handler is missing.`);
  }

  const operationCount = entries.reduce((sum, entry) => sum + entry.methods.length, 0);
  const boundaryCounts = entries.reduce<Record<ApiBoundary, number>>(
    (counts, entry) => ({ ...counts, [entry.boundary]: counts[entry.boundary] + entry.methods.length }),
    { public: 0, "auth-handler": 0, authenticated: 0, admin: 0 },
  );
  return {
    schemaVersion: 1,
    files: entries.length,
    operations: operationCount,
    boundaryCounts,
    errors,
    entries,
  } as const;
}
