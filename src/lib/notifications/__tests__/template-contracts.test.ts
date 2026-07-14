import { describe, expect, it } from "vitest";

import type { EmailTemplate } from "../outbox";
import { renderEmail } from "../templates";

const templates: EmailTemplate[] = [
  "verify-email", "reset-password", "invitation", "lost-device-proof", "new-device",
  "session-revocation-requested", "session-revocation-updated", "session-revoked", "credential-changed",
  "account-deleted",
  "credential-revealed", "inactivity-reminder", "inactivity-reminder-followup",
  "inactivity-admin-notice", "daily-study-reminder", "revision-reminder",
  "goal-reminder", "challenge-reminder", "exam-result", "mastery-awarded",
  "appeal-updated", "weekly-summary", "backup-status",
  "learning-plan-changed",
];

describe("email template contract", () => {
  it.each(templates)("renders complete text and HTML for %s", (template) => {
    const rendered = renderEmail(template, {
      name: "Learner", provider: "NVIDIA NIM", topic: "Arrays",
      summary: "A private summary is available.", url: "https://learn.example.test/action?id=1&next=2",
    });
    expect(rendered.subject.trim().length).toBeGreaterThan(5);
    expect(rendered.text).toContain("Hi Learner");
    expect(rendered.text).toContain("https://learn.example.test/action?id=1&next=2");
    expect(rendered.html).toContain("<!doctype html>");
    expect(rendered.html).toContain("id=1&amp;next=2");
    expect(rendered.html).not.toMatch(/\bundefined\b|\bnull\b/);
  });

  it.each([
    "javascript:alert(1)", "data:text/html,evil", "file:///etc/passwd",
    "https://user:password@learn.example.test/action",
  ])("rejects unsafe action URL %s", (url) => {
    expect(() => renderEmail("invitation", { url })).toThrow("Email action URL is invalid");
  });

  it("escapes every user-controlled HTML interpolation", () => {
    const payload = "<img src=x onerror=alert(1)>";
    for (const template of ["credential-changed", "mastery-awarded", "weekly-summary", "backup-status"] as const) {
      const rendered = renderEmail(template, {
        name: payload, provider: payload, topic: payload, summary: payload,
      });
      expect(rendered.html).not.toContain("<img");
      expect(rendered.html).toContain("&lt;img");
    }
  });

  it("ignores secret-shaped extra variables for credential notifications", () => {
    const secret = "nvapi-test-secret-never-render";
    for (const template of ["credential-changed", "credential-revealed"] as const) {
      const serialized = JSON.stringify(renderEmail(template, {
        name: "Learner", provider: "NVIDIA NIM", apiKey: secret, key: secret,
      }));
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps every inactivity email generic even when sensitive extras are supplied", () => {
    const canaries = {
      score: "SCORE_CANARY_91",
      mistake: "MISTAKE_CANARY",
      code: "CODE_CANARY",
      chat: "CHAT_CANARY",
      provider: "PROVIDER_CANARY",
      apiKey: "nvapi-SECRET_CANARY",
      hours: "RAW_HOURS_CANARY",
      learnerEmail: "private-learner@example.invalid",
    };
    for (const template of [
      "inactivity-reminder",
      "inactivity-reminder-followup",
      "inactivity-admin-notice",
    ] as const) {
      const serialized = JSON.stringify(renderEmail(template, {
        name: template === "inactivity-admin-notice" ? "administrator" : "Learner",
        url: "https://learn.example.test/learn",
        ...canaries,
      }));
      for (const canary of Object.values(canaries)) expect(serialized).not.toContain(canary);
    }
  });

  it.each([
    ["needs_learner_input", "needs more information"],
    ["overturned", "appeal was granted"],
    ["upheld", "original result was upheld"],
  ])("renders a safe appeal decision update for %s", (decision, expected) => {
    const rendered = renderEmail("appeal-updated", {
      name: "Learner",
      decision,
      reason: "Private rationale must stay inside the authenticated app.",
    });
    expect(rendered.text).toContain(expected);
    expect(rendered.text).not.toContain("Private rationale");
    expect(rendered.html).not.toContain("Private rationale");
  });
});
