import { afterEach, describe, expect, it, vi } from "vitest";
import { FlexiblePostgresRateLimitStore, getRateLimitPolicy, hashRateLimitIdentity, withRateLimit, type ConsumeInput, type RateLimitPolicyName, type RateLimitStore } from "../rate-limit";

// Reviewed legacy defaults: changing a caller's budget must update this fixture explicitly.
const legacyPolicies = [
  ["access_request_ip", 5, 900],
  ["access_request_email", 3, 86400],
  ["invitation_validate_ip", 30, 900],
  ["invitation_validate_token", 10, 900],
  ["invitation_activate_ip", 10, 3600],
  ["invitation_activate_token", 5, 3600],
  ["fresh_mfa_user", 10, 900],
  ["session_revocation_user", 3, 86400],
  ["lost_device_request_ip", 5, 900],
  ["lost_device_request_email", 3, 86400],
  ["lost_device_verify_ip", 20, 900],
  ["lost_device_verify_proof", 5, 900],
  ["credential_write_user", 10, 3600],
  ["credential_reveal_admin", 5, 3600],
  ["credential_mutation_admin", 10, 3600],
  ["fallback_grant_admin", 20, 3600],
  ["plan_revision_admin", 30, 3600],
  ["onboarding_complete_user", 10, 3600],
  ["forced_password_change_user", 6, 60],
  ["privacy_consent_user", 30, 3600],
  ["social_profile_user", 30, 3600],
  ["portfolio_mutation_user", 30, 3600],
  ["social_read_user", 60, 60],
  ["community_read_user", 90, 60],
  ["community_write_user", 30, 3600],
  ["community_report_user", 10, 86400],
  ["community_moderation_admin", 60, 3600],
  ["certificate_revoke_admin", 10, 3600],
  ["certificate_issue_user", 10, 86400],
  ["module_project_start_user", 20, 86400],
  ["career_mutation_admin", 30, 3600],
  ["battle_read_user", 90, 60],
  ["battle_write_user", 30, 3600],
  ["battle_submit_user", 20, 3600],
  ["game_check_user", 60, 60],
  ["ai_tutor_minute", 20, 60],
  ["ai_tutor_day", 500, 86400],
  ["code_run_minute", 10, 60],
  ["code_run_hour", 120, 3600],
  ["draft_sync_user", 120, 60],
  ["exam_start_user", 5, 3600],
  ["exam_run_user", 20, 60],
  ["exam_submit_user", 10, 60],
  ["exam_autosave_user", 120, 60],
  ["exam_event_user", 60, 60],
  ["exam_heartbeat_user", 30, 60],
  ["exam_appeal_user", 10, 3600],
  ["exam_reexam_grant_admin", 20, 3600],
  ["file_upload_user", 10, 3600],
  ["github_review_user", 5, 3600],
  ["project_revision_user", 30, 3600],
  ["project_review_appeal_user", 10, 3600],
  ["learning_request_user", 5, 86400],
  ["data_export_admin", 5, 86400],
  ["account_deletion_admin", 3, 86400],
  ["storage_quota_admin", 30, 3600],
  ["appeal_decision_admin", 30, 3600],
  ["notification_pause_admin", 30, 3600],
  ["notification_preferences_user", 30, 3600],
  ["curriculum_mutation_admin", 60, 3600],
  ["mentor_evidence_read_admin", 30, 3600],
  ["runner_recovery_admin", 10, 3600],
  ["session_takeover_user", 5, 900],
  ["session_takeover_ip", 20, 900],
  ["session_takeover_email", 5, 900],
  ["monitoring_envelope_user", 30, 60],
  ["monitoring_envelope_ip", 30, 60],
] as const;
const secret = "parity-test-secret-with-at-least-thirty-two-bytes";

