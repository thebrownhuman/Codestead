import { describe, expect, it } from "vitest";
import {
  classifyProcess,
  normalizeOutput,
  normalizeTestResult,
  sanitizeOutput,
} from "../normalize.js";
import { NATIVE_RUNTIME_VERSIONS } from "../config.js";
import type { Language, RunnerTestCase } from "../types.js";
import { validateJobRequest } from "../validation.js";
import {
  jobRequest,
  processResult,
  testConfig,
} from "./fixtures.js";

describe("strict job validation", () => {
  it.each<Language>(["c", "cpp", "java", "python", "javascript"])(
    "accepts the allowlisted %s runtime",
    (language) => {
      const validated = validateJobRequest(
        jobRequest(language),
        testConfig(),
      );
      expect(validated.runtime.language).toBe(language);
      expect(validated.limits).toEqual(testConfig().defaults);
    },
  );

  it.each([
    {
      language: "c" as const,
      authoredVersion: "C23 / GCC 14.2.0",
      wrongVersions: ["C23 / GCC 14", "C23 / GCC 14.2.1"],
    },
    {
      language: "cpp" as const,
      authoredVersion: "C++20 / G++ 14.2.0",
      wrongVersions: ["C++20 / GCC 14", "C++20 / G++ 14.3.0"],
    },
  ])(
    "accepts exact authored $language exam metadata and rejects version drift",
    ({ language, authoredVersion, wrongVersions }) => {
      expect(NATIVE_RUNTIME_VERSIONS[language]).toBe(authoredVersion);
      expect(() =>
        validateJobRequest(
          jobRequest(language, { runtimeVersion: authoredVersion }),
          testConfig(),
        ),
      ).not.toThrow();
      for (const runtimeVersion of wrongVersions) {
        expect(() =>
          validateJobRequest(
            jobRequest(language, { runtimeVersion }),
            testConfig(),
          ),
        ).toThrow(/configured version/);
      }
    },
  );

  it("rejects languages outside the allowlist", () => {
    expect(() =>
      validateJobRequest(
        { ...jobRequest(), language: "ruby" },
        testConfig(),
      ),
    ).toThrow(/language must be one of/);
  });

  it("rejects runtime drift, unknown fields, and extension mismatch", () => {
    expect(() =>
      validateJobRequest(
        { ...jobRequest(), runtimeVersion: "latest" },
        testConfig(),
      ),
    ).toThrow(/configured version/);
    expect(() =>
      validateJobRequest(
        { ...jobRequest(), arbitraryCommand: "rm" },
        testConfig(),
      ),
    ).toThrow(/unknown field/);
    expect(() =>
      validateJobRequest(
        {
          ...jobRequest(),
          sourceFiles: [{ path: "main.sh", content: "no" }],
          entrypoint: "main.sh",
        },
        testConfig(),
      ),
    ).toThrow(/extension/);
  });

  it.each(["../main.py", "/main.py", "folder/../main.py", "a\\main.py"])(
    "rejects unsafe source path %s",
    (unsafePath) => {
      expect(() =>
        validateJobRequest(
          {
            ...jobRequest(),
            sourceFiles: [{ path: unsafePath, content: "x" }],
            entrypoint: unsafePath,
          },
          testConfig(),
        ),
      ).toThrow(/safe relative path/);
    },
  );

  it("rejects duplicate files and an absent entrypoint", () => {
    expect(() =>
      validateJobRequest(
        {
          ...jobRequest(),
          sourceFiles: [
            { path: "main.py", content: "a" },
            { path: "main.py", content: "b" },
          ],
        },
        testConfig(),
      ),
    ).toThrow(/duplicate source/);
    expect(() =>
      validateJobRequest(
        { ...jobRequest(), entrypoint: "other.py" },
        testConfig(),
      ),
    ).toThrow(/submitted source/);
  });

  it("enforces combined source and requested resource maxima", () => {
    const config = testConfig({ maxSourceBytes: 4 });
    expect(() =>
      validateJobRequest(
        {
          ...jobRequest(),
          sourceFiles: [{ path: "main.py", content: "12345" }],
        },
        config,
      ),
    ).toThrow(/exceeds 4 bytes/);
    expect(() =>
      validateJobRequest(
        { ...jobRequest(), limits: { memoryMb: 513 } },
        testConfig(),
      ),
    ).toThrow(/no greater than 512/);
  });

  it("enforces compile, run, and test request shapes", () => {
    expect(() =>
      validateJobRequest(
        {
          ...jobRequest(),
          mode: "COMPILE",
          stdin: "not allowed",
        },
        testConfig(),
      ),
    ).toThrow(/does not accept stdin/);
    expect(() =>
      validateJobRequest(
        {
          ...jobRequest(),
          mode: "TEST",
          stdin: undefined,
          tests: [],
          testBundleVersion: "bundle-1",
        },
        testConfig(),
      ),
    ).toThrow(/at least one test/);
    expect(() =>
      validateJobRequest(
        {
          ...jobRequest(),
          mode: "TEST",
          stdin: undefined,
          tests: [
            {
              id: "hidden-1",
              visibility: "HIDDEN",
              category: "edge",
              stdin: "1",
              expectedStdout: "2",
              comparison: "EXACT",
            },
          ],
        },
        testConfig(),
      ),
    ).toThrow(/testBundleVersion/);
  });

  it("resolves validated custom limits", () => {
    const validated = validateJobRequest(
      jobRequest("python", {
        limits: {
          wallTimeMs: 1_000,
          memoryMb: 64,
          cpuCount: 0.25,
          pids: 16,
          outputBytes: 1_024,
          fileBytes: 2_048,
        },
      }),
      testConfig(),
    );
    expect(validated.limits).toEqual({
      wallTimeMs: 1_000,
      memoryMb: 64,
      cpuCount: 0.25,
      pids: 16,
      outputBytes: 1_024,
      fileBytes: 2_048,
    });
  });
});

