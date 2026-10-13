import { describe, expect, it } from "vitest";
import { parseRunnerProblems } from "../runner-problems";

describe("runner diagnostics", () => {
  it("bounds diagnostic rows while retaining the raw log separately", () => {
    const output = Array.from({ length: 10_000 }, (_, index) => `main.c:${index + 1}:8: error: missing semicolon\n`).join("");
    expect(parseRunnerProblems(output, "main.c")).toHaveLength(200);
    expect(output.length).toBeGreaterThan(262_144);
  });
  it.each([
    ["main.c:4:8: error: missing semicolon", "main.c", 4, 8, "missing semicolon"],
    ["main.cpp:9:2: error: unknown name", "main.cpp", 9, 2, "unknown name"],
    ["Main.java:7: error: cannot find symbol", "Main.java", 7, 1, "cannot find symbol"],
    ['Traceback (most recent call last):\n  File "main.py", line 3, in <module>\n    fail()\nValueError: bad value', "main.py", 3, 1, "ValueError: bad value"],
    ["TypeError: bad value\n    at run (/app/main.js:6:12)", "/app/main.js", 6, 12, "TypeError: bad value"],
    ["/app/main.js:6\nReferenceError: missing", "/app/main.js", 6, 1, "ReferenceError: missing"],
  ])("parses %s", (output, file, line, column, message) => {
    const submittedFile = String(file).split("/").at(-1)!;
    expect(parseRunnerProblems(output as string, submittedFile)).toEqual([{ file: submittedFile, line, column, message }]);
  });
  it.each(["", "unknown output", "timeout", "stdout: hello", "main.c:0:2: error: bad", "file:12"])("leaves unknown output in Output: %s", output => {
    expect(parseRunnerProblems(output, "main.c")).toEqual([]);
  });

  it.each([
    ["other.c:4:8: error: library failure", "main.c"],
    ["Helper.java:7: error: library failure", "Main.java"],
    ['File "helper.py", line 7\nValueError: library failure', "main.py"],
    ["TypeError: failure\n at run (/app/helper.js:4:8)", "main.js"],
  ])("rejects a different file basename: %s", (output, submittedFile) => {
    expect(parseRunnerProblems(output, submittedFile)).toEqual([]);
  });

  it.each([
    "/piston/packages/node/main.js", "node:internal/main.js", "/usr/lib/node/main.js",
    "/app/site-packages/main.js", "C:\\runtime\\site-packages\\main.js",
  ])("drops runtime frames even when their basename matches: %s", file => {
    expect(parseRunnerProblems(`TypeError: runtime failure\n    at run (${file}:4:8)`, "main.js")).toEqual([]);
  });

  it("uses the last learner Python frame and exception, dropping library and Piston frames", () => {
    const output = [
      "Traceback (most recent call last):",
      '  File "/piston/runner.py", line 40, in run',
      '  File "/box/main.py", line 2, in <module>',
      '  File "/box/main.py", line 8, in run',
      '  File "/box/site-packages/main.py", line 99, in library',
      '  File "/usr/lib/python/main.py", line 100, in library',
      "ValueError: bad learner input",
    ].join("\n");
    expect(parseRunnerProblems(output, "main.py")).toEqual([
      { file: "main.py", line: 8, column: 1, message: "ValueError: bad learner input" },
    ]);
  });

  it("preserves Python exception classes without Error/Exception suffixes", () => {
    expect(parseRunnerProblems('  File "main.py", line 3\nStopIteration: exhausted', "main.py")).toEqual([
      { file: "main.py", line: 3, column: 1, message: "StopIteration: exhausted" },
    ]);
  });

  it("deduplicates file, line, column and message while keeping distinct diagnostics", () => {
    const output = [
      "main.c:4:8: error: failure", "/box/main.c:4:8: error: failure",
      "main.c:4:9: error: failure", "main.c:4:8: error: different",
    ].join("\n");
    expect(parseRunnerProblems(output, "main.c")).toEqual([
      { file: "main.c", line: 4, column: 8, message: "failure" },
      { file: "main.c", line: 4, column: 9, message: "failure" },
      { file: "main.c", line: 4, column: 8, message: "different" },
    ]);
    expect(parseRunnerProblems("main.c:4:8: error: failure\n".repeat(10_000), "main.c")).toHaveLength(1);
  });

  it("supports Windows learner locations and rejects invalid positions", () => {
    expect(parseRunnerProblems("C:\\box\\main.c:4:8: error: failure", "main.c")).toEqual([
      { file: "main.c", line: 4, column: 8, message: "failure" },
    ]);
    expect(parseRunnerProblems("main.c:4:0: error: failure\nmain.c:9999999999999999999:1: error: failure", "main.c")).toEqual([]);
  });
});