function persistedStore() {
  const rows = new Map<string, { points: number; expire: number }>();
  const query = vi.fn(async (command: string | { text: string; values?: unknown[] }) => {
    if (typeof command === "string") throw new Error("Unexpected query: runtime DDL/cleanup is disabled in this fixture");
    const [key, increment, expire, now] = command.values! as [string, number, number, number];
    const old = rows.get(key);
    const row = !old || old.expire <= now ? { points: increment, expire } : { ...old, points: old.points + increment };
    rows.set(key, row);
    return { rows: [row] };
  });
  return { query, rows, store: new FlexiblePostgresRateLimitStore({ query }, Infinity) };
}
function legacyStore(): RateLimitStore {
  const counts = new Map<string, number>();
  return { async consume(input: ConsumeInput) {
    const window = input.windowSeconds * 1000;
    const start = Math.floor(input.now.getTime() / window) * window;
    const key = input.scope + ":" + input.keyHash + ":" + start;
    const count = Math.min((counts.get(key) ?? 0) + 1, input.limit + 1);
    counts.set(key, count);
    return { count, resetAt: new Date(start + window) };
  } };
}
async function shape(response: Response) {
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("rate-limiter-flexible legacy parity for every default policy", () => {
  for (const [name, limit, windowSeconds] of legacyPolicies) {
    it(name + " preserves limits, keys, all headers and the full 429 body", async () => {
      vi.stubEnv("RATE_LIMIT_OVERRIDES_JSON", "");
      const policy = getRateLimitPolicy(name as RateLimitPolicyName);
      expect(policy).toEqual({ name, limit, windowSeconds, failureMode: "closed" });
      const now = new Date("2026-10-03T10:00:10Z");
      vi.spyOn(Date, "now").mockReturnValue(now.getTime());
      const persisted = persistedStore();
      const legacy = legacyStore();
      const identity = { kind: "user" as const, value: "learner-parity" };
      const handler = vi.fn(async () => new Response("allowed"));
      for (let index = 0; index < limit + 2; index += 1) {
        const expected = await withRateLimit({ policy, identity }, async () => new Response("allowed"), { store: legacy, now: () => now, secret });
        const actual = await withRateLimit({ policy, identity }, handler, { store: persisted.store, now: () => now, secret });
        expect(await shape(actual)).toEqual(await shape(expected));
      }
      expect(handler).toHaveBeenCalledTimes(limit);
      const start = Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000;
      expect([...persisted.rows.keys()]).toEqual([name + ":" + hashRateLimitIdentity(name, "user", identity.value, secret) + ":" + start]);
    });
  }
  it("uses the next epoch bucket at the millisecond boundary and survives a new store instance", async () => {
    vi.stubEnv("RATE_LIMIT_OVERRIDES_JSON", "");
    const persisted = persistedStore();
    let now = Date.parse("2026-10-03T10:00:59.999Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const input = { scope: "code_run_minute", keyHash: "a".repeat(64), limit: 1, windowSeconds: 60 };
    expect((await persisted.store.consume({ ...input, now: new Date(now) })).count).toBe(1);
    const restarted = new FlexiblePostgresRateLimitStore({ query: persisted.query }, Infinity);
    expect((await restarted.consume({ ...input, now: new Date(now) })).count).toBe(2);
    now += 1;
    expect(await restarted.consume({ ...input, now: new Date(now) })).toEqual({ count: 1, resetAt: new Date("2026-10-03T10:02:00Z") });
    expect(persisted.rows.size).toBe(2);
  });
  it("fails closed on an actual library database rejection with no handler or fallback", async () => {
    const query = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const handler = vi.fn(async () => new Response("unsafe"));
    const response = await withRateLimit({ policy: "monitoring_envelope_user", identity: { kind: "user", value: "learner" } }, handler, { store: new FlexiblePostgresRateLimitStore({ query }, Infinity), secret });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Request protection is temporarily unavailable. Please retry shortly.", code: "RATE_LIMIT_UNAVAILABLE" });
    expect(handler).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
