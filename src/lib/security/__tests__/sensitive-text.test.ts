import { describe, expect, it } from "vitest";

import { redactSensitiveText as redactMentorText } from "@/lib/admin-mentor/evidence-reader";
import {
  containsCredentialOrHiddenEvidence,
  containsExposedCredentialVariant,
  redactSensitiveText,
} from "../sensitive-text";

const join = (...parts: string[]) => parts.join("");

describe("shared sensitive-text boundary", () => {
  it.each([
    ["21st", join("21", "st_sk_", "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6")],
    ["NVIDIA", join("nvapi", "-", "abcdefghijklmnopqrstuvwxyz123456")],
    ["OpenAI", join("sk", "-proj-", "abcdefghijklmnopqrstuvwxyz123456")],
    ["Anthropic", join("sk", "-ant-", "abcdefghijklmnopqrstuvwxyz123456")],
    ["OpenRouter", join("sk", "-or-v1-", "abcdefghijklmnopqrstuvwxyz123456")],
    ["Google", join("AI", "za", "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456")],
    ["GitHub", join("github", "_pat_", "abcdefghijklmnopqrstuvwxyz123456")],
    ["GitLab", join("gl", "pat-", "A1b2C3d4E5f6G7h8J9k0")],
    ["Hugging Face", join("h", "f_", "A1b2C3d4E5f6G7h8J9k0L1m2")],
    ["npm", join("np", "m_", "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6")],
    ["AWS access id", join("AK", "IA", "ABCDEFGHIJKLMNOP")],
    ["Slack token", join("xox", "b-", "1234567890-abcdefghijklmnopqrstuvwxyz")],
    ["Slack app token", join("xa", "pp-", "1-A1b2C3d4-E5f6G7h8-J9k0L1m2N3p4")],
    ["Slack webhook", join("https://hooks.slack.com/", "services/T000000/B000000/abcdefghijklmnop")],
    ["JWT", join("eyJ", "hbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.", "abcdefghijklmnopqrstuvwxyz")],
  ])("redacts a %s credential shape", (_label, value) => {
    const projected = redactSensitiveText(`before ${value} after`, 1_000);
    expect(projected).toMatchObject({ redacted: true, truncated: false });
    expect(projected.text).toBe("before [REDACTED] after");
    expect(projected.text).not.toContain(value);
  });

  it("redacts labelled AWS/generic secrets, passwords, bearer values, and hidden assessment evidence", () => {
    const input = [
      `aws_secret_access_key=${join("abcDEF", "1234567890", "abcdefghijklmnopqrstuvwx")}`,
      `api_key=${join("generic", "Key1234567890ABCDEF")}`,
      ["pass", "word: hunter2"].join(""),
      `Bearer ${join("header", "Payload123456")}`,
      "referenceAnswer=private-oracle",
    ].join(" ");
    const result = redactSensitiveText(input, 1_000);
    expect(result.redacted).toBe(true);
    expect(result.text.match(/\[REDACTED]/g)).toHaveLength(5);
    for (const forbidden of ["hunter2", "private-oracle", "genericKey", "abcDEF", "headerPayload"]) {
      expect(result.text).not.toContain(forbidden);
    }
  });

  it("redacts long single-alphabet values assigned to multi-word credential labels", () => {
    const input = "You completed loops. access token=abcdefghijklmnop";
    expect(redactSensitiveText(input, 1_000)).toEqual({
      text: "You completed loops. access token=[REDACTED]",
      redacted: true,
      truncated: false,
    });
  });

  it("does not redact ordinary identifiers, hashes, prose, URLs, or short non-secret labels", () => {
    const safe = [
      "python.values.scalars",
      "550e8400-e29b-41d4-a716-446655440000",
      `sha256:${"a".repeat(64)}`,
      "token: short-name",
      "api_key = get_config()",
      "api_key = process.env.API_KEY",
      "api_key = credentialProvider.currentApiKey",
      "api_key = configured_provider_api_key",
      `token = sha256:${"a".repeat(64)}`,
      `secret = ${"a1b2".repeat(16)}`,
      "password = fake_fixture_password",
      "https://example.com/services/learning",
      "Use a secret variable name in this explanation.",
    ].join("\n");
    expect(redactSensitiveText(safe, 10_000)).toEqual({ text: safe, redacted: false, truncated: false });
    expect(containsCredentialOrHiddenEvidence(safe)).toBe(false);
  });

  it("detects credential and hidden-evidence output without rejecting ordinary networking examples", () => {
    expect(containsCredentialOrHiddenEvidence("access token=abcdefghijklmnop")).toBe(true);
    expect(containsCredentialOrHiddenEvidence("referenceAnswer=private-oracle")).toBe(true);
    expect(containsCredentialOrHiddenEvidence("A private IPv4 example is 192.0.2.10.")).toBe(false);
  });

  it("detects exact prefixless provider credentials and their transport encodings", () => {
    const credential = "Q7w9Er2Ty4Ui6Op8As0Df3Gh";
    expect(containsExposedCredentialVariant(`echo ${credential}`, [credential])).toBe(true);
    expect(containsExposedCredentialVariant(Buffer.from(credential).toString("base64"), [credential])).toBe(true);
    expect(containsExposedCredentialVariant(encodeURIComponent(credential), [credential])).toBe(true);
    expect(containsExposedCredentialVariant("ordinary teaching output", [credential])).toBe(false);
  });

  it("applies the same redaction policy to audited mentor projections and preserves the hard length ceiling", () => {
    const secret = join("xox", "p-", "1234567890-abcdefghijklmnopqrstuvwxyz");
    expect(redactMentorText(secret, 100).text).toBe("[REDACTED]");
    const bounded = redactSensitiveText("x".repeat(500), 40);
    expect(bounded).toMatchObject({ redacted: false, truncated: true });
    expect(bounded.text).toHaveLength(40);
    expect(bounded.text).toContain("[truncated]");
  });
});
