// Dependency-free lexical review: repository code is never loaded or executed.
type Token = { text: string; offset: number; literal?: string };
type Target = "process" | "exec" | "spawn" | "eval" | "global";
type Binding = { start?: number; end?: number; scope: Scope; member?: string; kind?: Target };
type Scope = { parent?: Scope; bindings: Map<string, Binding> };
const memberTarget = (name: string): Target | undefined =>
  /^(exec|execSync)$/.test(name) ? "exec" : /^(spawn|spawnSync)$/.test(name) ? "spawn" : undefined;

/** Strip comments/literal bodies; retain literal metadata only for import/options matching. */
function scan(text: string): Token[] {
  const tokens: Token[] = [];
  const emit = (value: string, offset: number, literal?: string) => tokens.push({ text: value, offset, literal });
  function template(start: number): number {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === "`") return i + 1;
      if (text.startsWith("${", i)) {
        emit("(", i);
        i = code(i + 2, true);
        emit(")", i - 1);
      } else i++;
    }
    return i;
  }
  function code(start: number, interpolation = false): number {
    let i = start, depth = 0;
    while (i < text.length) {
      const offset = i, ch = text[i];
      if (interpolation && ch === "}" && depth === 0) return i + 1;
      if (/\s/.test(ch)) { i++; continue; }
      if (text.startsWith("//", i) || text.startsWith("#!", i)) {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (text.startsWith("/*", i)) { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
      if (ch === "`") { i = template(i); continue; }
      if (ch === '"' || ch === "'") {
        let value = "";
        i++;
        while (i < text.length && text[i] !== ch) {
          if (text[i] === "\\") { i++; if (i < text.length) value += text[i++]; }
          else value += text[i++];
        }
        i++;
        emit("literal", offset, value);
        continue;
      }
      // A regex literal can itself contain text resembling a function call.
      if (ch === "/" && (!tokens.length || /^(=|\(|\[|,|:|return|=>|!|\?|;)$/.test(tokens.at(-1)!.text))) {
        let inClass = false;
        i++;
        while (i < text.length) {
          if (text[i] === "\\") { i += 2; continue; }
          if (text[i] === "[") inClass = true;
          if (text[i] === "]") inClass = false;
          if (text[i++] === "/" && !inClass) break;
        }
        while (i < text.length && /[a-z]/i.test(text[i])) i++;
        emit("literal", offset, "");
        continue;
      }
      const word = /^[\w$]+/.exec(text.slice(i));
      const value = word?.[0] ?? (text.startsWith("...", i) ? "..." : text.startsWith("=>", i) ? "=>" : ch);
      emit(value, offset);
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      i += value.length;
    }
    return i;
  }
  code(0);
  return tokens;
}

function javascriptExecutionLines(text: string): number[] {
  const tokens = scan(text), pairs = new Map<number, number>(), scopes: Scope[] = [];
  const root: Scope = { bindings: new Map() };
  let scope = root;
  const stack: number[] = [];
  tokens.forEach((token, i) => {
    scopes[i] = scope;
    if ("([{".includes(token.text) && token.text.length === 1) {
      stack.push(i);
      if (token.text === "{") scope = { parent: scope, bindings: new Map() };
    } else if (")]}".includes(token.text) && token.text.length === 1) {
      const opening = stack.pop();
      if (opening !== undefined) { pairs.set(opening, i); pairs.set(i, opening); }
      if (token.text === "}") scope = scope.parent ?? root;
    }
  });
  const name = (i: number) => tokens[i]?.text ?? "";
  const lookup = (value: string, environment: Scope): Binding | undefined => {
    for (let current: Scope | undefined = environment; current; current = current.parent) {
      if (current.bindings.has(value)) return current.bindings.get(value);
    }
  };
  const ranges = (start: number, end: number): [number, number][] => {
    const result: [number, number][] = [];
    let first = start;
    for (let i = start; i < end; i++) {
      if (name(i) === ",") { result.push([first, i]); first = i + 1; }
      else if ((pairs.get(i) ?? i) > i) i = pairs.get(i)!;
    }
    if (first < end) result.push([first, end]);
    return result;
  };
  const expressionEnd = (start: number) => {
    let i = start;
    for (; i < tokens.length && !/^[;,}]$/.test(name(i)); i++) if ((pairs.get(i) ?? i) > i) i = pairs.get(i)!;
    return i;
  };
  const moduleAt = (i: number) => /^(?:node:)?child_process$/.test(tokens[i]?.literal ?? "");
  // Collect declarations first so parameters/local bindings shadow imported names.
  tokens.forEach((token, i) => {
    const environment = scopes[i];
    if (token.text === "import" && name(i + 1) !== "(") {
      let end = i + 1;
      while (end < tokens.length && name(end) !== ";" && name(end) !== "from") end++;
      if (name(end) === "from" && moduleAt(end + 1)) {
        if (name(i + 1) === "{") {
          for (const [a] of ranges(i + 2, pairs.get(i + 1) ?? end)) {
            const local = name(a + 1) === "as" ? name(a + 2) : name(a);
            environment.bindings.set(local, { scope: environment, kind: memberTarget(name(a)) });
          }
        } else {
          const local = name(i + 1) === "*" ? name(i + 3) : name(i + 1);
          environment.bindings.set(local, { scope: environment, kind: "process" });
        }
      }
    }
    if (/^(const|let|var)$/.test(token.text)) {
      const opening = name(i + 1) === "{" ? pairs.get(i + 1) : undefined;
      const equals = opening === undefined ? i + 2 : opening + 1;
      if (name(equals) !== "=") return;
      const binding: Binding = { scope: environment, start: equals + 1, end: expressionEnd(equals + 1) };
      if (opening !== undefined) {
        for (const [a] of ranges(i + 2, opening)) {
          environment.bindings.set(name(a + 1) === ":" ? name(a + 2) : name(a), { ...binding, member: name(a) });
        }
      } else environment.bindings.set(name(i + 1), binding);
    }
    if (token.text === "function") {
      let opening = i + 1;
      if (name(opening) !== "(") {
        environment.bindings.set(name(opening), { scope: environment });
        opening++;
      }
      const closing = pairs.get(opening);
      if (closing === undefined || name(closing + 1) !== "{") return;
      const body = scopes[closing + 2];
      for (const [a] of ranges(opening + 1, closing)) body?.bindings.set(name(a), { scope: body });
    }
  });
  function target(start: number, end: number, environment: Scope, seen = new Set<Binding>()): Target | undefined {
    if (name(start) === "await") start++;
    if (name(start) === "(" && pairs.get(start) === end - 1) return target(start + 1, end - 1, environment, seen);
    let result: Target | undefined, next = start + 1;
    if (/^(require|import)$/.test(name(start)) && name(next) === "(" && moduleAt(next + 1)
      && (name(start) === "import" || !lookup("require", environment))) {
      result = "process"; next = (pairs.get(next) ?? next) + 1;
    } else {
      const binding = lookup(name(start), environment);
      if (binding) {
        if (seen.has(binding)) return;
        seen.add(binding);
        result = binding.kind ?? (binding.start === undefined ? undefined : target(binding.start, binding.end!, binding.scope, seen));
        if (binding.member) result = result === "process" ? memberTarget(binding.member) : undefined;
      } else if (/^(eval|Function)$/.test(name(start))) result = "eval";
      else if (/^(globalThis|global|window)$/.test(name(start))) result = "global";
    }
    while (next < end) {
      let member: string;
      if (name(next) === ".") { member = name(next + 1); next += 2; }
      else if (name(next) === "[" && tokens[next + 1]?.literal !== undefined) { member = tokens[next + 1].literal!; next = (pairs.get(next) ?? next) + 1; }
      else return undefined;
      result = result === "process" ? memberTarget(member)
        : result === "global" && /^(eval|Function)$/.test(member) ? "eval"
          : /^(call|apply)$/.test(member) && (result === "exec" || result === "eval") ? result : undefined;
    }
    return result;
  }
  function shell(start: number, end: number, environment: Scope, seen = new Set<Binding>()): boolean | undefined {
    const binding = lookup(name(start), environment);
    if (binding && end === start + 1) {
      if (seen.has(binding) || binding.start === undefined) return;
      seen.add(binding);
      return shell(binding.start, binding.end!, binding.scope, seen);
    }
    if (name(start) === "true") return true;
    if (name(start) === "false") return false;
    if (tokens[start]?.literal !== undefined) return Boolean(tokens[start].literal);
    if (name(start) !== "{") return;
    let enabled: boolean | undefined;
    for (const [a, b] of ranges(start + 1, pairs.get(start) ?? end)) {
      if (name(a) === "...") {
        const spread = shell(a + 1, b, environment, new Set(seen));
        if (spread !== undefined) enabled = spread;
      } else if (name(a) === "shell" || tokens[a]?.literal === "shell") {
        enabled = shell(name(a + 1) === ":" ? a + 2 : a, b, environment, new Set(seen));
      }
    }
    return enabled;
  }
  function calleeStart(end: number): number {
    let start = end;
    if (name(start) === ")" || name(start) === "]") start = (pairs.get(start) ?? start) - 1;
    while (name(start - 1) === ".") start = calleeStart(start - 2);
    return Math.max(0, start);
  }
  const lines = new Set<number>();
  tokens.forEach((token, i) => {
    if (token.text !== "(" || i === 0) return;
    const start = calleeStart(i - 1), kind = target(start, i, scopes[i]);
    if (kind === "exec" || kind === "eval" || (kind === "spawn"
      && ranges(i + 1, pairs.get(i) ?? i).slice(1).some(([a, b]) => shell(a, b, scopes[i]) === true))) {
      lines.add(text.slice(0, tokens[start].offset).split("\n").length);
    }
  });
  return [...lines].sort((a, b) => a - b);
}

function maskNonCode(text: string, python: boolean): string {
  return text.replace(python
    ? /#[^\r\n]*|"""(?:\\[\s\S]|(?!""")[\s\S])*"""|'''(?:\\[\s\S]|(?!''')[\s\S])*'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g
    : /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"""[\s\S]*?"""|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
  (literal) => literal.replace(/[^\r\n]/g, " "));
}

export function dynamicExecutionLines(pathname: string, text: string): number[] {
  const extension = pathname.slice(pathname.lastIndexOf(".")).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"].includes(extension)) return javascriptExecutionLines(text);
  if (extension !== ".py" && extension !== ".java") return [];
  const code = maskNonCode(text, extension === ".py"), lines = new Set<number>();
  const add = (offset: number) => lines.add(code.slice(0, offset).split("\n").length);
  if (extension === ".java") {
    for (const match of code.matchAll(/\b(?:java\s*\.\s*lang\s*\.\s*)?Runtime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\s*\(/g)) add(match.index);
  } else {
    for (const match of code.matchAll(/\bos\s*\.\s*system\s*\(|\b(?:eval|exec)\s*\(/g)) {
      if (!code.slice(0, match.index).trimEnd().endsWith(".")) add(match.index);
    }
    for (const match of code.matchAll(/\bsubprocess\s*(?:\.\s*(?:run|call|Popen|check_call|check_output))?\s*\(/g)) {
      let depth = 0, start = match.index + match[0].length;
      for (let i = start; i < code.length; i++) {
        if ((code[i] === "," || code[i] === ")") && depth === 0) {
          if (/^\s*shell\s*=\s*True\s*$/.test(code.slice(start, i))) { add(match.index); break; }
          if (code[i] === ")") break;
          start = i + 1;
        } else if ("([{".includes(code[i])) depth++;
        else if (")]}".includes(code[i])) depth--;
      }
    }
  }
  return [...lines].sort((a, b) => a - b);
}
