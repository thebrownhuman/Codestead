import path from "node:path";
import ts from "typescript";

/** Shared resolver for architecture and production dependency checks. */
export function createImportResolver(root: string) {
  const sourceRoot = path.join(root, "src");
  const normalized = (file: string) => path.relative(root, file).replaceAll("\\", "/");
  const resolutionOptions: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: root,
    paths: { "@/*": ["src/*"] },
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
  };
  const resolutionCache = ts.createModuleResolutionCache(root, (file) => file, resolutionOptions);

  return function resolveImport(file: string, specifier: string): string {
    const resolved = ts.resolveModuleName(specifier, path.join(root, file), resolutionOptions, ts.sys, resolutionCache).resolvedModule;
    if (resolved && !resolved.isExternalLibraryImport) return normalized(ts.sys.realpath?.(resolved.resolvedFileName) ?? resolved.resolvedFileName);
    if (specifier.startsWith("@/")) return normalized(path.join(sourceRoot, specifier.slice(2)));
    if (specifier.startsWith("./") || specifier.startsWith("../")) return normalized(path.resolve(root, path.dirname(file), specifier));
    return specifier;
  };
}

export function runtimeImports(source: ts.SourceFile): Set<string> {
  const imports = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (clause && !clause.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly));
      if (!onlyTypes) imports.add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const onlyTypes = node.isTypeOnly || (clause && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly));
      if (!onlyTypes) imports.add(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      imports.add(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) imports.add(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

