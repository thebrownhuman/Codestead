import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { brokerSecret, canonicalOrigin, LIMITS, practiceInput, sameOrigin, signEnvelope, verifyEnvelope } from "../interactive-protocol.mjs";

it("requires an exact canonical HTTPS production origin, even for GET upgrades", () => {
  expect(canonicalOrigin("https://learn.test")).toBe("https://learn.test");
  for (const value of [undefined, "http://learn.test", "https://learn.test/", "https://u:p@learn.test", "bad"]) {
    expect(canonicalOrigin(value)).toBeNull();
  }
  expect(canonicalOrigin("http://localhost:3000", false)).toBe("http://localhost:3000");
  for (const headers of [new Headers(), new Headers({ origin: "null" }), new Headers({ origin: "https://learn.test", "sec-fetch-site": "cross-site" })]) {
    expect(sameOrigin(headers, "https://learn.test")).toBe(false);
  }
  expect(sameOrigin(new Headers({ origin: "https://learn.test", "sec-fetch-site": "same-origin" }), "https://learn.test")).toBe(true);
  expect(sameOrigin({ origin: "https://learn.test" }, "https://learn.test")).toBe(true);
});
it("authenticates purpose and bytes and rejects malformed, expired, future and wrong-key envelopes", () => {
  const key = randomBytes(32).toString("hex");
  const now = 100000;
  const proof = signEnvelope(key, "control", { userId: "alice" }, now);
  expect(verifyEnvelope(key, "control", proof, now)).toMatchObject({ userId: "alice", iat: now, exp: now + LIMITS.grantMs });
  for (const [purpose, token, time, secret] of [
    ["authorize", proof, now, key], ["control", proof, now + LIMITS.grantMs, key],
    ["control", proof, now - 2000, key], ["control", proof, now, "wrong-key"],
    ["control", "malformed", now, key], ["control", undefined, now, key],
    ["control", `${"a".repeat(4100)}.abc`, now, key],
  ] as const) expect(() => verifyEnvelope(secret, purpose, token, time)).toThrow();
});
it("loads only a bounded secret or owner-provisioned file without exposing its bytes", () => {
  for (const value of [undefined, "short", "a".repeat(4097)]) expect(() => brokerSecret({ INTERACTIVE_BROKER_SECRET: value })).toThrow("BROKER_UNAVAILABLE");
  const value = randomBytes(32).toString("hex");
  expect(brokerSecret({ INTERACTIVE_BROKER_SECRET: value })).toHaveLength(64);
  const directory = mkdtempSync(path.join(os.tmpdir(), "codestead-broker-contract-"));
  const file = path.join(directory, "fixture");
  try {
    writeFileSync(file, value + "\n");
    expect(brokerSecret({ INTERACTIVE_BROKER_SECRET_FILE: file })).toHaveLength(64);
  } finally { unlinkSync(file); rmdirSync(directory); }
});
it("allows exactly five bounded practice inputs and never caller-supplied execution authority", () => {
  const runtimes = { c: { version: "14.2.0" }, cpp: { version: "14.2.0" }, java: { version: "21.0.12" },
    python: { version: "3.14.8" }, javascript: { version: "22.23.3" } };
  for (const language of Object.keys(runtimes)) expect(practiceInput({ language, source: "x", mode: "practice" }, runtimes)).toMatchObject({
    type: "init", language: language === "cpp" ? "c++" : language,
  });
  for (const value of [null, [], { mode: "exam", source: "x", language: "c" },
    { mode: "practice", source: "", language: "c" }, { mode: "practice", source: "x", language: "__proto__" },
    { mode: "practice", source: "x", language: "c", run_cpu_time: 999999 },
    { mode: "practice", source: "😀".repeat(32769), language: "python" }]) {
    expect(() => practiceInput(value, runtimes)).toThrow("PRACTICE_ONLY");
  }
  expect(LIMITS).toMatchObject({ slots: 2, grantMs: 30000, idleMs: 60000, wallMs: 300000,
    sourceBytes: 131072, stdinBytes: 16384, outputBytes: 65536 });
});
