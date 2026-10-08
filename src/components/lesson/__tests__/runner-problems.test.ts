import { describe, expect, it } from "vitest";
import { parseRunnerProblems } from "../runner-problems";

describe("runner diagnostics", () => {
  it("bounds diagnostic rows while retaining the raw log separately", () => {
    const output = "main.c:4:8: error: missing semicolon\n".repeat(10_000);
    expect(parseRunnerProblems(output)).toHaveLength(200);
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
    expect(parseRunnerProblems(output as string)).toEqual([{ file, line, column, message }]);
  });
  it.each(["", "unknown output", "timeout", "stdout: hello", "main.c:0:2: error: bad", "file:12"])("leaves unknown output in Output: %s", output => {
    expect(parseRunnerProblems(output)).toEqual([]);
  });
});
