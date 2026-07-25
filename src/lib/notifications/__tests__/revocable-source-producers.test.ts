import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("revocable source producer integration", () => {
  it("binds reset-password mail to the Better Auth verification row without adding a raw-token variable", () => {
    const auth = source("src/lib/auth.ts");
    expect(auth).toContain("loadResetPasswordVerificationSource");
    expect(auth).toContain("createResetPasswordSourceVariables");
    expect(auth).toMatch(/sendResetPassword:\s*async \(\{[^}]*token[^}]*\}\)/);
    const resetBlock = auth.slice(auth.indexOf("sendResetPassword:"), auth.indexOf("emailVerification:"));
    expect(resetBlock).toContain("verificationId");
    expect(resetBlock).not.toMatch(/variables:\s*\{[^}]*\btoken\b/);
  });

  it("queues lost-device proof mail through the exact non-bearer source-variable constructor", () => {
    const recovery = source("src/lib/security/lost-device-recovery.ts");
    expect(recovery.match(/eq\(user\.banned, false\)/g)).toHaveLength(3);
    expect(recovery.match(/createLostDeviceProofSourceVariables\(/g)).toHaveLength(2);
    expect(recovery).not.toMatch(/variables:\s*\{[^}]*rawProof/);
  });

  it("binds both session-revocation producers to a pending request and active unbanned admins", () => {
    const authenticated = source("src/app/api/session-revocation-requests/route.ts");
    const recovered = source("src/lib/security/lost-device-recovery.ts");
    for (const producer of [authenticated, recovered]) {
      expect(producer).toContain("createSessionRevocationSourceVariables");
      expect(producer).toMatch(/requestId(?:\s*:|\s*,)/);
      expect(producer).toContain("eq(user.status, \"active\")");
      expect(producer).toContain("eq(user.banned, false)");
    }
  });

  it("carries episode/dispatch authority IDs and filters administrator recipients fail-closed", () => {
    const inactivity = source("src/lib/notifications/inactivity.ts");
    const smart = source("src/lib/notifications/smart-reminders.ts");
    expect(inactivity.match(/createInactivitySourceVariables\(\{/g)).toHaveLength(3);
    expect(inactivity.match(/requireRevocableSourceVariables\(/g)).toHaveLength(3);
    expect(inactivity.match(/\n\s+episodeId,/g)).toHaveLength(3);
    expect(inactivity).toMatch(/role = 'admin' and status = 'active' and banned = false/);
    expect(inactivity.match(/u\.banned\s*=\s*false/g)).toHaveLength(2);
    expect(smart).toContain("createSmartReminderSourceVariables");
    expect(smart.match(/u\.banned\s*=\s*false/g)).toHaveLength(2);
    expect(smart).toMatch(
      /createSmartReminderSourceVariables\(\{[\s\S]*dispatchId: receipt\.id,[\s\S]*kind,[\s\S]*periodKey,[\s\S]*template: item\.template/,
    );
    const authority = source("src/lib/notifications/revocable-source-authority.ts");
    expect(authority).toContain("smartReminderPolicyVersion");
  });

  it("documents the central lock order and producer atomicity limits", () => {
    const runbook = source("docs/runbooks/mail-source-authority.md");
    expect(runbook).toContain("`email_outbox` row");
    expect(runbook).toContain("affected user rows in ascending user ID order");
    expect(runbook).toContain("verification -> lost_device_proof -> session");
    expect(runbook).toContain("session_revocation_request -> inactivity_episode -> consent_record");
    expect(runbook).toContain("notification_preference -> smart_reminder_dispatch");
    expect(runbook).toContain("Better Auth creates the verification row before invoking");
    expect(runbook).toContain("authenticated session-revocation route");
  });
});
