import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { NextResponse } from "next/server";

import { pool } from "@/lib/db/client";

export type RateLimitFailureMode = "closed" | "open";

export type RateLimitPolicyName =
  | "access_request_ip"
  | "access_request_email"
  | "invitation_validate_ip"
  | "invitation_validate_token"
  | "invitation_activate_ip"
  | "invitation_activate_token"
  | "fresh_mfa_user"
  | "session_revocation_user"
  | "lost_device_request_ip"
  | "lost_device_request_email"
  | "lost_device_verify_ip"
  | "lost_device_verify_proof"
  | "credential_write_user"
  | "credential_reveal_admin"
  | "credential_mutation_admin"
  | "fallback_grant_admin"
  | "plan_revision_admin"
  | "onboarding_complete_user"
  | "privacy_consent_user"
  | "social_profile_user"
  | "portfolio_mutation_user"
  | "social_read_user"
  | "community_read_user"
  | "community_write_user"
  | "community_report_user"
  | "community_moderation_admin"
  | "certificate_revoke_admin"
  | "certificate_issue_user"
  | "module_project_start_user"
  | "career_mutation_admin"
  | "battle_read_user"
  | "battle_write_user"
  | "battle_submit_user"
  | "game_check_user"
  | "ai_tutor_minute"
  | "ai_tutor_day"
  | "code_run_minute"
  | "code_run_hour"
  | "draft_sync_user"
  | "exam_start_user"
  | "exam_run_user"
  | "exam_submit_user"
  | "exam_reexam_grant_admin"
  | "file_upload_user"
  | "github_review_user"
  | "project_revision_user"
  | "project_review_appeal_user"
  | "learning_request_user"
  | "data_export_admin"
  | "account_deletion_admin"
  | "storage_quota_admin"
  | "appeal_decision_admin"
  | "notification_pause_admin"
  | "notification_preferences_user"
  | "curriculum_mutation_admin"
  | "mentor_evidence_read_admin"
  | "runner_recovery_admin";

export type RateLimitPolicy = Readonly<{
  name: RateLimitPolicyName;
  limit: number;
  windowSeconds: number;
  failureMode: RateLimitFailureMode;
}>;

