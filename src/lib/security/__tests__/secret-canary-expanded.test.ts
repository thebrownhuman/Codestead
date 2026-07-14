import { describe, expect, it } from "vitest";

import { findSecretCanaries } from "../secret-canary";

describe("expanded repository credential scan", () => {
  it("detects shared high-confidence credential shapes without returning values", () => {
    const values = [
      ["21st-api-key", ["21", "st_sk_", "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6"].join("")],
      ["github-token", ["github", "_pat_", "a".repeat(40)].join("")],
      ["gitlab-token", ["gl", "pat-", "A1b2C3d4E5f6G7h8J9k0"].join("")],
      ["hugging-face-token", ["h", "f_", "A1b2C3d4E5f6G7h8J9k0L1m2"].join("")],
      ["npm-token", ["np", "m_", "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6"].join("")],
      ["aws-access-key", ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("")],
      ["slack-token", ["xox", "b-", "1234567890-abcdefghijklmnop"].join("")],
      ["slack-app-token", ["xa", "pp-", "1-A1b2C3d4-E5f6G7h8-J9k0L1m2N3p4"].join("")],
      ["stripe-live-key", ["sk", "_live_", "A".repeat(24)].join("")],
      ["jwt", ["eyJ", "a".repeat(20), ".", "b".repeat(20), ".", "c".repeat(20)].join("")],
    ] as const;

    const findings = findSecretCanaries(values.map(([, value]) => value).join("\n"));

    expect(findings).toEqual(values.map(([detector], index) => ({ detector, line: index + 1 })));
    const serialized = JSON.stringify(findings);
    for (const [, value] of values) expect(serialized).not.toContain(value);
  });

  it("detects high-entropy credential assignments using filename-aware thresholds", () => {
    const awsSecret = ["vJ7", "qP9/", "mR2+sT4", "uW6xY8zA1bC3dE5fG7hJ9"].join("");
    const configuredKey = ["aB3d", "E5fG", "7hJ9", "kL2m", "N4pQ"].join("");
    const sourceToken = ["rT7_", "vW9x", "Y2zA", "4bC6", "dE8f", "G1hJ"].join("");
    const password = ["M7!q", "R2#v", "T9@x", "W4%z", "A6&c", "E8*g"].join("");

    expect(
      findSecretCanaries(
        [
          `AWS_SECRET_ACCESS_KEY=${awsSecret}`,
          `API_KEY='${configuredKey}'`,
          `AUTH_TOKEN=${sourceToken}`,
          `DATABASE_PASSWORD="${password}"`,
        ].join("\n"),
        "config/runtime.env",
      ),
    ).toEqual([
      { detector: "aws-secret-access-key-assignment", line: 1 },
      { detector: "credential-assignment", line: 2 },
      { detector: "credential-assignment", line: 3 },
      { detector: "password-assignment", line: 4 },
    ]);

    expect(findSecretCanaries(`API_KEY=${configuredKey}`, "src/runtime.ts")).toEqual([]);
  });

  it("does not report placeholders, references, hashes, fixture sentinels, or prose", () => {
    const hash = ["sha", "256:", "a".repeat(64)].join("");
    const bareHash = ["a1", "b2".repeat(31)].join("");
    const safe = [
      "API_KEY=your-api-key-here",
      "AUTH_TOKEN=${AUTH_TOKEN}",
      "API_KEY=process.env.API_KEY",
      "API_KEY=get_config()",
      "API_KEY=credentialProvider.currentApiKey",
      "API_KEY=configured_provider_api_key",
      `TOKEN=${hash}`,
      `SECRET=${bareHash}`,
      "PASSWORD=fake_fixture_M7!qR2#vT9@xW4%z",
      "The TOKEN: should-be-described-in-prose-and-not-treated-as-a-secret.",
      'API_KEY: "set this through your environment manager"',
    ].join("\n");

    expect(findSecretCanaries(safe, "docs/configuration.md")).toEqual([]);
  });
});
