export type RunnerProblem = { file: string; line: number; column: number; message: string };

// Matches the runner entrypoints without importing server-only code.
export const RUNNER_SUBMISSION_FILES = {
  c: "main.c", cpp: "main.cpp", java: "Main.java", python: "main.py", javascript: "main.js",
} as const;

function basename(file: string) {
  return file.replaceAll("\\", "/").split("/").at(-1);
}

// Interpret learner locations only. The raw log remains authoritative.
export function parseRunnerProblems(stderr: string, submittedFile: string): RunnerProblem[] {
  const lines = stderr.slice(0, 262_144).split(/\r?\n/);
  const problems: RunnerProblem[] = [];
  const seen = new Set<string>();
  const exception = [...lines].reverse().find(line => /^[A-Za-z_][\w.]*(?::.*)?$/.test(line.trim()) && !/^\s/.test(line))?.trim();
  let pythonFrame: RunnerProblem | undefined;
  function learnerLocation(file: string) {
    const normalized = file.replaceAll("\\", "/");
    return basename(file) === basename(submittedFile)
      && !/(?:^|\/)(?:piston|site-packages)(?:\/|$)|(?:^|\/)usr\/lib(?:\/|$)|node:internal/.test(normalized);
  }
  function add(problem: RunnerProblem) {
    if (!learnerLocation(problem.file) || !Number.isSafeInteger(problem.line) || problem.line < 1
      || !Number.isSafeInteger(problem.column) || problem.column < 1) return;
    const normalized = { ...problem, file: basename(submittedFile)! };
    const key = JSON.stringify([normalized.file, normalized.line, normalized.column, normalized.message]);
    if (!seen.has(key) && problems.length < 200) { seen.add(key); problems.push(normalized); }
  }
  for (const text of lines) {
    let match = text.match(/^(.+):([0-9]+):([0-9]+):\s*(?:fatal )?error:\s*(.+)$/);
    if (match) add({ file: match[1], line: Number(match[2]), column: Number(match[3]), message: match[4] });
    else if ((match = text.match(/^(.+\.java):([0-9]+):\s*error:\s*(.+)$/))) {
      add({ file: match[1], line: Number(match[2]), column: 1, message: match[3] });
    } else if ((match = text.match(/^\s*File "([^"]+)", line ([0-9]+)(?:,.*)?$/))) {
      if (learnerLocation(match[1]) && Number.isSafeInteger(Number(match[2])) && Number(match[2]) > 0) {
        pythonFrame = { file: match[1], line: Number(match[2]), column: 1, message: exception ?? "Python traceback" };
      }
    } else if ((match = text.match(/(?:^|\(|\s)((?:[A-Za-z]:)?[^\s()]+\.(?:[cm]?js|tsx?)):([0-9]+)(?::([0-9]+))?(?:\)?$)/))) {
      add({ file: match[1], line: Number(match[2]), column: Number(match[3] ?? 1), message: exception ?? text.trim() });
    }
  }
  if (pythonFrame) add(pythonFrame);
  return problems;
}