const DEFAULT_POLICIES: Record<RateLimitPolicyName, RateLimitPolicy> = {
  access_request_ip: policy("access_request_ip", 5, 15 * 60),
  access_request_email: policy("access_request_email", 3, 24 * 60 * 60),
  invitation_validate_ip: policy("invitation_validate_ip", 30, 15 * 60),
  invitation_validate_token: policy("invitation_validate_token", 10, 15 * 60),
  invitation_activate_ip: policy("invitation_activate_ip", 10, 60 * 60),
  invitation_activate_token: policy("invitation_activate_token", 5, 60 * 60),
  fresh_mfa_user: policy("fresh_mfa_user", 10, 15 * 60),
  session_revocation_user: policy("session_revocation_user", 3, 24 * 60 * 60),
  lost_device_request_ip: policy("lost_device_request_ip", 5, 15 * 60),
  lost_device_request_email: policy("lost_device_request_email", 3, 24 * 60 * 60),
  lost_device_verify_ip: policy("lost_device_verify_ip", 20, 15 * 60),
  lost_device_verify_proof: policy("lost_device_verify_proof", 5, 15 * 60),
  credential_write_user: policy("credential_write_user", 10, 60 * 60),
  credential_reveal_admin: policy("credential_reveal_admin", 5, 60 * 60),
  credential_mutation_admin: policy("credential_mutation_admin", 10, 60 * 60),
  fallback_grant_admin: policy("fallback_grant_admin", 20, 60 * 60),
  plan_revision_admin: policy("plan_revision_admin", 30, 60 * 60),
  onboarding_complete_user: policy("onboarding_complete_user", 10, 60 * 60),
  privacy_consent_user: policy("privacy_consent_user", 30, 60 * 60),
  social_profile_user: policy("social_profile_user", 30, 60 * 60),
  portfolio_mutation_user: policy("portfolio_mutation_user", 30, 60 * 60),
  social_read_user: policy("social_read_user", 60, 60),
  community_read_user: policy("community_read_user", 90, 60),
  community_write_user: policy("community_write_user", 30, 60 * 60),
  community_report_user: policy("community_report_user", 10, 24 * 60 * 60),
  community_moderation_admin: policy("community_moderation_admin", 60, 60 * 60),
  certificate_revoke_admin: policy("certificate_revoke_admin", 10, 60 * 60),
  certificate_issue_user: policy("certificate_issue_user", 10, 24 * 60 * 60),
  module_project_start_user: policy("module_project_start_user", 20, 24 * 60 * 60),
  career_mutation_admin: policy("career_mutation_admin", 30, 60 * 60),
  battle_read_user: policy("battle_read_user", 90, 60),
  battle_write_user: policy("battle_write_user", 30, 60 * 60),
  battle_submit_user: policy("battle_submit_user", 20, 60 * 60),
  game_check_user: policy("game_check_user", 60, 60),
  ai_tutor_minute: policy("ai_tutor_minute", 20, 60),
  ai_tutor_day: policy("ai_tutor_day", 500, 24 * 60 * 60),
  code_run_minute: policy("code_run_minute", 10, 60),
  code_run_hour: policy("code_run_hour", 120, 60 * 60),
  draft_sync_user: policy("draft_sync_user", 120, 60),
  exam_start_user: policy("exam_start_user", 5, 60 * 60),
  exam_run_user: policy("exam_run_user", 20, 60),
  exam_submit_user: policy("exam_submit_user", 10, 60),
  exam_reexam_grant_admin: policy("exam_reexam_grant_admin", 20, 60 * 60),
  file_upload_user: policy("file_upload_user", 10, 60 * 60),
  github_review_user: policy("github_review_user", 5, 60 * 60),
  project_revision_user: policy("project_revision_user", 30, 60 * 60),
  project_review_appeal_user: policy("project_review_appeal_user", 10, 60 * 60),
  learning_request_user: policy("learning_request_user", 5, 24 * 60 * 60),
  data_export_admin: policy("data_export_admin", 5, 24 * 60 * 60),
  account_deletion_admin: policy("account_deletion_admin", 3, 24 * 60 * 60),
  storage_quota_admin: policy("storage_quota_admin", 30, 60 * 60),
  appeal_decision_admin: policy("appeal_decision_admin", 30, 60 * 60),
  notification_pause_admin: policy("notification_pause_admin", 30, 60 * 60),
  notification_preferences_user: policy("notification_preferences_user", 30, 60 * 60),
  curriculum_mutation_admin: policy("curriculum_mutation_admin", 60, 60 * 60),
  mentor_evidence_read_admin: policy("mentor_evidence_read_admin", 30, 60 * 60),
  runner_recovery_admin: policy("runner_recovery_admin", 10, 60 * 60),
};

function policy(
  name: RateLimitPolicyName,
  limit: number,
  windowSeconds: number,
  failureMode: RateLimitFailureMode = "closed",
): RateLimitPolicy {
  return { name, limit, windowSeconds, failureMode };
}

type PolicyOverride = { limit?: number; windowSeconds?: number; failureMode?: RateLimitFailureMode };

function configuredPolicies(): Record<RateLimitPolicyName, RateLimitPolicy> {
  const raw = process.env.RATE_LIMIT_OVERRIDES_JSON;
  if (!raw) return DEFAULT_POLICIES;
  let overrides: Record<string, PolicyOverride>;
  try {
    overrides = JSON.parse(raw) as Record<string, PolicyOverride>;
  } catch {
    throw new Error("RATE_LIMIT_OVERRIDES_JSON must be valid JSON.");
  }
  const result = { ...DEFAULT_POLICIES };
  for (const [name, override] of Object.entries(overrides)) {
    if (!(name in DEFAULT_POLICIES)) throw new Error(`Unknown rate-limit policy: ${name}`);
    const current = DEFAULT_POLICIES[name as RateLimitPolicyName];
    const limit = override.limit ?? current.limit;
    const windowSeconds = override.windowSeconds ?? current.windowSeconds;
    const failureMode = override.failureMode ?? current.failureMode;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
      throw new Error(`Invalid rate-limit limit for ${name}.`);
    }
    if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 31_536_000) {
      throw new Error(`Invalid rate-limit window for ${name}.`);
    }
    if (failureMode !== "closed" && failureMode !== "open") {
      throw new Error(`Invalid rate-limit failure mode for ${name}.`);
    }
    result[name as RateLimitPolicyName] = { name: name as RateLimitPolicyName, limit, windowSeconds, failureMode };
  }
  return result;
}

