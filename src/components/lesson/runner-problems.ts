export type RunnerProblem = { file: string; line: number; column: number; message: string };

// Interpret recognizable diagnostics only. The raw log remains authoritative.
export function parseRunnerProblems(stderr: string): RunnerProblem[] {
  const lines = stderr.split(/\r?\n/);
  const problems: RunnerProblem[] = [];
  const exception = [...lines].reverse().find(line => /^[\w.]+(?:Error|Exception):/.test(line.trim()))?.trim();
  for (const text of lines) {
    let match = text.match(/^(.+):([0-9]+):([0-9]+):\s*(?:fatal )?error:\s*(.+)$/);
    let problem: RunnerProblem | undefined;
    if (match) problem = { file: match[1], line: Number(match[2]), column: Number(match[3]), message: match[4] };
    else if ((match = text.match(/^(.+\.java):([0-9]+):\s*error:\s*(.+)$/))) {
      problem = { file: match[1], line: Number(match[2]), column: 1, message: match[3] };
    } else if ((match = text.match(/^\s*File "([^"]+)", line ([0-9]+)(?:,.*)?$/))) {
      problem = { file: match[1], line: Number(match[2]), column: 1, message: exception ?? "Python traceback" };
    } else if ((match = text.match(/(?:^|\(|\s)((?:[A-Za-z]:)?[^\s()]+\.(?:[cm]?js|tsx?)):([0-9]+)(?::([0-9]+))?(?:\)?$)/))) {
      problem = { file: match[1], line: Number(match[2]), column: Number(match[3] ?? 1), message: exception ?? text.trim() };
    }
    if (problem && Number.isSafeInteger(problem.line) && problem.line > 0 && Number.isSafeInteger(problem.column) && problem.column > 0) problems.push(problem);
    if (problems.length === 200) break;
  }
  return problems;
}