const visibleTest: RunnerTestCase = {
  id: "visible-1",
  visibility: "VISIBLE",
  category: "example",
  stdin: "",
  expectedStdout: "hello\n",
  comparison: "EXACT",
};

describe("result normalization", () => {
  it("supports exact and pedagogically trimmed comparison", () => {
    expect(normalizeOutput("a  \r\n", "EXACT")).toBe("a  \n");
    expect(normalizeOutput("a  \r\n\r\n", "TRIMMED")).toBe("a");
  });

  it("redacts workspace paths and bounds diagnostics", () => {
    expect(
      sanitizeOutput("/private/job/main.py\u0000", "/private/job", 100),
    ).toBe("<workspace>/main.py");
    expect(sanitizeOutput("123456", "/x", 3)).toContain(
      "<output truncated>",
    );
  });

  it("normalizes visible pass and wrong answer with outputs", () => {
    const passed = normalizeTestResult(
      visibleTest,
      processResult({ stdout: "hello\n" }),
      "/job",
      1_000,
    );
    expect(passed).toMatchObject({
      status: "PASSED",
      feedbackCode: "VISIBLE_PASS",
      actualStdout: "hello\n",
      expectedStdout: "hello\n",
    });
    const failed = normalizeTestResult(
      visibleTest,
      processResult({ stdout: "bye\n" }),
      "/job",
      1_000,
    );
    expect(failed.status).toBe("FAILED");
    expect(failed.actualStdout).toBe("bye\n");
  });

  it("never returns hidden actual, expected, or stderr", () => {
    const hidden = normalizeTestResult(
      { ...visibleTest, id: "hidden-1", visibility: "HIDDEN" },
      processResult({
        stdout: "secret actual",
        stderr: "secret diagnostic",
      }),
      "/job",
      1_000,
    );
    expect(hidden.status).toBe("FAILED");
    expect(hidden.feedbackCode).toBe("HIDDEN_WRONG_ANSWER");
    expect(hidden).not.toHaveProperty("actualStdout");
    expect(hidden).not.toHaveProperty("expectedStdout");
    expect(hidden).not.toHaveProperty("stderr");
    expect(JSON.stringify(hidden)).not.toContain("secret");
  });

  it("classifies timeout, output, memory, infrastructure, and errors", () => {
    expect(
      classifyProcess(processResult({ timedOut: true }), "RUN"),
    ).toBe("TIMEOUT");
    expect(
      classifyProcess(
        processResult({ outputLimitExceeded: true }),
        "RUN",
      ),
    ).toBe("OUTPUT_LIMIT");
    expect(
      classifyProcess(processResult({ exitCode: 137 }), "RUN"),
    ).toBe("MEMORY_LIMIT");
    expect(
      classifyProcess(processResult({ exitCode: 125 }), "RUN"),
    ).toBe("INFRASTRUCTURE_ERROR");
    expect(
      classifyProcess(processResult({ exitCode: 1 }), "COMPILE"),
    ).toBe("COMPILE_ERROR");
    expect(
      classifyProcess(processResult({ exitCode: 1 }), "RUN"),
    ).toBe("RUNTIME_ERROR");
  });
});