export function getRateLimitPolicy(name: RateLimitPolicyName): RateLimitPolicy {
  return configuredPolicies()[name];
}

export type RateLimitIdentityKind = "ip" | "email" | "invitation" | "recovery" | "user";

export type RateLimitCheck = Readonly<{
  policy: RateLimitPolicyName | RateLimitPolicy;
  identity: Readonly<{ kind: RateLimitIdentityKind; value: string }>;
}>;

export type ConsumeInput = Readonly<{
  scope: string;
  keyHash: string;
  limit: number;
  windowSeconds: number;
  now: Date;
}>;

export type ConsumeResult = Readonly<{
  count: number;
  resetAt: Date;
}>;

export interface RateLimitStore {
  consume(input: ConsumeInput): Promise<ConsumeResult>;
}

type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export class PostgresRateLimitStore implements RateLimitStore {
  private lastCleanupAt = 0;

  constructor(
    private readonly queryable: Queryable,
    private readonly cleanupIntervalMs = 5 * 60_000,
    private readonly cleanupBatchSize = 500,
  ) {}

  async consume(input: ConsumeInput): Promise<ConsumeResult> {
    const windowMs = input.windowSeconds * 1_000;
    const windowStartMs = Math.floor(input.now.getTime() / windowMs) * windowMs;
    const windowStart = new Date(windowStartMs);
    const resetAt = new Date(windowStartMs + windowMs);
    // Keep one extra window for operational inspection, then bounded cleanup removes it.
    const expiresAt = new Date(resetAt.getTime() + windowMs);
    const result = await this.queryable.query<{ request_count: number }>(
      `INSERT INTO api_rate_limit_window
        (scope, key_hash, window_start, request_count, expires_at)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (scope, key_hash, window_start)
       DO UPDATE SET
         request_count = LEAST(api_rate_limit_window.request_count + 1, $5),
         expires_at = GREATEST(api_rate_limit_window.expires_at, EXCLUDED.expires_at)
       RETURNING request_count`,
      [input.scope, input.keyHash, windowStart, expiresAt, input.limit + 1],
    );
    const count = Number(result.rows[0]?.request_count);
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error("Rate-limit counter did not return a valid value.");
    }
    await this.maybeCleanup(input.now);
    return { count, resetAt };
  }

  private async maybeCleanup(now: Date) {
    if (now.getTime() - this.lastCleanupAt < this.cleanupIntervalMs) return;
    this.lastCleanupAt = now.getTime();
    try {
      await this.queryable.query(
        `DELETE FROM api_rate_limit_window
         WHERE ctid IN (
           SELECT ctid FROM api_rate_limit_window
           WHERE expires_at < $1
           ORDER BY expires_at
           LIMIT $2
         )`,
        [now, this.cleanupBatchSize],
      );
    } catch {
      // A cleanup failure must not erase an otherwise valid enforcement result.
      // The next process/interval retries; never log identities or SQL parameters.
      console.warn("rate_limit_cleanup_failed");
    }
  }
}

const postgresStore = new PostgresRateLimitStore(pool);

function rateLimitSecret(): string {
  const secret = process.env.RATE_LIMIT_HASH_KEY?.trim() || process.env.BETTER_AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("RATE_LIMIT_HASH_KEY (or BETTER_AUTH_SECRET) must contain at least 32 bytes.");
  }
  return secret;
}

function normalizedIdentity(kind: RateLimitIdentityKind, value: string): string {
  const trimmed = value.trim();
  if (kind === "email" || kind === "ip") return trimmed.toLowerCase();
  return trimmed;
}

export function hashRateLimitIdentity(
  scope: string,
  kind: RateLimitIdentityKind,
  value: string,
  secret = rateLimitSecret(),
): string {
  return createHmac("sha256", secret)
    .update("learncoding-rate-limit-v1\0")
    .update(scope)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(normalizedIdentity(kind, value))
    .digest("hex");
}

/**
 * Reads only the explicitly trusted proxy header. With Cloudflare Tunnel the
 * origin must remain unreachable directly; otherwise clients could spoof it.
 * Missing/invalid addresses intentionally share a restrictive anonymous bucket.
 */
