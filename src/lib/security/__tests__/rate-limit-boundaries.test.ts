import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const protectedRoutes = [
  ["src/app/api/access-requests/route.ts", ["access_request_ip", "access_request_email"]],
  ["src/app/api/invitations/validate/route.ts", ["invitation_validate_ip", "invitation_validate_token"]],
  ["src/app/api/invitations/activate/route.ts", ["invitation_activate_ip", "invitation_activate_token"]],
  ["src/app/api/security/fresh-mfa/route.ts", ["fresh_mfa_user"]],
  ["src/app/api/security/verify-backup-code/route.ts", ["fresh_mfa_user"]],
  ["src/app/api/session-revocation-requests/route.ts", ["session_revocation_user"]],
  ["src/app/api/lost-device/request/route.ts", ["lost_device_request_ip", "lost_device_request_email"]],
  ["src/app/api/lost-device/verify/route.ts", ["lost_device_verify_ip", "lost_device_verify_proof"]],
  ["src/app/api/credentials/route.ts", ["credential_write_user"]],
  ["src/app/api/credentials/[id]/route.ts", ["credential_write_user"]],
  ["src/app/api/admin/credentials/[id]/reveal/route.ts", ["credential_reveal_admin"]],
  ["src/app/api/admin/credentials/[id]/route.ts", ["credential_mutation_admin"]],
  ["src/app/api/onboarding/complete/route.ts", ["onboarding_complete_user"]],
  ["src/app/api/ai/tutor/route.ts", ["ai_tutor_minute", "ai_tutor_day"]],
  ["src/app/api/ai/reports/route.ts", ["learning_request_user"]],
  ["src/app/api/code/run/route.ts", ["code_run_minute", "code_run_hour"]],
  ["src/app/api/drafts/route.ts", ["draft_sync_user"]],
  ["src/app/api/exams/start/route.ts", ["exam_start_user"]],
  ["src/app/api/exams/[sessionId]/run/route.ts", ["exam_run_user"]],
  ["src/app/api/exams/[sessionId]/submit/route.ts", ["exam_submit_user"]],
  ["src/app/api/files/route.ts", ["file_upload_user"]],
  ["src/app/api/projects/[id]/review/route.ts", ["github_review_user"]],
  ["src/app/api/projects/[id]/reviews/[reviewId]/appeal/route.ts", ["project_review_appeal_user"]],
  ["src/app/api/certificates/route.ts", ["certificate_issue_user"]],
  ["src/app/api/module-projects/route.ts", ["module_project_start_user"]],
  ["src/app/api/learning-requests/route.ts", ["learning_request_user"]],
  ["src/app/api/admin/fallback-grants/route.ts", ["fallback_grant_admin"]],
  ["src/app/api/admin/fallback-grants/[id]/revoke/route.ts", ["fallback_grant_admin"]],
  ["src/app/api/admin/learners/[learnerId]/plans/[enrollmentId]/revisions/route.ts", ["plan_revision_admin"]],
  ["src/app/api/admin/learners/[learnerId]/plans/[enrollmentId]/revert/route.ts", ["plan_revision_admin"]],
  ["src/app/api/admin/learners/[learnerId]/storage-quota/route.ts", ["storage_quota_admin"]],
  ["src/app/api/admin/learners/[learnerId]/inactivity-preference/route.ts", ["notification_pause_admin"]],
  ["src/app/api/admin/runner-recovery/[jobId]/resolve/route.ts", ["runner_recovery_admin"]],
] as const;

describe("rate-limit boundary wiring", () => {
  for (const [route, policies] of protectedRoutes) {
    it(`${route} remains guarded`, () => {
      const source = readFileSync(path.join(ROOT, route), "utf8");
      expect(source).toContain("withRateLimit");
      for (const policy of policies) expect(source).toContain(`policy: \"${policy}\"`);
    });
  }

  it("all anonymous entry points use the trusted-IP identity", () => {
    for (const route of [
      "src/app/api/access-requests/route.ts",
      "src/app/api/invitations/validate/route.ts",
      "src/app/api/invitations/activate/route.ts",
      "src/app/api/lost-device/request/route.ts",
      "src/app/api/lost-device/verify/route.ts",
    ]) {
      expect(readFileSync(path.join(ROOT, route), "utf8")).toContain("rateLimitIp(request)");
    }
  });

  it("no route stores or logs a raw rate-limit identity", () => {
    const implementation = readFileSync(path.join(ROOT, "src/lib/security/rate-limit.ts"), "utf8");
    expect(implementation).not.toMatch(/console\.(?:log|info|error)\s*\(/);
    expect(implementation).toContain("keyHash: hashRateLimitIdentity");
    expect(implementation).not.toContain("ip_address");
    expect(implementation).not.toContain("email_address");
  });
});
