import { describe, expect, it } from "vitest";

import { renderEmail } from "../templates";

describe("email templates", () => {
  it("escapes user-controlled values", () => {
    const email = renderEmail("invitation", { name: "<script>alert(1)</script>", url: "https://example.test/activate" });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("never embeds credential values", () => {
    const email = renderEmail("credential-revealed", { name: "A", provider: "NVIDIA NIM" });
    expect(email.text).toContain("never included in email");
    expect(email.text).not.toMatch(/nvapi-|sk-/);
  });

  it("keeps a rejected access decision generic and non-sensitive", () => {
    const email = renderEmail("access-rejected", { name: "Learner" });
    expect(email.subject).toBe("Your Codestead access request");
    expect(email.text).toContain("cannot offer a learning seat");
    expect(email.text).not.toMatch(/decision reason|administrator note|password|api key/i);
  });

  it("links a curriculum decision without leaking the private admin reason", () => {
    const email = renderEmail("learning-request-updated", {
      name: "Learner",
      subject: "HPC",
      url: "https://learn.example.test/requests",
      decisionReason: "internal-only note",
    });
    expect(email.text).toContain("reviewed your curriculum request for HPC");
    expect(email.text).not.toContain("internal-only note");
  });

  it("escapes device labels and revocation reasons in security notifications", () => {
    const email = renderEmail("session-revocation-updated", {
      name: "Learner",
      decision: "rejected",
      reason: "<img src=x onerror=alert(1)>",
      url: "https://learn.example.test/settings?section=device",
    });
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;img");
    expect(email.text).toContain("rejected");
  });

  it("describes primary deletion without falsely claiming encrypted backup erasure", () => {
    const email = renderEmail("account-deleted", {
      name: "Learner",
      backupRetentionUntil: "2027-07-12T00:00:00.000Z",
    });
    expect(email.text).toContain("primary application data were deleted");
    expect(email.text).toContain("not claimed erased immediately");
    expect(email.text).toContain("2027-07-12T00:00:00.000Z");
  });

  it("keeps plan-revision email generic and excludes rationale or plan contents", () => {
    const secretRationale = "Private mentor rationale with learner mistake details";
    const email = renderEmail("learning-plan-changed", {
      name: "Learner",
      course: "Python",
      revision: "4",
      action: "updated",
      reason: secretRationale,
      plan: JSON.stringify([{ sourceCode: "private" }]),
    });
    expect(email.text).toContain("mastery evidence and prerequisite gates were not rewritten");
    expect(JSON.stringify(email)).not.toContain(secretRationale);
    expect(JSON.stringify(email)).not.toContain("sourceCode");
  });
});