export function rateLimitIp(request: Request): string {
  const headerName = (process.env.RATE_LIMIT_TRUSTED_IP_HEADER ?? "cf-connecting-ip").trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(headerName)) return "unavailable";
  const candidate = request.headers.get(headerName)?.trim() ?? "";
  return isIP(candidate) ? candidate : "unavailable";
}

type AppliedDecision = Readonly<{
  policy: RateLimitPolicy;
  remaining: number;
  resetAt: Date;
  allowed: boolean;
}>;

export type RateLimitDependencies = Readonly<{
  store?: RateLimitStore;
  now?: () => Date;
  secret?: string;
}>;

function decisionHeaders(decision: AppliedDecision, now: Date): Headers {
  const resetSeconds = Math.max(1, Math.ceil((decision.resetAt.getTime() - now.getTime()) / 1_000));
  const headers = new Headers({
    "RateLimit-Limit": String(decision.policy.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(resetSeconds),
    "RateLimit-Policy": `${decision.policy.limit};w=${decision.policy.windowSeconds}`,
    "X-RateLimit-Limit": String(decision.policy.limit),
    "X-RateLimit-Remaining": String(decision.remaining),
    "X-RateLimit-Reset": String(Math.ceil(decision.resetAt.getTime() / 1_000)),
  });
  if (!decision.allowed) headers.set("Retry-After", String(resetSeconds));
  return headers;
}

function applyHeaders(response: Response, headers: Headers): Response {
  // Preserve a stricter inner limiter when wrappers are nested (for example,
  // an IP budget outside an email/token budget on public endpoints).
  for (const [name, value] of headers) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  response.headers.set("Cache-Control", response.headers.get("Cache-Control") ?? "private, no-store");
  return response;
}

function safeIdentityValue(value: string): string {
  // Empty values still share a deterministic restrictive bucket.
  return value.trim() || "unavailable";
}

function unavailableResponse() {
  return NextResponse.json(
    { error: "Request protection is temporarily unavailable. Please retry shortly.", code: "RATE_LIMIT_UNAVAILABLE" },
    { status: 503, headers: { "Retry-After": "30", "Cache-Control": "private, no-store" } },
  );
}

/**
 * Consumes all configured budgets before running the handler. Multi-window
 * checks are conservative: a rejected long-window check still consumes the
 * earlier short-window counter, preventing retry amplification.
 */
export async function withRateLimit(
  checks: RateLimitCheck | readonly RateLimitCheck[],
  handler: () => Promise<Response>,
  dependencies: RateLimitDependencies = {},
): Promise<Response> {
  const allChecks = Array.isArray(checks) ? checks : [checks];
  const store = dependencies.store ?? postgresStore;
  const now = dependencies.now?.() ?? new Date();
  const decisions: AppliedDecision[] = [];

  for (const check of allChecks) {
    let configured: RateLimitPolicy;
    try {
      configured = typeof check.policy === "string" ? getRateLimitPolicy(check.policy) : check.policy;
    } catch {
      return unavailableResponse();
    }
    try {
      const result = await store.consume({
        scope: configured.name,
        keyHash: hashRateLimitIdentity(
          configured.name,
          check.identity.kind,
          safeIdentityValue(check.identity.value),
          dependencies.secret,
        ),
        limit: configured.limit,
        windowSeconds: configured.windowSeconds,
        now,
      });
      const decision: AppliedDecision = {
        policy: configured,
        remaining: Math.max(0, configured.limit - result.count),
        resetAt: result.resetAt,
        allowed: result.count <= configured.limit,
      };
      decisions.push(decision);
      if (!decision.allowed) {
        return applyHeaders(
          NextResponse.json(
            { error: "Too many requests. Please wait before trying again.", code: "RATE_LIMITED" },
            { status: 429 },
          ),
          decisionHeaders(decision, now),
        );
      }
    } catch {
      if (configured.failureMode === "open") continue;
      return unavailableResponse();
    }
  }

  const response = await handler();
  if (!decisions.length) return response;
  // Report the budget with the smallest fraction remaining.
  const strictest = decisions.reduce((best, current) =>
    current.remaining / current.policy.limit < best.remaining / best.policy.limit ? current : best,
  );
  return applyHeaders(response, decisionHeaders(strictest, now));
}

/** Constant-time helper retained for tests/diagnostics without exposing hashes. */
export function sameRateLimitHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
