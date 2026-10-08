import { expect, it, vi } from "vitest";
import { reviewPublicRepository } from "../reviewer";

async function executionFindings(path: string, source: string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/repos/octo/repo")) return Response.json({ private: false, default_branch: "main" });
    if (url.includes("/commits/")) return Response.json({ sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } });
    if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [{ path, type: "blob", size: Buffer.byteLength(source), sha: "c".repeat(40) }] });
    return Response.json({ content: Buffer.from(source).toString("base64"), encoding: "base64", size: Buffer.byteLength(source) });
  });
  const result = await reviewPublicRepository("https://github.com/octo/repo", fetchMock as typeof fetch);
  return result.findings.filter((finding) => finding.ruleId === "security.dynamic-code-evaluation");
}

it.each([
  ["regex.exec", "main.ts", 'const regex = /word/; regex.exec(input);'],
  ["RegExp prototype", "main.js", 'RegExp.prototype.exec.call(regex, input);'],
  ["database exec", "main.ts", 'db.exec("SELECT 1");'],
  ["comment", "main.ts", '// exec(input) is mentioned in documentation'],
  ["string", "main.ts", 'const example = "exec(";'],
  ["template literal", "main.ts", 'const example = `eval(input); exec(input)`;'],
  ["escaped quote", "main.ts", 'const example = "quote \\" eval(input)";'],
  ["escaped template", "main.ts", 'const example = `escaped \\` eval(input)`;'],
  ["regex literal", "main.ts", 'const example = /eval(input)/;'],
  ["block comment", "main.ts", '/* require("child_process").exec(input); eval(input); */'],
  ["fake import in string", "main.ts", 'const example = "import { exec } from child_process"; exec(input);'],
  ["JSX text", "main.tsx", 'const example = <p>exec(input)</p>;'],
  ["shadowed require", "main.js", 'function example(require) { const cp = require("child_process"); cp.exec(input); }'],
  ["Python comment", "main.py", '# os.system(input)'],
  ["Python string", "main.py", 'example = "os.system(input)"'],
  ["shadowed eval", "main.ts", 'function example(eval: (s: string) => void) { eval(input); }'],
  ["shadowed import", "main.ts", 'import { exec } from "child_process"; function example(exec: Function) { exec(input); }'],
  ["spawn without shell", "main.ts", 'import { spawn } from "child_process"; spawn(input, []);'],
  ["disabled shell", "main.ts", 'import { spawn } from "child_process"; spawn(input, [], { shell: false });'],
  ["overridden shell", "main.ts", 'import { spawn } from "child_process"; spawn(input, [], { shell: true, ...{ shell: false } });'],
  ["cyclic options", "main.ts", 'import { spawn } from "child_process"; const options = { ...options }; spawn(input, [], options);'],
  ["Python docstring", "main.py", '"""subprocess.run(input, shell=True)"""'],
  ["Python no shell", "main.py", 'subprocess.run(input, shell=False)'],
  ["nested Python shell", "main.py", 'subprocess.run(other(input, shell=True))'],
  ["Java comment", "Main.java", '/* Runtime.getRuntime().exec(input); */'],
  ["Java string", "Main.java", 'String example = "Runtime.getRuntime().exec(input)";'],
])("does not flag harmless %s", async (_name, path, source) => {
  expect(await executionFindings(path, source)).toHaveLength(0);
});

it.each([
  ["eval", "main.ts", 'eval(input);'],
  ["Function", "main.js", 'new Function(input);'],
  ["child_process exec", "main.js", 'const cp = require("node:child_process"); cp.exec(input);'],
  ["direct require exec", "main.js", 'require("node:child_process").exec(input);'],
  ["member alias", "main.js", 'const cp = require("child_process"); const run = cp.execSync; run(input);'],
  ["aliased execSync", "main.ts", 'import { execSync as run } from "child_process"; run(input);'],
  ["shell spawn", "main.ts", 'import { spawn } from "node:child_process"; spawn(input, [], { shell: true });'],
  ["Python system", "main.py", 'os.system(input)'],
  ["Python shell", "main.py", 'subprocess.run(input, shell=True)'],
  ["Java runtime", "Main.java", 'Runtime.getRuntime().exec(input);'],
  ["destructured exec", "main.cjs", 'const { exec: run } = require("child_process"); run(input);'],
  ["namespace exec", "main.mts", 'import * as cp from "node:child_process"; cp.exec(input);'],
  ["dynamic import", "main.ts", 'const cp = await import("child_process"); cp.exec(input);'],
  ["template interpolation", "main.ts", 'const example = `${eval(input)}`;'],
  ["JSX expression", "main.tsx", 'const example = <p>{eval(input)}</p>;'],
  ["global Function", "main.ts", 'new globalThis.Function(input);'],
  ["shell spawnSync", "main.ts", 'import { spawnSync } from "child_process"; spawnSync(input, { shell: true });'],
  ["constant shell options", "main.ts", 'import { spawn } from "child_process"; const shell = true; const options = { shell }; spawn(input, [], options);'],
  ["unrelated spread", "main.ts", 'import { spawn } from "child_process"; spawn(input, [], { shell: true, ...{ cwd: "/tmp" } });'],
  ["Python multiline shell", "main.py", 'subprocess.run(\n input,\n shell=True\n)'],
  ["Java multiline runtime", "Main.java", 'Runtime.getRuntime()\n .exec(input);'],
])("flags real %s", async (_name, path, source) => {
  expect(await executionFindings(path, source)).toHaveLength(1);
});

it.each([
  ["main.ts", '// eval(input)\nconst example = "exec(input)";\neval(\n input\n);'],
  ["main.py", '# os.system(input)\nexample = "exec(input)"\nos.system(\n input\n)'],
  ["Main.java", '// Runtime.getRuntime().exec(input)\nString example = "exec(input)";\nRuntime.getRuntime()\n .exec(input);'],
])("preserves finding line numbers for %s", async (path, source) => {
  const findings = await executionFindings(path, source);
  expect(findings).toHaveLength(1);
  expect(findings[0].line).toBe(3);
});
