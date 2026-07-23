import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const userStatusEnum = pgEnum("user_status", [
  "pending",
  "active",
  "suspended",
  "deletion_pending",
  "deleted",
]);
export const requestStatusEnum = pgEnum("request_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
  "withdrawn",
]);
export const publicationStageEnum = pgEnum("publication_stage", [
  "draft",
  "beta",
  "verified",
  "retired",
  "coming_soon",
]);
export const enrollmentStatusEnum = pgEnum("enrollment_status", [
  "planned",
  "active",
  "paused",
  "completed",
  "withdrawn",
]);
export const masteryStatusEnum = pgEnum("mastery_status", [
  "unseen",
  "learning",
  "practicing",
  "proficient",
  "mastered",
  "needs_review",
]);
export const attemptKindEnum = pgEnum("attempt_kind", [
  "practice",
  "diagnostic",
  "quiz",
  "game",
  "mastery_check",
  "exam",
  "retake",
  "project",
]);
export const attemptStatusEnum = pgEnum("attempt_status", [
  "created",
  "in_progress",
  "submitted",
  "grading",
  "graded",
  "cancelled",
  "invalidated",
]);
export const examStatusEnum = pgEnum("exam_status", [
  "scheduled",
  "active",
  "paused_by_system",
  "submitted",
  "expired",
  "graded",
  "under_review",
  "invalidated",
]);
export const providerEnum = pgEnum("ai_provider", [
  "nvidia_nim",
  "openrouter",
  "google",
  "openai",
  "anthropic",
  "deepseek",
  "custom_openai_compatible",
]);
export const credentialStatusEnum = pgEnum("credential_status", [
  "pending_validation",
  "active",
  "invalid",
  "rate_limited",
  "disabled",
  "revoked",
]);
export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "leased",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);
export const visibilityEnum = pgEnum("visibility", [
  "private",
  "cohort",
  "public",
]);
export const notificationStatusEnum = pgEnum("notification_status", [
  "pending",
  "sending",
  "sent",
  "failed",
  "suppressed",
  "quarantined",
]);

/** Better Auth owns these five tables. App-specific fields are explicitly declared. */
export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
    role: text("role").default("learner"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires", { withTimezone: true }),
    status: userStatusEnum("status").default("pending").notNull(),
    publicId: uuid("public_id").defaultRandom().notNull(),
    timezone: text("timezone").default("Asia/Kolkata").notNull(),
    mustChangePassword: boolean("must_change_password").default(true).notNull(),
    adultConfirmedAt: timestamp("adult_confirmed_at", { withTimezone: true }),
    lastMeaningfulActivityAt: timestamp("last_meaningful_activity_at", {
      withTimezone: true,
    }),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("user_email_unique").on(sql`lower(${table.email})`),
    uniqueIndex("user_public_id_unique").on(table.publicId),
    uniqueIndex("user_single_admin_unique")
      .on(table.role)
      .where(sql`${table.role} = 'admin'`),
    index("user_status_idx").on(table.status),
  ],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    deviceHash: text("device_hash"),
    deviceLabel: text("device_label"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
    impersonatedBy: text("impersonated_by"),
    ...timestamps,
  },
  (table) => [
    index("session_user_idx").on(table.userId),
    uniqueIndex("session_one_active_user_unique")
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("session_active_device_idx").on(
      table.userId,
      table.deviceHash,
      table.revokedAt,
    ),
  ],
);

/**
 * Durable, token-free security history for sessions that Better Auth has
 * deleted. Authentication tokens are intentionally never copied here.
 */
export const authSessionHistory = pgTable(
  "auth_session_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    originalSessionId: text("original_session_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    deviceLabel: text("device_label"),
    userAgent: text("user_agent"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endReason: text("end_reason").notNull(),
    revokedByUserId: text("revoked_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("auth_session_history_original_unique").on(
      table.originalSessionId,
    ),
    index("auth_session_history_user_time_idx").on(
      table.userId,
      table.endedAt,
    ),
  ],
);

/**
 * Short-lived mailbox proofs for learners who cannot reach their only active
 * browser family. The bearer proof is never persisted: only its SHA-256 hash
 * is stored, and a successful verification consumes the row exactly once.
 */
export const lostDeviceProof = pgTable(
  "lost_device_proof",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    proofHash: text("proof_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("lost_device_proof_hash_unique").on(table.proofHash),
    uniqueIndex("lost_device_proof_open_unique")
      .on(table.userId, table.sessionId)
      .where(sql`${table.consumedAt} IS NULL`),
    index("lost_device_proof_expiry_idx").on(table.expiresAt),
    check(
      "lost_device_proof_hash_shape",
      sql`${table.proofHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "lost_device_proof_expiry_window",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '30 minutes'`,
    ),
  ],
);

export const sessionRevocationRequest = pgTable(
  "session_revocation_request",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    reason: text("reason").notNull(),
    requestChannel: text("request_channel").default("authenticated").notNull(),
    identityVerifiedAt: timestamp("identity_verified_at", { withTimezone: true }),
    proofRequestId: uuid("proof_request_id").references(() => lostDeviceProof.id, {
      onDelete: "restrict",
    }),
    status: requestStatusEnum("status").default("pending").notNull(),
    decidedBy: text("decided_by").references(() => user.id, {
      onDelete: "set null",
    }),
    decisionReason: text("decision_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("session_revocation_request_user_idx").on(
      table.userId,
      table.createdAt,
    ),
    index("session_revocation_request_status_idx").on(
      table.status,
      table.createdAt,
    ),
    uniqueIndex("session_revocation_request_pending_unique")
      .on(table.userId, table.sessionId)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex("session_revocation_request_proof_unique")
      .on(table.proofRequestId)
      .where(sql`${table.proofRequestId} IS NOT NULL`),
    check(
      "session_revocation_request_channel_check",
      sql`(${table.requestChannel} = 'authenticated' AND ${table.proofRequestId} IS NULL) OR (${table.requestChannel} = 'email_proof' AND ${table.proofRequestId} IS NOT NULL AND ${table.identityVerifiedAt} IS NOT NULL)`,
    ),
  ],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (table) => [
    index("account_user_idx").on(table.userId),
    uniqueIndex("account_provider_unique").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (table) => [uniqueIndex("two_factor_user_unique").on(table.userId)],
);

export const accessRequest = pgTable(
  "access_request",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    reason: text("reason"),
    status: requestStatusEnum("status").default("pending").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    adultConfirmedAt: timestamp("adult_confirmed_at", { withTimezone: true }),
    decidedBy: text("decided_by").references(() => user.id),
    decisionReason: text("decision_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("access_request_status_idx").on(table.status, table.createdAt),
    index("access_request_email_idx").on(table.email),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accessRequestId: uuid("access_request_id").references(() => accessRequest.id),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("invitation_token_hash_unique").on(table.tokenHash),
    index("invitation_email_idx").on(table.email),
  ],
);

export const learnerProfile = pgTable("learner_profile", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  selfReportedLevel: text("self_reported_level").default("beginner").notNull(),
  preferredSessionMinutes: integer("preferred_session_minutes").default(30).notNull(),
  weeklyGoalMinutes: integer("weekly_goal_minutes").default(180).notNull(),
  analogyFrequency: text("analogy_frequency").default("helpful").notNull(),
  analogyInterests: jsonb("analogy_interests")
    .$type<Array<{ label: string; category: string; confirmed: boolean }>>()
    .default([])
    .notNull(),
  learningGoals: jsonb("learning_goals").$type<string[]>().default([]).notNull(),
  selectedTracks: jsonb("selected_tracks").$type<string[]>().default([]).notNull(),
  dsaLanguage: text("dsa_language"),
  storageQuotaBytes: bigint("storage_quota_bytes", { mode: "number" })
    .default(2_147_483_648)
    .notNull(),
  onboardingStep: text("onboarding_step").default("identity").notNull(),
  onboardingCompletedAt: timestamp("onboarding_completed_at", {
    withTimezone: true,
  }),
  publicAlias: text("public_alias"),
  bio: text("bio"),
  profileVisibility: visibilityEnum("profile_visibility").default("private").notNull(),
  rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
  ...timestamps,
});

/**
 * Append-only record of each learner disclosure/consent decision. Current
 * state is the newest row for a purpose; historical decisions are retained so
 * a policy-version change or withdrawal can be demonstrated without mutating
 * prior evidence.
 */
export const consentRecord = pgTable(
  "consent_record",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    policyVersion: text("policy_version").notNull(),
    decision: text("decision").notNull(),
    dataCategories: jsonb("data_categories").$type<string[]>().default([]).notNull(),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("consent_record_idempotency_unique").on(table.idempotencyKey),
    index("consent_record_user_purpose_time_idx").on(
      table.userId,
      table.purpose,
      table.occurredAt,
    ),
    check(
      "consent_record_purpose_length",
      sql`char_length(${table.purpose}) BETWEEN 2 AND 100`,
    ),
    check(
      "consent_record_policy_version_length",
      sql`char_length(${table.policyVersion}) BETWEEN 3 AND 100`,
    ),
    check(
      "consent_record_decision_check",
      sql`${table.decision} IN ('accepted', 'withdrawn')`,
    ),
    check(
      "consent_record_source_check",
      sql`${table.source} IN ('onboarding', 'settings', 'system_migration')`,
    ),
    check(
      "consent_record_categories_array_check",
      sql`jsonb_typeof(${table.dataCategories}) = 'array'`,
    ),
    check(
      "consent_record_idempotency_length",
      sql`char_length(${table.idempotencyKey}) BETWEEN 8 AND 200`,
    ),
  ],
);

/**
 * Deliberate, revocable cohort projection. Publication is bound to the exact
 * consent record that was current when the learner pressed Publish; a later
 * withdrawal or policy-version acceptance therefore fails closed until the
 * learner explicitly republishes.
 */
export const cohortProfile = pgTable(
  "cohort_profile",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    bio: text("bio"),
    isPublished: boolean("is_published").default(false).notNull(),
    publishedConsentRecordId: uuid("published_consent_record_id")
      .references(() => consentRecord.id, { onDelete: "set null" }),
    showBio: boolean("show_bio").default(false).notNull(),
    showStreak: boolean("show_streak").default(false).notNull(),
    showMasterySummary: boolean("show_mastery_summary").default(false).notNull(),
    selectedAchievementIds: jsonb("selected_achievement_ids").$type<string[]>().default([]).notNull(),
    selectedProjectIds: jsonb("selected_project_ids").$type<string[]>().default([]).notNull(),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("cohort_profile_alias_unique").on(sql`lower(${table.alias})`),
    check("cohort_profile_alias_check", sql`${table.alias} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,29}$'`),
    check("cohort_profile_bio_length", sql`${table.bio} IS NULL OR char_length(${table.bio}) <= 280`),
    check("cohort_profile_achievement_selection_array", sql`jsonb_typeof(${table.selectedAchievementIds}) = 'array'`),
    check("cohort_profile_project_selection_array", sql`jsonb_typeof(${table.selectedProjectIds}) = 'array'`),
    check("cohort_profile_version_check", sql`${table.rowVersion} >= 1`),
    check("cohort_profile_publication_consent_check", sql`NOT ${table.isPublished} OR ${table.publishedConsentRecordId} IS NOT NULL`),
  ],
);

/** Append-only evidence for every profile publication, edit, and withdrawal. */
export const cohortProfileEvent = pgTable(
  "cohort_profile_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull().references(() => user.id),
    requestId: uuid("request_id").notNull(),
    event: text("event").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    reason: text("reason").notNull(),
    resultingVersion: bigint("resulting_version", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("cohort_profile_event_request_unique").on(table.userId, table.requestId),
    index("cohort_profile_event_timeline_idx").on(table.userId, table.occurredAt),
    check("cohort_profile_event_type_check", sql`${table.event} IN ('created', 'updated', 'published', 'withdrawn')`),
    check("cohort_profile_event_snapshot_object_check", sql`jsonb_typeof(${table.snapshot}) = 'object'`),
    check("cohort_profile_event_hash_check", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
    check("cohort_profile_event_reason_length", sql`char_length(${table.reason}) BETWEEN 8 AND 500`),
    check("cohort_profile_event_version_check", sql`${table.resultingVersion} >= 1`),
  ],
);

/**
 * Versioned private score evidence. Public leaderboard queries expose only the
 * bounded component totals and never this evidence payload.
 */
export const leaderboardScoreSnapshot = pgTable(
  "leaderboard_score_snapshot",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    periodKind: text("period_kind").notNull(),
    periodKey: text("period_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    formulaVersion: text("formula_version").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    totalPoints: integer("total_points").notNull(),
    components: jsonb("components").$type<Record<string, number>>().notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("leaderboard_score_snapshot_revision_unique").on(
      table.userId, table.periodKind, table.periodKey, table.formulaVersion, table.revision,
    ),
    index("leaderboard_score_period_rank_idx").on(table.periodKind, table.periodKey, table.formulaVersion, table.totalPoints),
    check("leaderboard_score_period_kind_check", sql`${table.periodKind} IN ('weekly', 'all_time')`),
    check("leaderboard_score_period_key_length", sql`char_length(${table.periodKey}) BETWEEN 3 AND 40`),
    check("leaderboard_score_formula_length", sql`char_length(${table.formulaVersion}) BETWEEN 3 AND 100`),
    check("leaderboard_score_revision_check", sql`${table.revision} >= 1`),
    check("leaderboard_score_points_check", sql`${table.totalPoints} >= 0`),
    check("leaderboard_score_components_object_check", sql`jsonb_typeof(${table.components}) = 'object'`),
    check("leaderboard_score_evidence_object_check", sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check("leaderboard_score_hash_check", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
    check("leaderboard_score_period_order_check", sql`${table.periodEnd} IS NULL OR ${table.periodEnd} > ${table.periodStart}`),
  ],
);

export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: text("actor_user_id").references(() => user.id),
    subjectUserId: text("subject_user_id").references(() => user.id),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    reason: text("reason"),
    outcome: text("outcome").notNull(),
    correlationId: text("correlation_id").notNull(),
    ipPseudonym: text("ip_pseudonym"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    previousHash: text("previous_hash"),
    eventHash: text("event_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_actor_time_idx").on(table.actorUserId, table.occurredAt),
    index("audit_subject_time_idx").on(table.subjectUserId, table.occurredAt),
    uniqueIndex("audit_event_hash_unique").on(table.eventHash),
  ],
);

export const providerCredential = pgTable(
  "provider_credential",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    label: text("label").notNull(),
    ciphertext: text("ciphertext").notNull(),
    wrappedDataKey: text("wrapped_data_key").notNull(),
    wrapIv: text("wrap_iv").notNull(),
    dataIv: text("data_iv").notNull(),
    authTag: text("auth_tag").notNull(),
    keyVersion: integer("key_version").default(1).notNull(),
    lastFour: text("last_four").notNull(),
    status: credentialStatusEnum("status")
      .default("pending_validation")
      .notNull(),
    isPreferred: boolean("is_preferred").default(false).notNull(),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("credential_user_provider_idx").on(table.userId, table.provider),
    check("credential_last_four_length", sql`char_length(${table.lastFour}) = 4`),
  ],
);

export const providerPolicy = pgTable(
  "provider_policy",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: providerEnum("provider").notNull(),
    operation: text("operation").notNull(),
    model: text("model").notNull(),
    priority: integer("priority").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    maxInputTokens: integer("max_input_tokens").default(16_000).notNull(),
    maxOutputTokens: integer("max_output_tokens").default(2_000).notNull(),
    timeoutMs: integer("timeout_ms").default(30_000).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("provider_policy_operation_unique").on(
      table.provider,
      table.operation,
      table.model,
    ),
    index("provider_policy_priority_idx").on(table.operation, table.enabled, table.priority),
  ],
);

export const adminFallbackGrant = pgTable(
  "admin_fallback_grant",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    learnerId: text("learner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => providerCredential.id, { onDelete: "restrict" }),
    provider: providerEnum("provider").notNull(),
    // A fallback grant is a frozen spending authorization, not permission to
    // use whichever model happens to be current in provider policy later.
    // The legacy-safe defaults deliberately make pre-migration grants
    // ineligible until an administrator issues a new explicit grant.
    model: text("model").default("legacy-unscoped-disabled").notNull(),
    tokenBudget: bigint("token_budget", { mode: "number" }).notNull(),
    tokensUsed: bigint("tokens_used", { mode: "number" }).default(0).notNull(),
    rupeeBudgetPaise: bigint("rupee_budget_paise", { mode: "number" }).default(0).notNull(),
    rupeesUsedPaise: bigint("rupees_used_paise", { mode: "number" }).default(0).notNull(),
    inputPaisePerMillionTokens: bigint("input_paise_per_million_tokens", { mode: "number" })
      .default(0)
      .notNull(),
    outputPaisePerMillionTokens: bigint("output_paise_per_million_tokens", { mode: "number" })
      .default(0)
      .notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").default("active").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => user.id, { onDelete: "restrict" }),
    createRequestId: uuid("create_request_id").defaultRandom().notNull(),
    createRequestHash: text("create_request_hash").default("0".repeat(64)).notNull(),
    revokeRequestId: uuid("revoke_request_id"),
    revokeRequestHash: text("revoke_request_hash"),
    grantedBy: text("granted_by").notNull().references(() => user.id),
    ...timestamps,
  },
  (table) => [
    index("fallback_grant_learner_idx").on(table.learnerId, table.expiresAt),
    index("fallback_grant_active_destination_idx").on(
      table.learnerId,
      table.provider,
      table.model,
      table.status,
      table.expiresAt,
    ),
    uniqueIndex("fallback_grant_create_request_unique").on(
      table.grantedBy,
      table.createRequestId,
    ),
    uniqueIndex("fallback_grant_revoke_request_unique")
      .on(table.revokedBy, table.revokeRequestId)
      .where(sql`${table.revokeRequestId} IS NOT NULL`),
    check("fallback_grant_model_length", sql`char_length(${table.model}) BETWEEN 1 AND 200`),
    check(
      "fallback_grant_token_budget_check",
      sql`${table.tokenBudget} > 0 AND ${table.tokensUsed} >= 0 AND ${table.tokensUsed} <= ${table.tokenBudget}`,
    ),
    check(
      "fallback_grant_rupee_budget_check",
      sql`${table.rupeeBudgetPaise} >= 0 AND ${table.rupeesUsedPaise} >= 0 AND ${table.rupeesUsedPaise} <= ${table.rupeeBudgetPaise}`,
    ),
    check(
      "fallback_grant_pricing_check",
      sql`${table.inputPaisePerMillionTokens} >= 0 AND ${table.outputPaisePerMillionTokens} >= 0`,
    ),
    check("fallback_grant_time_window_check", sql`${table.expiresAt} > ${table.startsAt}`),
    check("fallback_grant_status_check", sql`${table.status} IN ('active', 'revoked')`),
    check("fallback_grant_create_hash_check", sql`${table.createRequestHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "fallback_grant_revoke_hash_check",
      sql`${table.revokeRequestHash} IS NULL OR ${table.revokeRequestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "fallback_grant_state_check",
      sql`(${table.status} = 'active' AND ${table.revokedAt} IS NULL AND ${table.revokedBy} IS NULL AND ${table.revokeRequestId} IS NULL AND ${table.revokeRequestHash} IS NULL)
        OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL AND ${table.revokedBy} IS NOT NULL AND ${table.revokeRequestId} IS NOT NULL AND ${table.revokeRequestHash} IS NOT NULL)`,
    ),
  ],
);

export const adminFallbackReservation = pgTable(
  "admin_fallback_reservation",
  {
    id: uuid("id").primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => adminFallbackGrant.id, { onDelete: "restrict" }),
    learnerId: text("learner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    reservedTokens: bigint("reserved_tokens", { mode: "number" }).notNull(),
    reservedPaise: bigint("reserved_paise", { mode: "number" }).notNull(),
    actualTokens: bigint("actual_tokens", { mode: "number" }),
    actualPaise: bigint("actual_paise", { mode: "number" }),
    status: text("status").default("reserved").notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("fallback_reservation_grant_idx").on(table.grantId, table.createdAt),
    check(
      "fallback_reservation_amount_check",
      sql`${table.reservedTokens} > 0 AND ${table.reservedPaise} > 0`,
    ),
    check(
      "fallback_reservation_actual_check",
      sql`(${table.actualTokens} IS NULL AND ${table.actualPaise} IS NULL) OR (${table.actualTokens} BETWEEN 0 AND ${table.reservedTokens} AND ${table.actualPaise} BETWEEN 0 AND ${table.reservedPaise})`,
    ),
    check(
      "fallback_reservation_status_check",
      sql`${table.status} IN ('reserved', 'reconciled')`,
    ),
    check(
      "fallback_reservation_state_check",
      sql`(${table.status} = 'reserved' AND ${table.actualTokens} IS NULL AND ${table.actualPaise} IS NULL AND ${table.reconciledAt} IS NULL) OR (${table.status} = 'reconciled' AND ${table.actualTokens} IS NOT NULL AND ${table.actualPaise} IS NOT NULL AND ${table.reconciledAt} IS NOT NULL)`,
    ),
  ],
);

export const modelCall = pgTable(
  "model_call",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    credentialId: uuid("credential_id").references(() => providerCredential.id),
    provider: providerEnum("provider").notNull(),
    model: text("model").notNull(),
    operation: text("operation").notNull(),
    promptVersion: text("prompt_version").notNull(),
    contextManifest: jsonb("context_manifest")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    requestHash: text("request_hash").notNull(),
    responseHash: text("response_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("model_call_user_time_idx").on(table.userId, table.createdAt),
    index("model_call_credential_idx").on(table.credentialId),
  ],
);

/**
 * Durable, owner-scoped receipts for operations that may call an external AI
 * provider. The receipt stores only the canonical request hash and the safe
 * JSON response returned to the authenticated caller; it never stores provider
 * credentials or unsanitized request material.
 */
export const providerOperationReceipt = pgTable(
  "provider_operation_receipt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    requestId: uuid("request_id").notNull(),
    inputHash: text("input_hash").notNull(),
    status: text("status").default("processing").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    leaseId: uuid("lease_id").defaultRandom().notNull(),
    leaseVersion: integer("lease_version").default(1).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true })
      .default(sql`now() + interval '5 minutes'`)
      .notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("provider_operation_receipt_owner_action_request_unique").on(
      table.ownerUserId,
      table.action,
      table.requestId,
    ),
    index("provider_operation_receipt_owner_time_idx").on(table.ownerUserId, table.createdAt),
    index("provider_operation_receipt_processing_idx").on(table.status, table.updatedAt),
    check(
      "provider_operation_receipt_action_check",
      sql`${table.action} IN ('tutor.post', 'credential.test', 'credential.replace')`,
    ),
    check("provider_operation_receipt_hash_shape", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "provider_operation_receipt_status_check",
      sql`${table.status} IN ('processing', 'completed')`,
    ),
    check(
      "provider_operation_receipt_response_status_check",
      sql`${table.responseStatus} IS NULL OR ${table.responseStatus} BETWEEN 100 AND 599`,
    ),
    check(
      "provider_operation_receipt_response_shape",
      sql`(${table.status} = 'processing' AND ${table.responseStatus} IS NULL AND ${table.responseBody} IS NULL AND ${table.completedAt} IS NULL)
        OR (${table.status} = 'completed' AND ${table.responseStatus} IS NOT NULL AND ${table.responseBody} IS NOT NULL AND jsonb_typeof(${table.responseBody}) = 'object' AND ${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "provider_operation_receipt_response_size",
      sql`${table.responseBody} IS NULL OR octet_length(${table.responseBody}::text) <= 262144`,
    ),
    check("provider_operation_receipt_lease_version_check", sql`${table.leaseVersion} >= 1`),
  ],
);

export const course = pgTable("course", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  domain: text("domain").notNull(),
  icon: text("icon"),
  ...timestamps,
});

export const courseVersion = pgTable(
  "course_version",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => course.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    stage: publicationStageEnum("stage").default("draft").notNull(),
    scopeStatement: text("scope_statement").notNull(),
    sourceCommit: text("source_commit"),
    contentHash: text("content_hash").notNull(),
    approvedBy: text("approved_by").references(() => user.id),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publicationRevision: bigint("publication_revision", { mode: "number" }).default(1).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("course_version_unique").on(table.courseId, table.version)],
);

export const courseModule = pgTable(
  "course_module",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    courseVersionId: uuid("course_version_id")
      .notNull()
      .references(() => courseVersion.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    position: integer("position").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("course_module_slug_unique").on(table.courseVersionId, table.slug),
    uniqueIndex("course_module_position_unique").on(
      table.courseVersionId,
      table.position,
    ),
  ],
);

/**
 * Version-bound, solution-free mini-project brief. The content payload is
 * immutable after synchronization; only its reviewed publication workflow
 * may advance. A beta brief is usable practice but never direct reward
 * evidence. Verified status requires the exact current verified course
 * publication and an administrator decision enforced by the migration.
 */
export const moduleProjectTemplate = pgTable(
  "module_project_template",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    courseVersionId: uuid("course_version_id")
      .notNull()
      .references(() => courseVersion.id, { onDelete: "restrict" }),
    moduleKey: text("module_key").notNull(),
    templateKey: text("template_key").notNull(),
    templateVersion: text("template_version").notNull(),
    sourceCourseContentHash: text("source_course_content_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    title: text("title").notNull(),
    brief: jsonb("brief").$type<Record<string, unknown>>().notNull(),
    stage: publicationStageEnum("stage").default("draft").notNull(),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("module_project_template_key_unique").on(table.templateKey),
    uniqueIndex("module_project_template_module_version_unique").on(
      table.courseVersionId,
      table.moduleKey,
      table.templateVersion,
    ),
    index("module_project_template_catalog_idx").on(table.courseVersionId, table.stage, table.moduleKey),
    check("module_project_template_module_key_length", sql`char_length(${table.moduleKey}) BETWEEN 2 AND 180`),
    check("module_project_template_key_length", sql`char_length(${table.templateKey}) BETWEEN 10 AND 500`),
    check("module_project_template_version_length", sql`char_length(${table.templateVersion}) BETWEEN 3 AND 120`),
    check("module_project_template_course_hash", sql`${table.sourceCourseContentHash} ~ '^[0-9a-f]{64}$'`),
    check("module_project_template_content_hash", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("module_project_template_title_length", sql`char_length(${table.title}) BETWEEN 3 AND 300`),
    check("module_project_template_brief_object", sql`jsonb_typeof(${table.brief}) = 'object'`),
    check("module_project_template_brief_size", sql`octet_length(${table.brief}::text) <= 131072`),
    check("module_project_template_stage_check", sql`${table.stage} IN ('draft','beta','verified','retired')`),
    check("module_project_template_version_positive", sql`${table.rowVersion} >= 1`),
    check(
      "module_project_template_review_shape",
      sql`(${table.stage} = 'draft' AND ${table.reviewedByUserId} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.publishedAt} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.stage} IN ('beta','verified') AND ${table.reviewedByUserId} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.publishedAt} IS NOT NULL AND ${table.retiredAt} IS NULL)
        OR (${table.stage} = 'retired' AND ${table.reviewedByUserId} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.retiredAt} IS NOT NULL)`,
    ),
  ],
);

/** Append-only editorial provenance and durable request idempotency. */
export const moduleProjectTemplateEvent = pgTable(
  "module_project_template_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => moduleProjectTemplate.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull().references(() => user.id),
    requestId: uuid("request_id").notNull(),
    event: text("event").notNull(),
    inputHash: text("input_hash").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    resultingVersion: bigint("resulting_version", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("module_project_template_event_request_unique").on(table.templateId, table.requestId),
    index("module_project_template_event_timeline_idx").on(table.templateId, table.occurredAt, table.id),
    check("module_project_template_event_type", sql`${table.event} IN ('reviewed_beta','promoted_verified','retired')`),
    check("module_project_template_event_input_hash", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("module_project_template_event_reason_length", sql`char_length(${table.reason}) BETWEEN 20 AND 2000`),
    check("module_project_template_event_evidence_object", sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check("module_project_template_event_evidence_hash", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
    check("module_project_template_event_version_positive", sql`${table.resultingVersion} >= 1`),
  ],
);

export const concept = pgTable("concept", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  domain: text("domain").notNull(),
  description: text("description").notNull(),
  critical: boolean("critical").default(false).notNull(),
  ...timestamps,
});

export const lesson = pgTable(
  "lesson",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    moduleId: uuid("module_id")
      .notNull()
      .references(() => courseModule.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    difficulty: text("difficulty").notNull(),
    position: integer("position").notNull(),
    contentStatus: publicationStageEnum("content_status").default("draft").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("lesson_slug_unique").on(table.moduleId, table.slug),
    uniqueIndex("lesson_position_unique").on(table.moduleId, table.position),
  ],
);

export const lessonConcept = pgTable(
  "lesson_concept",
  {
    lessonId: uuid("lesson_id")
      .notNull()
      .references(() => lesson.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concept.id, { onDelete: "cascade" }),
    coverage: text("coverage").notNull(),
    weight: real("weight").default(1).notNull(),
  },
  (table) => [primaryKey({ columns: [table.lessonId, table.conceptId] })],
);

export const prerequisite = pgTable(
  "prerequisite",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    courseVersionId: uuid("course_version_id")
      .notNull()
      .references(() => courseVersion.id, { onDelete: "cascade" }),
    fromConceptId: uuid("from_concept_id")
      .notNull()
      .references(() => concept.id),
    toConceptId: uuid("to_concept_id")
      .notNull()
      .references(() => concept.id),
    minimumMastery: real("minimum_mastery").default(0.8).notNull(),
    rationale: text("rationale").notNull(),
  },
  (table) => [
    uniqueIndex("prerequisite_edge_unique").on(
      table.courseVersionId,
      table.fromConceptId,
      table.toConceptId,
    ),
    index("prerequisite_to_concept_idx").on(table.toConceptId),
    check("prerequisite_not_self", sql`${table.fromConceptId} <> ${table.toConceptId}`),
  ],
);

export const lessonBlock = pgTable(
  "lesson_block",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    lessonId: uuid("lesson_id")
      .notNull()
      .references(() => lesson.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    interestTags: jsonb("interest_tags").$type<string[]>().default([]).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("lesson_block_position_unique").on(table.lessonId, table.position)],
);

export const activity = pgTable(
  "activity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    lessonId: uuid("lesson_id")
      .notNull()
      .references(() => lesson.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id").references(() => concept.id),
    slug: text("slug").notNull(),
    type: text("type").notNull(),
    instructions: text("instructions").notNull(),
    specification: jsonb("specification").$type<Record<string, unknown>>().notNull(),
    difficulty: text("difficulty").notNull(),
    maxPoints: integer("max_points").default(100).notNull(),
    ...timestamps,
  },
  (table) => [
    index("activity_lesson_idx").on(table.lessonId),
    index("activity_concept_idx").on(table.conceptId),
  ],
);

export const testBundle = pgTable(
  "test_bundle",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activity.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    encryptedObjectRef: text("encrypted_object_ref").notNull(),
    harnessHash: text("harness_hash").notNull(),
    runtimeImageDigest: text("runtime_image_digest").notNull(),
    visibleTestCount: integer("visible_test_count").default(0).notNull(),
    hiddenTestCount: integer("hidden_test_count").default(0).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("test_bundle_activity_idx").on(table.activityId)],
);

export const curriculumArtifact = pgTable(
  "curriculum_artifact",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    courseVersionId: uuid("course_version_id")
      .notNull()
      .references(() => courseVersion.id, { onDelete: "cascade" }),
    artifactKey: text("artifact_key").notNull(),
    artifactType: text("artifact_type").notNull(),
    skillKey: text("skill_key"),
    sourcePath: text("source_path").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    contentHash: text("content_hash").notNull(),
    publicationStage: text("publication_stage").notNull(),
    aiAssisted: boolean("ai_assisted").default(false).notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().default({}).notNull(),
    reviewStatus: text("review_status").default("unreviewed").notNull(),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("curriculum_artifact_version_key_unique").on(table.courseVersionId, table.artifactKey),
    index("curriculum_artifact_review_queue_idx").on(table.reviewStatus, table.updatedAt),
    check("curriculum_artifact_type_check", sql`${table.artifactType} IN ('course_manifest', 'authored_lesson', 'assessment_bank')`),
    check("curriculum_artifact_hash_check", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("curriculum_artifact_content_object_check", sql`jsonb_typeof(${table.content}) = 'object'`),
    check("curriculum_artifact_provenance_object_check", sql`jsonb_typeof(${table.provenance}) = 'object'`),
    check("curriculum_artifact_publication_stage_check", sql`${table.publicationStage} IN ('draft', 'in-review', 'approved', 'published', 'retired')`),
    check("curriculum_artifact_review_status_check", sql`${table.reviewStatus} IN ('unreviewed', 'in_review', 'approved', 'changes_requested', 'rejected')`),
    check("curriculum_artifact_row_version_check", sql`${table.rowVersion} >= 1`),
  ],
);

export const curriculumReviewEvent = pgTable(
  "curriculum_review_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => curriculumArtifact.id, { onDelete: "cascade" }),
    reviewerUserId: text("reviewer_user_id").notNull().references(() => user.id),
    reviewerKind: text("reviewer_kind").notNull(),
    decision: text("decision").notNull(),
    requestId: uuid("request_id").notNull(),
    contentHash: text("content_hash").notNull(),
    checklist: jsonb("checklist").$type<Record<string, unknown>>().default({}).notNull(),
    reviewedItemIds: jsonb("reviewed_item_ids").$type<string[]>().default([]).notNull(),
    reason: text("reason").notNull(),
    resultingVersion: bigint("resulting_version", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("curriculum_review_event_request_unique").on(table.artifactId, table.requestId),
    index("curriculum_review_event_timeline_idx").on(table.artifactId, table.occurredAt),
    check("curriculum_review_event_reviewer_kind_check", sql`${table.reviewerKind} = 'human'`),
    check("curriculum_review_event_decision_check", sql`${table.decision} IN ('approved', 'changes_requested', 'rejected')`),
    check("curriculum_review_event_hash_check", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("curriculum_review_event_checklist_object_check", sql`jsonb_typeof(${table.checklist}) = 'object'`),
    check("curriculum_review_event_items_array_check", sql`jsonb_typeof(${table.reviewedItemIds}) = 'array'`),
    check("curriculum_review_event_reason_length", sql`char_length(${table.reason}) BETWEEN 20 AND 2000`),
    check("curriculum_review_event_version_check", sql`${table.resultingVersion} >= 2`),
  ],
);

export const curriculumReleaseEvidence = pgTable(
  "curriculum_release_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    courseVersionId: uuid("course_version_id")
      .notNull()
      .references(() => courseVersion.id, { onDelete: "cascade" }),
    submittedBy: text("submitted_by").notNull().references(() => user.id),
    requestId: uuid("request_id").notNull(),
    evidenceVersion: bigint("evidence_version", { mode: "number" }).notNull(),
    contentHash: text("content_hash").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("curriculum_release_evidence_request_unique").on(table.courseVersionId, table.requestId),
    uniqueIndex("curriculum_release_evidence_version_unique").on(table.courseVersionId, table.evidenceVersion),
    index("curriculum_release_evidence_timeline_idx").on(table.courseVersionId, table.createdAt),
    check("curriculum_release_evidence_content_hash_check", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("curriculum_release_evidence_hash_check", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
    check("curriculum_release_evidence_object_check", sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check("curriculum_release_evidence_version_check", sql`${table.evidenceVersion} >= 1`),
  ],
);

export const curriculumPublicationPointer = pgTable(
  "curriculum_publication_pointer",
  {
    courseId: uuid("course_id")
      .primaryKey()
      .references(() => course.id, { onDelete: "cascade" }),
    currentCourseVersionId: uuid("current_course_version_id")
      .notNull()
      .references(() => courseVersion.id),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    updatedBy: text("updated_by").notNull().references(() => user.id),
    reason: text("reason").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("curriculum_publication_pointer_version_unique").on(table.currentCourseVersionId),
    check("curriculum_publication_pointer_version_check", sql`${table.rowVersion} >= 1`),
    check("curriculum_publication_pointer_reason_length", sql`char_length(${table.reason}) BETWEEN 20 AND 2000`),
  ],
);

export const curriculumPublicationEvent = pgTable(
  "curriculum_publication_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    courseId: uuid("course_id").notNull().references(() => course.id, { onDelete: "cascade" }),
    courseVersionId: uuid("course_version_id").notNull().references(() => courseVersion.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull().references(() => user.id),
    event: text("event").notNull(),
    requestId: uuid("request_id").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("curriculum_publication_event_request_unique").on(table.courseId, table.requestId),
    index("curriculum_publication_event_timeline_idx").on(table.courseId, table.occurredAt),
    check("curriculum_publication_event_type_check", sql`${table.event} IN ('candidate_staged', 'evidence_submitted', 'published_beta', 'promoted_verified', 'rolled_back', 'retired')`),
    check("curriculum_publication_event_reason_length", sql`char_length(${table.reason}) BETWEEN 20 AND 2000`),
    check("curriculum_publication_event_evidence_object_check", sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check("curriculum_publication_event_hash_check", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const enrollment = pgTable(
  "enrollment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    courseVersionId: uuid("course_version_id")
      .notNull()
      .references(() => courseVersion.id),
    implementationLanguage: text("implementation_language"),
    status: enrollmentStatusEnum("status").default("planned").notNull(),
    source: text("source").default("self").notNull(),
    placementScore: real("placement_score"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("enrollment_user_status_idx").on(table.userId, table.status),
    index("enrollment_course_version_idx").on(table.courseVersionId),
    uniqueIndex("enrollment_id_user_unique").on(table.id, table.userId),
  ],
);

export const planRevision = pgTable(
  "plan_revision",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => enrollment.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    parentId: uuid("parent_id"),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    policyVersion: text("policy_version").notNull(),
    requestHash: text("request_hash"),
    createdBy: text("created_by").references(() => user.id),
    plan: jsonb("plan").$type<Array<Record<string, unknown>>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("plan_revision_unique").on(table.enrollmentId, table.revision),
    check(
      "plan_revision_request_hash_check",
      sql`${table.requestHash} IS NULL OR ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const learningSession = pgTable(
  "learning_session",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    enrollmentId: uuid("enrollment_id").references(() => enrollment.id),
    planRevisionId: uuid("plan_revision_id").references(() => planRevision.id),
    goal: text("goal").notNull(),
    plannedMinutes: integer("planned_minutes").notNull(),
    reviewOnly: boolean("review_only").default(false).notNull(),
    status: text("status").default("active").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
  },
  (table) => [index("learning_session_user_idx").on(table.userId, table.status)],
);

export const sessionEvent = pgTable(
  "learning_session_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => learningSession.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id),
    clientEventId: text("client_event_id").notNull(),
    type: text("type").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    clientTime: timestamp("client_time", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("session_event_idempotency").on(table.userId, table.clientEventId),
    index("learning_session_event_session_idx").on(table.sessionId),
  ],
);

/**
 * The browser keeps only a session-scoped working copy. This row is the
 * authoritative, account-owned copy of a learner's lesson or code draft.
 * `row_version` is compared on every mutation so an offline tab cannot erase
 * work saved by a newer tab or device.
 */
export const learnerDraft = pgTable(
  "learner_draft",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    courseId: text("course_id").notNull(),
    skillId: text("skill_id").notNull(),
    language: text("language"),
    content: text("content").notNull(),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("learner_draft_scope_unique").on(
      table.userId,
      table.kind,
      table.courseId,
      table.skillId,
      sql`coalesce(${table.language}, '')`,
    ),
    index("learner_draft_user_updated_idx").on(table.userId, table.updatedAt),
    check("learner_draft_kind_check", sql`${table.kind} IN ('code', 'lesson')`),
    check("learner_draft_course_id_length", sql`char_length(${table.courseId}) BETWEEN 1 AND 100`),
    check("learner_draft_skill_id_length", sql`char_length(${table.skillId}) BETWEEN 1 AND 180`),
    check("learner_draft_language_length", sql`${table.language} IS NULL OR char_length(${table.language}) BETWEEN 1 AND 40`),
    check(
      "learner_draft_kind_language_check",
      sql`(${table.kind} = 'lesson' AND ${table.language} IS NULL) OR (${table.kind} = 'code' AND ${table.language} IS NOT NULL)`,
    ),
    check("learner_draft_content_size", sql`octet_length(${table.content}) <= 131072`),
    check("learner_draft_row_version_positive", sql`${table.rowVersion} >= 1`),
  ],
);

/**
 * Durable idempotency receipts make any accepted request replayable even
 * after later edits. A receipt never contains draft text, only a keyed hash
 * and the version transition it committed.
 */
export const learnerDraftMutation = pgTable(
  "learner_draft_mutation",
  {
    requestId: uuid("request_id").primaryKey(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => learnerDraft.id, { onDelete: "cascade" }),
    inputHash: text("input_hash").notNull(),
    expectedRowVersion: bigint("expected_row_version", { mode: "number" }).notNull(),
    resultingRowVersion: bigint("resulting_row_version", { mode: "number" }).notNull(),
    resultingUpdatedAt: timestamp("resulting_updated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("learner_draft_mutation_draft_created_idx").on(table.draftId, table.createdAt),
    check("learner_draft_mutation_hash_shape", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("learner_draft_mutation_expected_version_nonnegative", sql`${table.expectedRowVersion} >= 0`),
    check("learner_draft_mutation_resulting_version_positive", sql`${table.resultingRowVersion} >= 1`),
    check(
      "learner_draft_mutation_version_transition",
      sql`${table.resultingRowVersion} = ${table.expectedRowVersion} + 1`,
    ),
  ],
);

export const conceptMastery = pgTable(
  "concept_mastery",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => enrollment.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id").notNull().references(() => concept.id),
    languageContext: text("language_context").default("conceptual").notNull(),
    score: real("score").default(0).notNull(),
    confidence: real("confidence").default(0).notNull(),
    status: masteryStatusEnum("status").default("unseen").notNull(),
    criticalRequirementsMet: boolean("critical_requirements_met").default(false).notNull(),
    lastEvidenceAt: timestamp("last_evidence_at", { withTimezone: true }),
    lastPracticedAt: timestamp("last_practiced_at", { withTimezone: true }),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    policyVersion: text("policy_version").notNull(),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.enrollmentId, table.conceptId, table.languageContext],
    }),
    check("mastery_score_range", sql`${table.score} >= 0 AND ${table.score} <= 1`),
    check(
      "mastery_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    index("mastery_review_idx").on(table.userId, table.nextReviewAt),
  ],
);

export const masteryEvidence = pgTable(
  "mastery_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    enrollmentId: uuid("enrollment_id").notNull().references(() => enrollment.id),
    conceptId: uuid("concept_id").notNull().references(() => concept.id),
    languageContext: text("language_context").default("conceptual").notNull(),
    evidenceType: text("evidence_type").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    score: real("score").notNull(),
    weight: real("weight").notNull(),
    criticalCriterion: text("critical_criterion"),
    validity: text("validity").default("valid").notNull(),
    policyVersion: text("policy_version").notNull(),
    recordedBy: text("recorded_by"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("mastery_evidence_reward_owner_unique").on(
      table.id,
      table.userId,
      table.enrollmentId,
    ),
    uniqueIndex("mastery_evidence_source_unique").on(
      table.userId,
      table.sourceType,
      table.sourceId,
      table.conceptId,
      table.criticalCriterion,
    ),
  ],
);

export const reviewSchedule = pgTable(
  "review_schedule",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    enrollmentId: uuid("enrollment_id").notNull().references(() => enrollment.id),
    conceptId: uuid("concept_id").notNull().references(() => concept.id),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    intervalDays: integer("interval_days").notNull(),
    easeFactor: real("ease_factor").default(2.5).notNull(),
    reason: text("reason").notNull(),
    status: text("status").default("scheduled").notNull(),
    sourceEvidenceId: uuid("source_evidence_id").references(() => masteryEvidence.id),
    completedAttemptId: uuid("completed_attempt_id"),
    ...timestamps,
  },
  (table) => [index("review_due_idx").on(table.userId, table.status, table.dueAt)],
);

export const attempt = pgTable(
  "attempt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    activityId: uuid("activity_id").references(() => activity.id),
    enrollmentId: uuid("enrollment_id").references(() => enrollment.id),
    kind: attemptKindEnum("kind").notNull(),
    attemptNumber: integer("attempt_number").default(1).notNull(),
    status: attemptStatusEnum("status").default("created").notNull(),
    policyVersion: text("policy_version").notNull(),
    contentVersion: text("content_version").notNull(),
    score: real("score"),
    passed: boolean("passed"),
    masteryAwarded: boolean("mastery_awarded").default(false),
    infrastructureFailure: boolean("infrastructure_failure").default(false).notNull(),
    assistanceLevel: text("assistance_level").default("A0").notNull(),
    solutionRevealed: boolean("solution_revealed").default(false).notNull(),
    helpStep: integer("help_step").default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    gradedAt: timestamp("graded_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("attempt_user_time_idx").on(table.userId, table.createdAt),
    index("attempt_activity_idx").on(table.activityId),
    index("attempt_enrollment_idx").on(table.enrollmentId),
    uniqueIndex("attempt_reward_owner_unique").on(
      table.id,
      table.userId,
      table.enrollmentId,
    ),
    uniqueIndex("attempt_daily_review_binding_unique").on(
      table.id,
      table.userId,
      table.activityId,
      table.enrollmentId,
    ),
    check("attempt_assistance_level_check", sql`${table.assistanceLevel} in ('A0', 'A1', 'A2', 'A3', 'A4')`),
    check("attempt_help_step_check", sql`${table.helpStep} >= 0 and ${table.helpStep} <= 64`),
    check("attempt_solution_assistance_check", sql`not ${table.solutionRevealed} or ${table.assistanceLevel} = 'A4'`),
  ],
);

/**
 * One immutable learner-local daily review allocation. A ready session is
 * created only when five eligible, independently human-reviewed skills can be
 * reserved in the same transaction. Unavailable sessions intentionally carry
 * zero questions so draft content can never be used to fill a quota.
 */
export const dailyReviewSession = pgTable(
  "daily_review_session",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    localDate: text("local_date").notNull(),
    timezone: text("timezone").notNull(),
    status: text("status").notNull(),
    availableItemCount: integer("available_item_count").default(0).notNull(),
    questionCount: integer("question_count").default(0).notNull(),
    completedCount: integer("completed_count").default(0).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("daily_review_session_user_date_unique").on(table.userId, table.localDate),
    uniqueIndex("daily_review_session_id_user_unique").on(table.id, table.userId),
    index("daily_review_session_user_status_idx").on(table.userId, table.status, table.localDate),
    check("daily_review_session_local_date_check", sql`${table.localDate} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    check("daily_review_session_timezone_length_check", sql`char_length(${table.timezone}) BETWEEN 1 AND 100`),
    check("daily_review_session_status_check", sql`${table.status} IN ('ready', 'completed', 'unavailable')`),
    check("daily_review_session_available_count_check", sql`${table.availableItemCount} BETWEEN 0 AND 100000`),
    check("daily_review_session_question_count_check", sql`${table.questionCount} IN (0, 5)`),
    check("daily_review_session_completed_count_check", sql`${table.completedCount} BETWEEN 0 AND ${table.questionCount}`),
    check(
      "daily_review_session_state_shape_check",
      sql`(${table.status} = 'unavailable' AND ${table.questionCount} = 0 AND ${table.completedCount} = 0 AND ${table.completedAt} IS NULL)
        OR (${table.status} = 'ready' AND ${table.questionCount} = 5 AND ${table.completedCount} BETWEEN 0 AND 4 AND ${table.completedAt} IS NULL)
        OR (${table.status} = 'completed' AND ${table.questionCount} = 5 AND ${table.completedCount} = 5 AND ${table.completedAt} IS NOT NULL)`,
    ),
    check("daily_review_session_row_version_check", sql`${table.rowVersion} >= 1`),
  ],
);

/** A durable, owner-bound slot in a daily review session. */
export const dailyReviewItem = pgTable(
  "daily_review_item",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => dailyReviewSession.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    skillId: text("skill_id").notNull(),
    skillTitle: text("skill_title").notNull(),
    courseSlug: text("course_slug").notNull(),
    courseTitle: text("course_title").notNull(),
    conceptId: uuid("concept_id").notNull().references(() => concept.id),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => enrollment.id, { onDelete: "cascade" }),
    priorityReason: text("priority_reason").notNull(),
    confidence: real("confidence").default(0).notNull(),
    status: text("status").default("pending").notNull(),
    activityId: uuid("activity_id").references(() => activity.id, { onDelete: "set null" }),
    attemptId: uuid("attempt_id").references(() => attempt.id, { onDelete: "set null" }),
    score: real("score"),
    passed: boolean("passed"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("daily_review_item_session_position_unique").on(table.sessionId, table.position),
    uniqueIndex("daily_review_item_session_skill_unique").on(table.sessionId, table.skillId),
    uniqueIndex("daily_review_item_attempt_unique").on(table.attemptId),
    uniqueIndex("daily_review_item_session_activity_unique")
      .on(table.sessionId, table.activityId)
      .where(sql`${table.activityId} IS NOT NULL`),
    index("daily_review_item_owner_session_idx").on(table.userId, table.sessionId, table.position),
    foreignKey({
      name: "daily_review_item_session_owner_fk",
      columns: [table.sessionId, table.userId],
      foreignColumns: [dailyReviewSession.id, dailyReviewSession.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "daily_review_item_enrollment_owner_fk",
      columns: [table.enrollmentId, table.userId],
      foreignColumns: [enrollment.id, enrollment.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "daily_review_item_attempt_binding_fk",
      columns: [table.attemptId, table.userId, table.activityId, table.enrollmentId],
      foreignColumns: [attempt.id, attempt.userId, attempt.activityId, attempt.enrollmentId],
    }),
    check("daily_review_item_position_check", sql`${table.position} BETWEEN 1 AND 5`),
    check("daily_review_item_skill_length_check", sql`char_length(${table.skillId}) BETWEEN 1 AND 180`),
    check("daily_review_item_title_length_check", sql`char_length(${table.skillTitle}) BETWEEN 1 AND 500`),
    check("daily_review_item_course_slug_length_check", sql`char_length(${table.courseSlug}) BETWEEN 1 AND 100`),
    check("daily_review_item_course_title_length_check", sql`char_length(${table.courseTitle}) BETWEEN 1 AND 500`),
    check("daily_review_item_priority_check", sql`${table.priorityReason} IN ('confirmed_misconception', 'overdue_review', 'lowest_confidence')`),
    check("daily_review_item_confidence_check", sql`${table.confidence} BETWEEN 0 AND 1`),
    check("daily_review_item_status_check", sql`${table.status} IN ('pending', 'answered')`),
    check("daily_review_item_score_check", sql`${table.score} IS NULL OR (${table.score} >= 0 AND ${table.score} <= 1)`),
    check(
      "daily_review_item_answer_shape_check",
      sql`(${table.status} = 'pending' AND ${table.score} IS NULL AND ${table.passed} IS NULL AND ${table.answeredAt} IS NULL)
        OR (${table.status} = 'answered' AND ${table.attemptId} IS NOT NULL AND ${table.score} IS NOT NULL AND ${table.passed} IS NOT NULL AND ${table.answeredAt} IS NOT NULL)`,
    ),
  ],
);

export const practiceHelpEvent = pgTable(
  "practice_help_event",
  {
    id: uuid("id").primaryKey(),
    attemptId: uuid("attempt_id").notNull().references(() => attempt.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    step: integer("step").notNull(),
    kind: text("kind").notNull(),
    assistanceLevel: text("assistance_level").notNull(),
    solutionRevealed: boolean("solution_revealed").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("practice_help_event_user_request_unique").on(table.userId, table.requestId),
    uniqueIndex("practice_help_event_attempt_step_unique").on(table.attemptId, table.step),
    index("practice_help_event_user_time_idx").on(table.userId, table.createdAt),
    check("practice_help_event_step_check", sql`${table.step} > 0 and ${table.step} <= 64`),
    check("practice_help_event_kind_check", sql`${table.kind} in ('hint', 'alternate', 'example', 'solution')`),
    check("practice_help_event_assistance_check", sql`${table.assistanceLevel} in ('A1', 'A2', 'A3', 'A4')`),
    check("practice_help_event_solution_check", sql`(${table.kind} = 'solution') = ${table.solutionRevealed}`),
  ],
);

export const response = pgTable(
  "response",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempt.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    revision: integer("revision").default(1).notNull(),
    answer: jsonb("answer").$type<Record<string, unknown>>().notNull(),
    source: text("source").default("browser").notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).defaultNow().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("response_revision_unique").on(table.attemptId, table.itemKey, table.revision)],
);

export const codeSubmission = pgTable(
  "code_submission",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    attemptId: uuid("attempt_id").references(() => attempt.id),
    activityId: uuid("activity_id").references(() => activity.id),
    language: text("language").notNull(),
    sourceCode: text("source_code").notNull(),
    sourceHash: text("source_hash").notNull(),
    submissionType: text("submission_type").notNull(),
    requestId: text("request_id")
      .default(sql`'legacy-' || gen_random_uuid()::text`)
      .notNull(),
    requestHash: text("request_hash")
      .default(sql`repeat('0', 64)`)
      .notNull(),
    runtimeImageDigest: text("runtime_image_digest").notNull(),
    testBundleId: uuid("test_bundle_id").references(() => testBundle.id),
    status: jobStatusEnum("status").default("queued").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("submission_user_time_idx").on(table.userId, table.createdAt),
    index("code_submission_attempt_idx").on(table.attemptId),
    index("code_submission_activity_idx").on(table.activityId),
    index("code_submission_test_bundle_idx").on(table.testBundleId),
    uniqueIndex("code_submission_user_request_unique").on(table.userId, table.requestId),
    uniqueIndex("code_submission_one_active_official_user")
      .on(table.userId)
      .where(sql`${table.submissionType} IN ('exam_final_test', 'assessment_correction_regrade')
        AND ${table.status} IN ('queued', 'leased', 'running')`),
    check(
      "code_submission_request_id_shape",
      sql`char_length(${table.requestId}) BETWEEN 8 AND 128 AND ${table.requestId} ~ '^[A-Za-z0-9._:-]+$'`,
    ),
    check("code_submission_request_hash_shape", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const runnerJob = pgTable(
  "runner_job",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => codeSubmission.id, { onDelete: "cascade" }),
    status: jobStatusEnum("status").default("queued").notNull(),
    priority: integer("priority").default(100).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    limits: jsonb("limits").$type<Record<string, number>>().notNull(),
    dispatchRequest: jsonb("dispatch_request").$type<Record<string, unknown>>(),
    recoveryState: text("recovery_state"),
    recoveryAttemptCount: integer("recovery_attempt_count").default(0).notNull(),
    recoveryNextAttemptAt: timestamp("recovery_next_attempt_at", { withTimezone: true }),
    recoveryLastErrorCode: text("recovery_last_error_code"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("runner_job_submission_unique").on(table.submissionId),
    index("runner_queue_idx").on(table.status, table.priority, table.queuedAt),
    index("runner_practice_recovery_due_idx").on(table.recoveryState, table.recoveryNextAttemptAt),
    check(
      "runner_job_dispatch_request_shape",
      sql`${table.dispatchRequest} is null or (jsonb_typeof(${table.dispatchRequest}) = 'object' and octet_length(${table.dispatchRequest}::text) <= 1048576)`,
    ),
    check(
      "runner_job_recovery_state_check",
      sql`${table.recoveryState} is null or ${table.recoveryState} in ('ready','retry_wait','quarantined')`,
    ),
    check("runner_job_recovery_attempt_check", sql`${table.recoveryAttemptCount} >= 0`),
    check(
      "runner_job_recovery_snapshot_check",
      sql`${table.recoveryState} is null or ${table.dispatchRequest} is not null or (
        ${table.recoveryState} = 'quarantined'
        and ${table.recoveryLastErrorCode} = 'PRACTICE_LEGACY_DISPATCH_SNAPSHOT_MISSING'
      )`,
    ),
  ],
);

/**
 * Root-operated, two-request hold used only by the supervised physical
 * power-loss rehearsal. Ordinary API dispatch claims the pre-authorized slot;
 * the controller later releases the exact persisted jobs to normal recovery.
 */
export const runnerPowerRehearsalEvent = pgTable(
  "runner_power_rehearsal_event",
  {
    id: uuid("id").primaryKey(),
    controlKey: integer("control_key").default(1).notNull(),
    state: text("state").default("armed").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    learnerOneId: text("learner_one_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    learnerTwoId: text("learner_two_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    slotOneRequestId: text("slot_one_request_id"),
    slotOneSubmissionId: uuid("slot_one_submission_id")
      .references(() => codeSubmission.id, { onDelete: "restrict" }),
    slotOneRunnerJobId: uuid("slot_one_runner_job_id")
      .references(() => runnerJob.id, { onDelete: "restrict" }),
    slotTwoRequestId: text("slot_two_request_id"),
    slotTwoSubmissionId: uuid("slot_two_submission_id")
      .references(() => codeSubmission.id, { onDelete: "restrict" }),
    slotTwoRunnerJobId: uuid("slot_two_runner_job_id")
      .references(() => runnerJob.id, { onDelete: "restrict" }),
    filledAt: timestamp("filled_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    abortedAt: timestamp("aborted_at", { withTimezone: true }),
    terminalCommandId: uuid("terminal_command_id"),
    terminalCommandHash: char("terminal_command_hash", { length: 64 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("runner_power_rehearsal_single_active_unique")
      .on(table.controlKey)
      .where(sql`${table.state} in ('armed','filled')`),
    index("runner_power_rehearsal_learner_one_idx").on(table.learnerOneId, table.createdAt),
    index("runner_power_rehearsal_learner_two_idx").on(table.learnerTwoId, table.createdAt),
    check("runner_power_rehearsal_control_key_check", sql`${table.controlKey} = 1`),
    check(
      "runner_power_rehearsal_state_check",
      sql`${table.state} in ('armed','filled','released','aborted')`,
    ),
    check(
      "runner_power_rehearsal_distinct_learners_check",
      sql`${table.learnerOneId} <> ${table.learnerTwoId}`,
    ),
    check(
      "runner_power_rehearsal_reason_length_check",
      sql`char_length(${table.reason}) between 20 and 500`,
    ),
    check(
      "runner_power_rehearsal_expiry_window_check",
      sql`${table.expiresAt} >= ${table.createdAt} + interval '5 minutes'
        and ${table.expiresAt} <= ${table.createdAt} + interval '120 minutes'`,
    ),
    check(
      "runner_power_rehearsal_slot_one_atomic_check",
      sql`(${table.slotOneRequestId} is null and ${table.slotOneSubmissionId} is null and ${table.slotOneRunnerJobId} is null)
        or (${table.slotOneRequestId} is not null and ${table.slotOneSubmissionId} is not null and ${table.slotOneRunnerJobId} is not null)`,
    ),
    check(
      "runner_power_rehearsal_slot_two_atomic_check",
      sql`(${table.slotTwoRequestId} is null and ${table.slotTwoSubmissionId} is null and ${table.slotTwoRunnerJobId} is null)
        or (${table.slotTwoRequestId} is not null and ${table.slotTwoSubmissionId} is not null and ${table.slotTwoRunnerJobId} is not null)`,
    ),
    check(
      "runner_power_rehearsal_distinct_slots_check",
      sql`${table.slotOneRequestId} is null or ${table.slotTwoRequestId} is null or (
        ${table.slotOneRequestId} <> ${table.slotTwoRequestId}
        and ${table.slotOneSubmissionId} <> ${table.slotTwoSubmissionId}
        and ${table.slotOneRunnerJobId} <> ${table.slotTwoRunnerJobId}
      )`,
    ),
    check(
      "runner_power_rehearsal_request_one_shape_check",
      sql`${table.slotOneRequestId} is null or ${table.slotOneRequestId} ~ '^[0-9a-fA-F-]{36}$'`,
    ),
    check(
      "runner_power_rehearsal_request_two_shape_check",
      sql`${table.slotTwoRequestId} is null or ${table.slotTwoRequestId} ~ '^[0-9a-fA-F-]{36}$'`,
    ),
    check(
      "runner_power_rehearsal_filled_state_check",
      sql`${table.state} not in ('filled','released') or (
        ${table.slotOneRequestId} is not null and ${table.slotTwoRequestId} is not null and ${table.filledAt} is not null
      )`,
    ),
    check(
      "runner_power_rehearsal_terminal_state_check",
      sql`(
        ${table.state} in ('armed','filled') and ${table.releasedAt} is null and ${table.abortedAt} is null
          and ${table.terminalCommandId} is null and ${table.terminalCommandHash} is null
      ) or (
        ${table.state} = 'released' and ${table.releasedAt} is not null and ${table.abortedAt} is null
          and ${table.terminalCommandId} is not null and ${table.terminalCommandHash} ~ '^[0-9a-f]{64}$'
      ) or (
        ${table.state} = 'aborted' and ${table.abortedAt} is not null and ${table.releasedAt} is null
          and ${table.terminalCommandId} is not null and ${table.terminalCommandHash} ~ '^[0-9a-f]{64}$'
      )`,
    ),
  ],
);

export const examSession = pgTable(
  "exam_session",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempt.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id),
    status: examStatusEnum("status").default("scheduled").notNull(),
    serverStartedAt: timestamp("server_started_at", { withTimezone: true }),
    serverDeadlineAt: timestamp("server_deadline_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    disconnectedSeconds: integer("disconnected_seconds").default(0).notNull(),
    integrityReviewState: text("integrity_review_state").default("not_required").notNull(),
    finalizedBy: text("finalized_by"),
    ...timestamps,
  },
  (table) => [uniqueIndex("exam_attempt_unique").on(table.attemptId)],
);

export const examAutosaveMutation = pgTable(
  "exam_autosave_mutation",
  {
    examSessionId: uuid("exam_session_id")
      .notNull()
      .references(() => examSession.id, { onDelete: "cascade" }),
    clientMutationId: uuid("client_mutation_id").notNull(),
    itemKey: text("item_key").notNull(),
    inputHash: char("input_hash", { length: 64 }).notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    resultingSavedAt: timestamp("resulting_saved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "exam_autosave_mutation_pk",
      columns: [table.examSessionId, table.clientMutationId],
    }),
    index("exam_autosave_mutation_session_item_created_idx").on(
      table.examSessionId,
      table.itemKey,
      table.createdAt,
    ),
    check("exam_autosave_mutation_input_hash_check", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("exam_autosave_mutation_expected_revision_nonnegative", sql`${table.expectedRevision} >= 0`),
    check("exam_autosave_mutation_resulting_revision_nonnegative", sql`${table.resultingRevision} >= 0`),
    check(
      "exam_autosave_mutation_revision_transition",
      sql`${table.resultingRevision} = ${table.expectedRevision} + 1`,
    ),
  ],
);

export const examEvent = pgTable(
  "exam_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    examSessionId: uuid("exam_session_id")
      .notNull()
      .references(() => examSession.id, { onDelete: "cascade" }),
    clientEventId: text("client_event_id").notNull(),
    type: text("type").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("exam_event_idempotency").on(table.examSessionId, table.clientEventId)],
);

/** Durable deadline/recovery work; the result response remains official truth. */
export const examFinalizationJob = pgTable(
  "exam_finalization_job",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    examSessionId: uuid("exam_session_id")
      .notNull()
      .references(() => examSession.id, { onDelete: "cascade" }),
    status: text("status").default("scheduled").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    runnerRequestGeneration: integer("runner_request_generation").default(1).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("exam_finalization_job_session_unique").on(table.examSessionId),
    index("exam_finalization_job_due_idx").on(table.status, table.dueAt),
    check("exam_finalization_job_status_check", sql`${table.status} in ('scheduled','leased','succeeded','failed')`),
    check("exam_finalization_job_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check("exam_finalization_job_runner_generation_check", sql`${table.runnerRequestGeneration} >= 1`),
  ],
);

/** One-use human grant bound to immutable outage evidence and its source form. */
export const examReexamGrant = pgTable(
  "exam_reexam_grant",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    sourceExamSessionId: uuid("source_exam_session_id")
      .notNull()
      .references(() => examSession.id, { onDelete: "cascade" }),
    moduleId: text("module_id").notNull(),
    grantedByUserId: text("granted_by_user_id").references(() => user.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    status: text("status").default("available").notNull(),
    consumedByAttemptId: uuid("consumed_by_attempt_id").references(() => attempt.id),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("exam_reexam_grant_request_unique").on(table.requestId),
    uniqueIndex("exam_reexam_grant_source_unique").on(table.sourceExamSessionId),
    index("exam_reexam_grant_available_idx").on(table.userId, table.moduleId, table.status),
    check("exam_reexam_grant_status_check", sql`${table.status} in ('available','consumed','revoked')`),
    check("exam_reexam_grant_reason_check", sql`char_length(${table.reason}) between 20 and 2000`),
    check("exam_reexam_grant_evidence_check", sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check("exam_reexam_grant_hash_check", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** A shorter mastery-only check whose failure never supersedes its source pass. */
export const examMasteryRecheck = pgTable(
  "exam_mastery_recheck",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    sourceAttemptId: uuid("source_attempt_id").notNull().references(() => attempt.id, { onDelete: "cascade" }),
    moduleId: text("module_id").notNull(),
    contentVersion: text("content_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    status: text("status").default("scheduled").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    targetClusterIds: text("target_cluster_ids").array().notNull(),
    targetCodingItemIds: text("target_coding_item_ids").array().notNull(),
    recheckAttemptId: uuid("recheck_attempt_id").references(() => attempt.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    resultOutcome: text("result_outcome"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("exam_mastery_recheck_source_unique").on(table.sourceAttemptId),
    uniqueIndex("exam_mastery_recheck_attempt_unique").on(table.recheckAttemptId),
    index("exam_mastery_recheck_user_due_idx").on(table.userId, table.status, table.dueAt),
    check("exam_mastery_recheck_status_check", sql`${table.status} in ('scheduled','available','active','completed')`),
    check("exam_mastery_recheck_targets_check", sql`cardinality(${table.targetClusterIds}) + cardinality(${table.targetCodingItemIds}) > 0`),
  ],
);

export const chatThread = pgTable(
  "chat_thread",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    enrollmentId: uuid("enrollment_id").references(() => enrollment.id),
    title: text("title").notNull(),
    status: text("status").default("active").notNull(),
    ...timestamps,
  },
  (table) => [index("chat_thread_user_idx").on(table.userId, table.updatedAt)],
);

export const chatMessage = pgTable(
  "chat_message",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThread.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    modelCallId: uuid("model_call_id").references(() => modelCall.id),
    curriculumRefs: jsonb("curriculum_refs").$type<string[]>().default([]).notNull(),
    safetyLabels: jsonb("safety_labels").$type<string[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("chat_message_thread_idx").on(table.threadId, table.createdAt)],
);

export const project = pgTable(
  "project",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    status: text("status").default("idea").notNull(),
    visibility: visibilityEnum("visibility").default("private").notNull(),
    prd: jsonb("prd").$type<Record<string, unknown>>(),
    githubUrl: text("github_url"),
    githubCommitSha: text("github_commit_sha"),
    assignmentTemplateId: uuid("assignment_template_id")
      .references(() => moduleProjectTemplate.id, { onDelete: "restrict" }),
    assignmentContentHash: text("assignment_content_hash"),
    assignmentStageAtStart: text("assignment_stage_at_start"),
    assignmentProvenance: jsonb("assignment_provenance").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    index("project_user_idx").on(table.userId, table.updatedAt),
    uniqueIndex("project_id_user_unique").on(table.id, table.userId),
    uniqueIndex("project_user_assignment_unique")
      .on(table.userId, table.assignmentTemplateId)
      .where(sql`${table.assignmentTemplateId} IS NOT NULL`),
    index("project_assignment_template_idx").on(table.assignmentTemplateId),
    check(
      "project_assignment_shape",
      sql`(${table.assignmentTemplateId} IS NULL AND ${table.assignmentContentHash} IS NULL AND ${table.assignmentStageAtStart} IS NULL AND ${table.assignmentProvenance} IS NULL)
        OR (${table.assignmentTemplateId} IS NOT NULL AND ${table.assignmentContentHash} ~ '^[0-9a-f]{64}$' AND ${table.assignmentStageAtStart} IN ('beta','verified') AND jsonb_typeof(${table.assignmentProvenance}) = 'object')`,
    ),
  ],
);

/**
 * Content-free durable receipt for one learner starting one reviewed module
 * brief. It binds retries to the same owner, template, immutable project, and
 * exact payload hash without retaining request text.
 */
export const moduleProjectStartReceipt = pgTable(
  "module_project_start_receipt",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => moduleProjectTemplate.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").notNull(),
    inputHash: text("input_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.requestId] }),
    index("module_project_start_receipt_project_idx").on(table.projectId, table.createdAt),
    index("module_project_start_receipt_template_idx").on(table.templateId, table.createdAt),
    foreignKey({
      name: "module_project_start_receipt_project_owner_fk",
      columns: [table.projectId, table.userId],
      foreignColumns: [project.id, project.userId],
    }).onDelete("cascade"),
    check("module_project_start_receipt_input_hash", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const projectReview = pgTable("project_review", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  commitSha: text("commit_sha").notNull(),
  analyzerVersion: text("analyzer_version").notNull(),
  rubricVersion: text("rubric_version").default("static-project-review-rubric-v1").notNull(),
  modelCallId: uuid("model_call_id").references(() => modelCall.id),
  analysisProvenance: jsonb("analysis_provenance")
    .$type<Record<string, unknown>>()
    .default(sql`'{"schemaVersion":1,"analysisMode":"deterministic_static","aiUsed":false,"promptVersion":null,"provider":null,"model":null,"modelCallId":null,"rubricVersion":"static-project-review-rubric-v1","repositoryExecution":"none","runnerTemplateId":null}'::jsonb`)
    .notNull(),
  findings: jsonb("findings").$type<Array<Record<string, unknown>>>().notNull(),
  findingsHash: text("findings_hash"),
  status: text("status").default("complete").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("project_review_project_idx").on(table.projectId),
  check("project_review_provenance_object", sql`jsonb_typeof(${table.analysisProvenance}) = 'object'`),
  check("project_review_findings_array", sql`jsonb_typeof(${table.findings}) = 'array'`),
  check(
    "project_review_findings_hash",
    sql`${table.findingsHash} IS NULL OR ${table.findingsHash} ~ '^[0-9a-f]{64}$'`,
  ),
]);

export const storedObject = pgTable(
  "stored_object",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => project.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull().unique(),
    originalName: text("original_name").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    retentionClass: text("retention_class").default("user_upload").notNull(),
    scanStatus: text("scan_status").default("pending").notNull(),
    scanAttempts: integer("scan_attempts").default(0).notNull(),
    scanLeaseToken: text("scan_lease_token"),
    scanLeaseExpiresAt: timestamp("scan_lease_expires_at", { withTimezone: true }),
    scanNextAttemptAt: timestamp("scan_next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    scanErrorCode: text("scan_error_code"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("stored_object_owner_idx").on(table.ownerUserId, table.deletedAt),
    index("stored_object_retention_idx").on(
      table.retentionClass,
      table.scanStatus,
      table.createdAt,
    ),
    index("stored_object_scan_queue_idx").on(
      table.scanStatus,
      table.scanNextAttemptAt,
      table.scanLeaseExpiresAt,
    ),
    check(
      "stored_object_retention_class_check",
      sql`${table.retentionClass} IN ('user_upload', 'ai_request_attachment', 'temporary')`,
    ),
  ],
);

/**
 * Immutable owner-scoped receipt for crash-safe upload retries. PostgreSQL's
 * UUID type canonicalizes textual case; the versioned request hash binds the
 * key to the validated name/type/size/content tuple.
 */
export const uploadReceipt = pgTable(
  "upload_receipt",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    objectId: uuid("object_id")
      .notNull()
      .references(() => storedObject.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserId, table.idempotencyKey] }),
    uniqueIndex("upload_receipt_object_unique").on(table.objectId),
    check(
      "upload_receipt_request_hash_check",
      sql`${table.requestHash} ~ '^v1:[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * Append-only learner project checkpoint. A revision is created only through
 * the owner-bound project revision service; there is intentionally no update
 * or delete endpoint. `clientRequestId` plus `inputHash` make retries durable,
 * while the per-project sequence is the optimistic-concurrency boundary.
 */
export const projectRevision = pgTable(
  "project_revision",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    clientRequestId: uuid("client_request_id").notNull(),
    inputHash: text("input_hash").notNull(),
    changeSummary: text("change_summary").notNull(),
    reflection: text("reflection"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("project_revision_project_sequence_unique").on(table.projectId, table.sequence),
    uniqueIndex("project_revision_request_unique").on(table.projectId, table.clientRequestId),
    index("project_revision_project_created_idx").on(table.projectId, table.createdAt),
    check("project_revision_sequence_positive", sql`${table.sequence} >= 1`),
    check("project_revision_input_hash_shape", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "project_revision_summary_length",
      sql`char_length(${table.changeSummary}) BETWEEN 10 AND 1000`,
    ),
    check(
      "project_revision_reflection_length",
      sql`${table.reflection} IS NULL OR char_length(${table.reflection}) BETWEEN 1 AND 4000`,
    ),
  ],
);

/**
 * Immutable metadata snapshot for a safe stored object associated with one
 * project revision. The nullable object reference may disappear during file
 * erasure, but the learner's historical filename/hash/size evidence remains
 * until the project or account is deleted. No quota row is created here.
 */
export const projectRevisionObject = pgTable(
  "project_revision_object",
  {
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => projectRevision.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    objectId: uuid("object_id").references(() => storedObject.id, { onDelete: "set null" }),
    originalName: text("original_name").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.ordinal] }),
    uniqueIndex("project_revision_object_revision_object_unique").on(table.revisionId, table.objectId),
    index("project_revision_object_object_idx").on(table.objectId),
    check("project_revision_object_ordinal_range", sql`${table.ordinal} BETWEEN 0 AND 19`),
    check("project_revision_object_name_length", sql`char_length(${table.originalName}) BETWEEN 1 AND 255`),
    check("project_revision_object_media_type_length", sql`char_length(${table.mediaType}) BETWEEN 1 AND 120`),
    check("project_revision_object_size_nonnegative", sql`${table.sizeBytes} >= 0`),
    check("project_revision_object_sha256_shape", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const quotaLedger = pgTable(
  "quota_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    objectId: uuid("object_id").references(() => storedObject.id),
    operation: text("operation").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("quota_idempotency_unique").on(table.userId, table.idempotencyKey),
    index("quota_user_time_idx").on(table.userId, table.occurredAt),
  ],
);

/**
 * Durable idempotency and evidence record for an administrator quota change.
 * A retried request returns this exact result instead of applying a second
 * mutation or failing against the already-incremented profile row version.
 */
export const storageQuotaChange = pgTable(
  "storage_quota_change",
  {
    requestId: uuid("request_id").primaryKey(),
    actorUserId: text("actor_user_id").notNull().references(() => user.id),
    learnerUserId: text("learner_user_id").notNull().references(() => user.id),
    learnerPublicId: uuid("learner_public_id").notNull(),
    requestedBytes: bigint("requested_bytes", { mode: "number" }).notNull(),
    expectedRowVersion: bigint("expected_row_version", { mode: "number" }).notNull(),
    previousQuotaBytes: bigint("previous_quota_bytes", { mode: "number" }).notNull(),
    previousRowVersion: bigint("previous_row_version", { mode: "number" }).notNull(),
    usedBytesAtChange: bigint("used_bytes_at_change", { mode: "number" }).notNull(),
    resultingRowVersion: bigint("resulting_row_version", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("storage_quota_change_actor_time_idx").on(table.actorUserId, table.createdAt),
    index("storage_quota_change_learner_time_idx").on(table.learnerUserId, table.createdAt),
    check(
      "storage_quota_change_requested_bytes_check",
      sql`${table.requestedBytes} BETWEEN 2147483648 AND 3221225472`,
    ),
    check(
      "storage_quota_change_versions_check",
      sql`${table.expectedRowVersion} >= 0 AND ${table.previousRowVersion} >= 0 AND ${table.resultingRowVersion} = ${table.previousRowVersion} + 1`,
    ),
    check(
      "storage_quota_change_usage_check",
      sql`${table.usedBytesAtChange} >= 0 AND ${table.requestedBytes} >= ${table.usedBytesAtChange}`,
    ),
    check(
      "storage_quota_change_previous_quota_check",
      sql`${table.previousQuotaBytes} BETWEEN 2147483648 AND 3221225472`,
    ),
    check(
      "storage_quota_change_reason_length",
      sql`char_length(${table.reason}) BETWEEN 8 AND 500`,
    ),
    check(
      "storage_quota_change_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const achievement = pgTable("achievement", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  icon: text("icon").notNull(),
  ruleVersion: text("rule_version").notNull(),
  rule: jsonb("rule").$type<Record<string, unknown>>().notNull(),
  ...timestamps,
});

export const userAchievement = pgTable(
  "user_achievement",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    achievementId: uuid("achievement_id")
      .notNull()
      .references(() => achievement.id),
    evidenceId: text("evidence_id").notNull(),
    visibility: visibilityEnum("visibility").default("private").notNull(),
    awardedAt: timestamp("awarded_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("user_achievement_unique").on(table.userId, table.achievementId, table.evidenceId),
    uniqueIndex("user_achievement_id_user_unique").on(table.id, table.userId),
  ],
);

/**
 * Immutable reward accounting. Grants and their exact reversals are separate
 * rows; current XP is always the sum of deltas rather than a mutable balance.
 * Every row is bound to one owner/enrollment and one authoritative evidence
 * row. Database triggers added by the migration enforce append-only writes,
 * exact reversal pairs, and one active grant per semantic scope.
 */
export const rewardLedger = pgTable(
  "reward_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    enrollmentId: uuid("enrollment_id").notNull(),
    eventKind: text("event_kind").notNull(),
    rewardCode: text("reward_code").notNull(),
    scopeKey: text("scope_key").notNull(),
    attemptId: uuid("attempt_id"),
    masteryEvidenceId: uuid("mastery_evidence_id"),
    sourceEventId: uuid("source_event_id").references(
      (): AnyPgColumn => rewardLedger.id,
      { onDelete: "cascade" },
    ),
    xpDelta: integer("xp_delta").notNull(),
    coinDelta: integer("coin_delta").default(0).notNull(),
    policyVersion: text("policy_version").notNull(),
    requestId: uuid("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    reason: text("reason").notNull(),
    evidenceOccurredAt: timestamp("evidence_occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("reward_ledger_owner_request_unique").on(table.userId, table.requestId),
    uniqueIndex("reward_ledger_event_owner_unique").on(table.id, table.userId),
    uniqueIndex("reward_ledger_reversal_source_unique")
      .on(table.sourceEventId)
      .where(sql`${table.sourceEventId} IS NOT NULL`),
    index("reward_ledger_owner_time_idx").on(table.userId, table.occurredAt, table.id),
    index("reward_ledger_owner_evidence_time_idx").on(
      table.userId,
      table.evidenceOccurredAt,
      table.id,
    ),
    index("reward_ledger_owner_scope_idx").on(table.userId, table.scopeKey, table.occurredAt),
    foreignKey({
      name: "reward_ledger_enrollment_owner_fk",
      columns: [table.enrollmentId, table.userId],
      foreignColumns: [enrollment.id, enrollment.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "reward_ledger_attempt_owner_fk",
      columns: [table.attemptId, table.userId, table.enrollmentId],
      foreignColumns: [attempt.id, attempt.userId, attempt.enrollmentId],
    }).onDelete("cascade"),
    foreignKey({
      name: "reward_ledger_mastery_owner_fk",
      columns: [table.masteryEvidenceId, table.userId, table.enrollmentId],
      foreignColumns: [masteryEvidence.id, masteryEvidence.userId, masteryEvidence.enrollmentId],
    }).onDelete("cascade"),
    check("reward_ledger_event_kind_check", sql`${table.eventKind} IN ('grant', 'revocation')`),
    check("reward_ledger_reward_code_check", sql`${table.rewardCode} IN ('attempt_completion', 'concept_mastery')`),
    check("reward_ledger_scope_length_check", sql`char_length(${table.scopeKey}) BETWEEN 3 AND 500`),
    check(
      "reward_ledger_evidence_shape_check",
      sql`(${table.attemptId} IS NOT NULL)::int + (${table.masteryEvidenceId} IS NOT NULL)::int = 1`,
    ),
    check(
      "reward_ledger_event_shape_check",
      sql`(${table.eventKind} = 'grant' AND ${table.sourceEventId} IS NULL AND ${table.xpDelta} > 0)
        OR (${table.eventKind} = 'revocation' AND ${table.sourceEventId} IS NOT NULL AND ${table.xpDelta} < 0)`,
    ),
    check("reward_ledger_xp_bounds_check", sql`${table.xpDelta} BETWEEN -1000 AND 1000 AND ${table.xpDelta} <> 0`),
    check("reward_ledger_coins_disabled_check", sql`${table.coinDelta} = 0`),
    check("reward_ledger_policy_length_check", sql`char_length(${table.policyVersion}) BETWEEN 3 AND 100`),
    check("reward_ledger_request_hash_check", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check("reward_ledger_reason_length_check", sql`char_length(${table.reason}) BETWEEN 8 AND 500`),
    check(
      "reward_ledger_evidence_time_check",
      sql`${table.evidenceOccurredAt} <= ${table.occurredAt}`,
    ),
  ],
);

/** Content-free idempotency outcome for reward reconciliation, including no-ops. */
export const rewardOperationReceipt = pgTable(
  "reward_operation_receipt",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    operation: text("operation").notNull(),
    inputHash: text("input_hash").notNull(),
    eventId: uuid("event_id"),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.requestId] }),
    uniqueIndex("reward_operation_receipt_event_unique")
      .on(table.eventId)
      .where(sql`${table.eventId} IS NOT NULL`),
    index("reward_operation_receipt_owner_time_idx").on(table.userId, table.createdAt),
    foreignKey({
      name: "reward_operation_receipt_event_owner_fk",
      columns: [table.eventId, table.userId],
      foreignColumns: [rewardLedger.id, rewardLedger.userId],
    }).onDelete("cascade"),
    check("reward_operation_receipt_operation_check", sql`${table.operation} IN ('reconcile_attempt', 'reconcile_mastery')`),
    check("reward_operation_receipt_hash_check", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("reward_operation_receipt_result_check", sql`jsonb_typeof(${table.result}) = 'object'`),
  ],
);

/**
 * Durable, generation-fenced work projection for reward reconciliation.
 * Source-table triggers enqueue or re-open one row whenever authoritative
 * attempt/mastery evidence changes. The immutable ledger remains the source
 * of truth; this table only makes eventual reconciliation bounded and live.
 */
export const rewardReconciliationJob = pgTable(
  "reward_reconciliation_job",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    attemptId: uuid("attempt_id").references(() => attempt.id, { onDelete: "cascade" }),
    masteryEvidenceId: uuid("mastery_evidence_id").references(() => masteryEvidence.id, {
      onDelete: "cascade",
    }),
    status: text("status").default("pending").notNull(),
    generation: integer("generation").default(1).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("reward_reconciliation_job_attempt_unique")
      .on(table.attemptId)
      .where(sql`${table.attemptId} IS NOT NULL`),
    uniqueIndex("reward_reconciliation_job_mastery_unique")
      .on(table.masteryEvidenceId)
      .where(sql`${table.masteryEvidenceId} IS NOT NULL`),
    index("reward_reconciliation_job_queue_idx").on(
      table.status,
      table.nextAttemptAt,
      table.updatedAt,
    ),
    check(
      "reward_reconciliation_job_operation_check",
      sql`${table.operation} IN ('reconcile_attempt', 'reconcile_mastery')`,
    ),
    check(
      "reward_reconciliation_job_evidence_shape_check",
      sql`(${table.attemptId} IS NOT NULL)::int + (${table.masteryEvidenceId} IS NOT NULL)::int = 1`,
    ),
    check(
      "reward_reconciliation_job_operation_shape_check",
      sql`(${table.operation} = 'reconcile_attempt' AND ${table.attemptId} IS NOT NULL)
        OR (${table.operation} = 'reconcile_mastery' AND ${table.masteryEvidenceId} IS NOT NULL)`,
    ),
    check(
      "reward_reconciliation_job_status_check",
      sql`${table.status} IN ('pending', 'running', 'complete', 'dead_letter')`,
    ),
    check("reward_reconciliation_job_generation_check", sql`${table.generation} >= 1`),
    check("reward_reconciliation_job_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "reward_reconciliation_job_lease_shape_check",
      sql`(${table.status} = 'running' AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
        OR (${table.status} <> 'running' AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
  ],
);

export const learningRequest = pgTable(
  "learning_request",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    requestId: uuid("request_id").defaultRandom().notNull(),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    details: text("details").notNull(),
    status: requestStatusEnum("status").default("pending").notNull(),
    decisionBy: text("decision_by").references(() => user.id),
    decisionReason: text("decision_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("learning_request_status_idx").on(table.status, table.createdAt),
    uniqueIndex("learning_request_user_request_unique").on(table.userId, table.requestId),
  ],
);

export const appeal = pgTable(
  "appeal",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    attemptId: uuid("attempt_id").references(() => attempt.id),
    projectReviewId: uuid("project_review_id").references(() => projectReview.id),
    category: text("category").default("scoring").notNull(),
    submissionRequestId: uuid("submission_request_id").defaultRandom().notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
    evidenceHash: text("evidence_hash").default(sql`repeat('0', 64)`).notNull(),
    status: text("status").default("open").notNull(),
    decision: text("decision"),
    decisionReason: text("decision_reason"),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    index("appeal_status_idx").on(table.status, table.createdAt),
    uniqueIndex("appeal_submission_request_unique").on(table.userId, table.submissionRequestId),
    uniqueIndex("appeal_open_attempt_unique")
      .on(table.attemptId)
      .where(sql`${table.attemptId} IS NOT NULL AND ${table.status} IN ('open', 'needs_learner_input', 'under_review')`),
    uniqueIndex("appeal_open_project_review_unique")
      .on(table.projectReviewId)
      .where(sql`${table.projectReviewId} IS NOT NULL AND ${table.status} IN ('open', 'needs_learner_input', 'under_review')`),
    check(
      "appeal_target_check",
      sql`(CASE WHEN ${table.attemptId} IS NULL THEN 0 ELSE 1 END + CASE WHEN ${table.projectReviewId} IS NULL THEN 0 ELSE 1 END) = 1`,
    ),
    check(
      "appeal_category_check",
      sql`${table.category} IN ('scoring', 'technical', 'integrity', 'accessibility', 'project_finding')`,
    ),
    check(
      "appeal_status_check",
      sql`${table.status} IN ('open', 'under_review', 'needs_learner_input', 'upheld', 'overturned', 'closed')`,
    ),
    check(
      "appeal_decision_check",
      sql`${table.decision} IS NULL OR ${table.decision} IN ('needs_learner_input', 'upheld', 'overturned')`,
    ),
    check("appeal_evidence_hash_check", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
    check("appeal_evidence_object_check", sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check("appeal_row_version_check", sql`${table.rowVersion} >= 1`),
  ],
);

export const appealEvent = pgTable(
  "appeal_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appealId: uuid("appeal_id")
      .notNull()
      .references(() => appeal.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorRole: text("actor_role").notNull(),
    event: text("event").notNull(),
    clientRequestId: uuid("client_request_id").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("appeal_event_request_unique").on(table.appealId, table.clientRequestId),
    index("appeal_event_timeline_idx").on(table.appealId, table.occurredAt),
    check("appeal_event_actor_role_check", sql`${table.actorRole} IN ('learner', 'admin', 'system')`),
    check(
      "appeal_event_type_check",
      sql`${table.event} IN ('submitted', 'learner_response', 'needs_learner_input', 'upheld', 'overturned', 'closed')`,
    ),
    check("appeal_event_reason_length", sql`char_length(${table.reason}) BETWEEN 8 AND 2000`),
    check("appeal_event_evidence_object_check", sql`jsonb_typeof(${table.evidence}) = 'object'`),
  ],
);

/**
 * Mutable lease state plus an immutable completed result for a corrective
 * project re-analysis. The original project_review is never overwritten.
 */
export const projectReviewCorrection = pgTable(
  "project_review_correction",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    sourceReviewId: uuid("source_review_id")
      .notNull()
      .references(() => projectReview.id, { onDelete: "cascade" }),
    sourceAppealId: uuid("source_appeal_id")
      .references(() => appeal.id),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id),
    requestId: uuid("request_id").notNull(),
    revision: integer("revision").notNull(),
    reason: text("reason").notNull(),
    sourceCommitSha: text("source_commit_sha").notNull(),
    sourceAnalyzerVersion: text("source_analyzer_version").notNull(),
    sourceRubricVersion: text("source_rubric_version").notNull(),
    sourceProvenance: jsonb("source_provenance").$type<Record<string, unknown>>().notNull(),
    sourceFindingsHash: text("source_findings_hash").notNull(),
    targetAnalyzerVersion: text("target_analyzer_version").notNull(),
    targetRubricVersion: text("target_rubric_version").notNull(),
    status: jobStatusEnum("status").default("queued").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    lastErrorCode: text("last_error_code"),
    resultFindings: jsonb("result_findings").$type<Array<Record<string, unknown>>>(),
    resultFindingsHash: text("result_findings_hash"),
    resultProvenance: jsonb("result_provenance").$type<Record<string, unknown>>(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    evidenceHash: text("evidence_hash"),
    projectionApplied: boolean("projection_applied"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("project_review_correction_request_unique").on(table.requestedBy, table.requestId),
    uniqueIndex("project_review_correction_appeal_unique")
      .on(table.sourceAppealId)
      .where(sql`${table.sourceAppealId} IS NOT NULL`),
    uniqueIndex("project_review_correction_revision_unique").on(table.projectId, table.revision),
    index("project_review_correction_queue_idx").on(table.status, table.nextAttemptAt, table.createdAt),
    check("project_review_correction_revision_positive", sql`${table.revision} >= 1`),
    check("project_review_correction_reason_length", sql`char_length(${table.reason}) BETWEEN 20 AND 2000`),
    check("project_review_correction_source_sha", sql`${table.sourceCommitSha} ~ '^[0-9a-f]{40}$'`),
    check("project_review_correction_source_hash", sql`${table.sourceFindingsHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "project_review_correction_result_hash",
      sql`${table.resultFindingsHash} IS NULL OR ${table.resultFindingsHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "project_review_correction_evidence_hash",
      sql`${table.evidenceHash} IS NULL OR ${table.evidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("project_review_correction_source_provenance", sql`jsonb_typeof(${table.sourceProvenance}) = 'object'`),
    check(
      "project_review_correction_result_findings",
      sql`${table.resultFindings} IS NULL OR jsonb_typeof(${table.resultFindings}) = 'array'`,
    ),
    check(
      "project_review_correction_result_provenance",
      sql`${table.resultProvenance} IS NULL OR jsonb_typeof(${table.resultProvenance}) = 'object'`,
    ),
    check(
      "project_review_correction_evidence_object",
      sql`${table.evidence} IS NULL OR jsonb_typeof(${table.evidence}) = 'object'`,
    ),
    check(
      "project_review_correction_status",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed')`,
    ),
    check(
      "project_review_correction_completed_shape",
      sql`(${table.status} <> 'succeeded') OR (
        ${table.resultFindings} IS NOT NULL
        AND ${table.resultFindingsHash} IS NOT NULL
        AND ${table.resultProvenance} IS NOT NULL
        AND ${table.evidence} IS NOT NULL
        AND ${table.evidenceHash} IS NOT NULL
        AND ${table.projectionApplied} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
      )`,
    ),
  ],
);

export const projectReviewCorrectionEvent = pgTable(
  "project_review_correction_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    correctionId: uuid("correction_id")
      .notNull()
      .references(() => projectReviewCorrection.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorRole: text("actor_role").notNull(),
    event: text("event").notNull(),
    requestId: uuid("request_id").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("project_review_correction_event_request_unique").on(table.correctionId, table.requestId),
    index("project_review_correction_event_timeline_idx").on(table.correctionId, table.occurredAt),
    check("project_review_correction_event_actor", sql`${table.actorRole} IN ('admin', 'system')`),
    check(
      "project_review_correction_event_type",
      sql`${table.event} IN ('queued', 'retry_queued', 'analysis_started', 'analysis_succeeded', 'analysis_failed', 'projection_applied', 'projection_skipped')`,
    ),
    check("project_review_correction_event_reason", sql`char_length(${table.reason}) BETWEEN 8 AND 2000`),
    check("project_review_correction_event_evidence", sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check("project_review_correction_event_hash", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Mutable read model. Every source review and correction remains immutable. */
export const projectReviewEffective = pgTable(
  "project_review_effective",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => project.id, { onDelete: "cascade" }),
    sourceReviewId: uuid("source_review_id")
      .notNull()
      .references(() => projectReview.id, { onDelete: "cascade" }),
    correctionId: uuid("correction_id")
      .references(() => projectReviewCorrection.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    analyzerVersion: text("analyzer_version").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
    findings: jsonb("findings").$type<Array<Record<string, unknown>>>().notNull(),
    findingsHash: text("findings_hash").notNull(),
    revision: bigint("revision", { mode: "number" }).default(1).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("project_review_effective_source_idx").on(table.sourceReviewId),
    check("project_review_effective_sha", sql`${table.commitSha} ~ '^[0-9a-f]{40}$'`),
    check("project_review_effective_provenance", sql`jsonb_typeof(${table.provenance}) = 'object'`),
    check("project_review_effective_findings", sql`jsonb_typeof(${table.findings}) = 'array'`),
    check("project_review_effective_hash", sql`${table.findingsHash} ~ '^[0-9a-f]{64}$'`),
    check("project_review_effective_revision", sql`${table.revision} >= 1`),
  ],
);

/**
 * Human-reviewed correction of one exact deterministic exam item version.
 * Mutable fields are workflow projections only; the target, replacement,
 * rationale, and review evidence are protected by a database trigger.
 */
export const assessmentCorrection = pgTable(
  "assessment_correction",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceAppealId: uuid("source_appeal_id")
      .references(() => appeal.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull().references(() => user.id),
    createRequestId: uuid("create_request_id").notNull(),
    status: text("status").default("reviewed").notNull(),
    defectKind: text("defect_kind").notNull(),
    reason: text("reason").notNull(),
    courseId: text("course_id").notNull(),
    moduleId: text("module_id").notNull(),
    itemId: text("item_id").notNull(),
    skillId: text("skill_id").notNull(),
    contentVersion: text("content_version").notNull(),
    faultyBundleVersion: text("faulty_bundle_version").notNull(),
    faultyEvidenceHash: text("faulty_evidence_hash").notNull(),
    replacementBundleVersion: text("replacement_bundle_version").notNull(),
    replacementEvidence: jsonb("replacement_evidence").$type<Record<string, unknown>>().notNull(),
    replacementEvidenceHash: text("replacement_evidence_hash").notNull(),
    reviewChecklist: jsonb("review_checklist").$type<Record<string, unknown>>().notNull(),
    reviewHash: text("review_hash").notNull(),
    affectedCount: integer("affected_count").default(0).notNull(),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("assessment_correction_create_request_unique").on(table.createdBy, table.createRequestId),
    uniqueIndex("assessment_correction_scope_replacement_unique").on(
      table.courseId,
      table.moduleId,
      table.itemId,
      table.contentVersion,
      table.faultyEvidenceHash,
      table.replacementEvidenceHash,
    ),
    index("assessment_correction_status_idx").on(table.status, table.createdAt),
    check("assessment_correction_status_check", sql`${table.status} IN ('reviewed', 'queued', 'processing', 'completed', 'partially_failed', 'failed')`),
    check("assessment_correction_defect_kind_check", sql`${table.defectKind} IN ('faulty_test', 'ambiguous_oracle', 'runtime_defect')`),
    check("assessment_correction_reason_length", sql`char_length(${table.reason}) BETWEEN 20 AND 2000`),
    check("assessment_correction_hashes_check", sql`${table.faultyEvidenceHash} ~ '^[0-9a-f]{64}$' AND ${table.replacementEvidenceHash} ~ '^[0-9a-f]{64}$' AND ${table.reviewHash} ~ '^[0-9a-f]{64}$'`),
    check("assessment_correction_replacement_object", sql`jsonb_typeof(${table.replacementEvidence}) = 'object'`),
    check("assessment_correction_review_object", sql`jsonb_typeof(${table.reviewChecklist}) = 'object'`),
    check("assessment_correction_version_change", sql`${table.faultyBundleVersion} <> ${table.replacementBundleVersion}`),
    check("assessment_correction_affected_count", sql`${table.affectedCount} >= 0`),
    check("assessment_correction_row_version", sql`${table.rowVersion} >= 1`),
  ],
);

export const assessmentCorrectionEvent = pgTable(
  "assessment_correction_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    correctionId: uuid("correction_id").notNull().references(() => assessmentCorrection.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorRole: text("actor_role").notNull(),
    event: text("event").notNull(),
    requestId: uuid("request_id").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("assessment_correction_event_request_unique").on(table.correctionId, table.requestId),
    index("assessment_correction_event_timeline_idx").on(table.correctionId, table.occurredAt),
    check("assessment_correction_event_actor_role", sql`${table.actorRole} IN ('admin', 'system')`),
    check("assessment_correction_event_type", sql`${table.event} IN ('reviewed', 'queued', 'regrade_started', 'regrade_succeeded', 'regrade_failed', 'mastery_projection_applied', 'mastery_projection_unresolved', 'completed')`),
    check("assessment_correction_event_reason", sql`char_length(${table.reason}) BETWEEN 8 AND 2000`),
    check("assessment_correction_event_evidence", sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check("assessment_correction_event_hash", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Immutable, hidden-test-bearing snapshot of one affected official attempt. */
export const assessmentCorrectionImpact = pgTable(
  "assessment_correction_impact",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    correctionId: uuid("correction_id").notNull().references(() => assessmentCorrection.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id").notNull().references(() => attempt.id),
    examSessionId: uuid("exam_session_id").references(() => examSession.id),
    userId: text("user_id").notNull().references(() => user.id),
    formId: text("form_id").notNull(),
    formHash: text("form_hash").notNull(),
    answerSetHash: text("answer_set_hash").notNull(),
    originalResultHash: text("original_result_hash").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("assessment_correction_impact_attempt_unique").on(table.correctionId, table.attemptId),
    index("assessment_correction_impact_user_idx").on(table.userId, table.capturedAt),
    check("assessment_correction_impact_hashes", sql`${table.formHash} ~ '^[0-9a-f]{64}$' AND ${table.answerSetHash} ~ '^[0-9a-f]{64}$' AND ${table.originalResultHash} ~ '^[0-9a-f]{64}$' AND ${table.snapshotHash} ~ '^[0-9a-f]{64}$'`),
    check("assessment_correction_impact_snapshot", sql`jsonb_typeof(${table.snapshot}) = 'object'`),
  ],
);

/** Operational queue row; all official evidence is written to append-only outcome tables. */
export const assessmentRegradeJob = pgTable(
  "assessment_regrade_job",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    correctionId: uuid("correction_id").notNull().references(() => assessmentCorrection.id, { onDelete: "cascade" }),
    impactId: uuid("impact_id").notNull().references(() => assessmentCorrectionImpact.id, { onDelete: "cascade" }),
    status: jobStatusEnum("status").default("queued").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    runnerRequestGeneration: integer("runner_request_generation").default(1).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("assessment_regrade_job_impact_unique").on(table.impactId),
    index("assessment_regrade_job_queue_idx").on(table.status, table.queuedAt),
    check("assessment_regrade_job_attempt_count", sql`${table.attemptCount} >= 0`),
    check("assessment_regrade_job_runner_generation", sql`${table.runnerRequestGeneration} >= 1`),
  ],
);

/** Official append-only result; never replaces the original response/attempt row. */
export const assessmentRegradeOutcome = pgTable(
  "assessment_regrade_outcome",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    correctionId: uuid("correction_id").notNull().references(() => assessmentCorrection.id),
    impactId: uuid("impact_id").notNull().references(() => assessmentCorrectionImpact.id),
    attemptId: uuid("attempt_id").notNull().references(() => attempt.id),
    userId: text("user_id").notNull().references(() => user.id),
    revision: integer("revision").notNull(),
    supersedesOutcomeId: uuid("supersedes_outcome_id"),
    originalResult: jsonb("original_result").$type<Record<string, unknown>>().notNull(),
    originalResultHash: text("original_result_hash").notNull(),
    correctedResult: jsonb("corrected_result").$type<Record<string, unknown>>().notNull(),
    correctedResultHash: text("corrected_result_hash").notNull(),
    runnerEvidence: jsonb("runner_evidence").$type<Record<string, unknown>>().notNull(),
    runnerEvidenceHash: text("runner_evidence_hash").notNull(),
    decisionEvidence: jsonb("decision_evidence").$type<Record<string, unknown>>().notNull(),
    decisionEvidenceHash: text("decision_evidence_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("assessment_regrade_outcome_correction_attempt_unique").on(table.correctionId, table.attemptId),
    uniqueIndex("assessment_regrade_outcome_attempt_revision_unique").on(table.attemptId, table.revision),
    index("assessment_regrade_outcome_attempt_idx").on(table.attemptId, table.createdAt),
    check("assessment_regrade_outcome_revision", sql`${table.revision} >= 1`),
    check("assessment_regrade_outcome_hashes", sql`${table.originalResultHash} ~ '^[0-9a-f]{64}$' AND ${table.correctedResultHash} ~ '^[0-9a-f]{64}$' AND ${table.runnerEvidenceHash} ~ '^[0-9a-f]{64}$' AND ${table.decisionEvidenceHash} ~ '^[0-9a-f]{64}$'`),
    check("assessment_regrade_outcome_json", sql`jsonb_typeof(${table.originalResult}) = 'object' AND jsonb_typeof(${table.correctedResult}) = 'object' AND jsonb_typeof(${table.runnerEvidence}) = 'object' AND jsonb_typeof(${table.decisionEvidence}) = 'object'`),
  ],
);

/** Append-only badge/mastery effect derived from one superseding result. */
export const assessmentMasteryAdjustment = pgTable(
  "assessment_mastery_adjustment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outcomeId: uuid("outcome_id").notNull().references(() => assessmentRegradeOutcome.id),
    userId: text("user_id").notNull().references(() => user.id),
    attemptId: uuid("attempt_id").notNull().references(() => attempt.id),
    skillId: text("skill_id").notNull(),
    languageContext: text("language_context").default("conceptual").notNull(),
    effect: text("effect").notNull(),
    priorOutcome: text("prior_outcome").notNull(),
    correctedOutcome: text("corrected_outcome").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("assessment_mastery_adjustment_outcome_skill_unique").on(table.outcomeId, table.skillId, table.languageContext),
    index("assessment_mastery_adjustment_user_idx").on(table.userId, table.createdAt),
    check("assessment_mastery_adjustment_effect", sql`${table.effect} IN ('award', 'revoke', 'no_change')`),
    check("assessment_mastery_adjustment_outcomes", sql`${table.priorOutcome} IN ('NOT_PASSED', 'PASSED', 'MASTERED', 'PENDING_REVIEW') AND ${table.correctedOutcome} IN ('NOT_PASSED', 'PASSED', 'MASTERED', 'PENDING_REVIEW')`),
    check("assessment_mastery_adjustment_evidence", sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check("assessment_mastery_adjustment_hash", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Retryable projection work derived from append-only mastery adjustments.
 * The adjustment remains the official evidence; this row records whether that
 * evidence could be mapped to one exact enrollment/concept projection.
 */
export const assessmentMasteryProjectionRepair = pgTable(
  "assessment_mastery_projection_repair",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adjustmentId: uuid("adjustment_id")
      .notNull()
      .unique()
      .references(() => assessmentMasteryAdjustment.id, { onDelete: "cascade" }),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => assessmentRegradeOutcome.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempt.id, { onDelete: "cascade" }),
    courseId: text("course_id").notNull(),
    moduleId: text("module_id").notNull(),
    contentVersion: text("content_version").notNull(),
    skillId: text("skill_id").notNull(),
    languageContext: text("language_context").default("conceptual").notNull(),
    effect: text("effect").notNull(),
    status: text("status").default("pending").notNull(),
    conceptId: uuid("concept_id").references(() => concept.id, { onDelete: "set null" }),
    enrollmentId: uuid("enrollment_id").references(() => enrollment.id, { onDelete: "set null" }),
    projectionEvidenceId: uuid("projection_evidence_id").references(() => masteryEvidence.id, { onDelete: "set null" }),
    beforeProjection: jsonb("before_projection").$type<Record<string, unknown>>(),
    afterProjection: jsonb("after_projection").$type<Record<string, unknown>>(),
    appliedRowVersion: bigint("applied_row_version", { mode: "number" }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    lastErrorCode: text("last_error_code"),
    resolutionCode: text("resolution_code"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("assessment_mastery_projection_repair_queue_idx").on(table.status, table.nextAttemptAt),
    index("assessment_mastery_projection_repair_user_idx").on(table.userId, table.updatedAt),
    index("assessment_mastery_projection_repair_attempt_skill_idx").on(table.attemptId, table.skillId, table.languageContext),
    check("assessment_mastery_projection_repair_effect", sql`${table.effect} IN ('award', 'revoke', 'no_change')`),
    check("assessment_mastery_projection_repair_status", sql`${table.status} IN ('pending', 'applied', 'unresolved')`),
    check("assessment_mastery_projection_repair_attempt_count", sql`${table.attemptCount} >= 0`),
    check("assessment_mastery_projection_repair_before_json", sql`${table.beforeProjection} IS NULL OR jsonb_typeof(${table.beforeProjection}) = 'object'`),
    check("assessment_mastery_projection_repair_after_json", sql`${table.afterProjection} IS NULL OR jsonb_typeof(${table.afterProjection}) = 'object'`),
    check("assessment_mastery_projection_repair_applied_state", sql`(${table.status} <> 'applied') OR (${table.appliedAt} IS NOT NULL AND ${table.resolutionCode} IS NOT NULL)`),
  ],
);

/** Mutable read projection pointing at the latest append-only official outcome. */
export const assessmentAttemptEffectiveResult = pgTable(
  "assessment_attempt_effective_result",
  {
    attemptId: uuid("attempt_id").primaryKey().references(() => attempt.id, { onDelete: "cascade" }),
    outcomeId: uuid("outcome_id").notNull().unique().references(() => assessmentRegradeOutcome.id),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    resultHash: text("result_hash").notNull(),
    revision: integer("revision").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("assessment_effective_result_user_idx").on(table.userId, table.updatedAt),
    check("assessment_effective_result_json", sql`jsonb_typeof(${table.result}) = 'object'`),
    check("assessment_effective_result_hash", sql`${table.resultHash} ~ '^[0-9a-f]{64}$'`),
    check("assessment_effective_result_revision", sql`${table.revision} >= 1`),
  ],
);

export const notification = pgTable(
  "notification",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    actionUrl: text("action_url"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("notification_user_unread_idx").on(table.userId, table.readAt, table.createdAt)],
);

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    toEmail: text("to_email").notNull(),
    template: text("template").notNull(),
    templateVersion: text("template_version").notNull(),
    variables: jsonb("variables").$type<Record<string, string>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    operationId: uuid("operation_id").defaultRandom().notNull().unique(),
    deliveryScopeKey: text("delivery_scope_key").notNull(),
    status: notificationStatusEnum("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    claimToken: uuid("claim_token"),
    claimOwner: text("claim_owner"),
    claimVersion: integer("claim_version").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    providerCallStarted: timestamp("provider_call_started", { withTimezone: true }),
    adapter: text("adapter"),
    providerMessageId: text("provider_message_id"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    index("email_outbox_queue_idx").on(table.status, table.nextAttemptAt),
    index("email_outbox_delivery_scope_idx").on(table.deliveryScopeKey),
    index("email_outbox_user_idx").on(table.userId),
    uniqueIndex("email_outbox_claim_token_unique")
      .on(table.claimToken)
      .where(sql`${table.claimToken} IS NOT NULL`),
    uniqueIndex("email_outbox_provider_message_unique")
      .on(table.adapter, table.providerMessageId)
      .where(sql`${table.providerMessageId} IS NOT NULL`),
    check("email_outbox_claim_version_nonnegative", sql`${table.claimVersion} >= 0`),
    check(
      "email_outbox_provider_identity_valid",
      sql`${table.providerMessageId} IS NULL OR (${table.adapter} IS NOT NULL AND btrim(${table.adapter}) <> '' AND btrim(${table.providerMessageId}) <> '')`,
    ),
    check(
      "email_outbox_quarantine_evidence",
      sql`${table.status} <> 'quarantined' OR (${table.quarantinedAt} IS NOT NULL AND ${table.lastErrorCode} IS NOT NULL AND btrim(${table.lastErrorCode}) <> '')`,
    ),
    check(
      "email_outbox_delivery_scope_valid",
      sql`(
        (${table.userId} IS NOT NULL AND ${table.deliveryScopeKey} = 'a:' || ${table.userId})
        OR (${table.userId} IS NULL AND ${table.deliveryScopeKey} = 's:' || ${table.operationId}::text
          AND ${table.templateVersion} = '1' AND ${table.template} IN ('invitation', 'access-rejected'))
        OR (${table.userId} IS NULL AND ${table.deliveryScopeKey} = 'o:' || ${table.operationId}::text
          AND ${table.status} IN ('sent', 'failed', 'suppressed', 'quarantined'))
      )`,
    ),
  ],
);

export const inactivityEpisode = pgTable(
  "inactivity_episode",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }).notNull(),
    secondEligibleAt: timestamp("second_eligible_at", { withTimezone: true }).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    learnerFirstQueuedAt: timestamp("learner_first_queued_at", { withTimezone: true }),
    adminNoticeQueuedAt: timestamp("admin_notice_queued_at", { withTimezone: true }),
    learnerSecondQueuedAt: timestamp("learner_second_queued_at", { withTimezone: true }),
    policyVersion: text("policy_version").default("inactivity-2026-07.v2").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("inactivity_episode_user_idx").on(table.userId, table.openedAt),
    uniqueIndex("inactivity_episode_active_unique")
      .on(table.userId)
      .where(sql`${table.closedAt} IS NULL`),
    check("inactivity_episode_threshold_order", sql`${table.secondEligibleAt} > ${table.eligibleAt} AND ${table.eligibleAt} > ${table.lastActivityAt}`),
  ],
);

export const notificationPreference = pgTable(
  "notification_preference",
  {
    userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
    dailyStudyEnabled: boolean("daily_study_enabled").default(false).notNull(),
    revisionEnabled: boolean("revision_enabled").default(false).notNull(),
    goalEnabled: boolean("goal_enabled").default(false).notNull(),
    challengeEnabled: boolean("challenge_enabled").default(false).notNull(),
    weeklySummaryEnabled: boolean("weekly_summary_enabled").default(false).notNull(),
    learningEmailEnabled: boolean("learning_email_enabled").default(false).notNull(),
    timezone: text("timezone").default("UTC").notNull(),
    dailyStudyMinute: integer("daily_study_minute").default(1_080).notNull(),
    revisionMinute: integer("revision_minute").default(1_140).notNull(),
    quietHoursEnabled: boolean("quiet_hours_enabled").default(true).notNull(),
    quietStartMinute: integer("quiet_start_minute").default(1_320).notNull(),
    quietEndMinute: integer("quiet_end_minute").default(480).notNull(),
    inactivityPausedUntil: timestamp("inactivity_paused_until", { withTimezone: true }),
    inactivityPauseReason: text("inactivity_pause_reason"),
    inactivityPausedBy: text("inactivity_paused_by").references(() => user.id, { onDelete: "set null" }),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    check("notification_preference_daily_minute", sql`${table.dailyStudyMinute} BETWEEN 0 AND 1439`),
    check("notification_preference_revision_minute", sql`${table.revisionMinute} BETWEEN 0 AND 1439`),
    check("notification_preference_timezone_length", sql`char_length(${table.timezone}) BETWEEN 1 AND 100`),
    check("notification_preference_quiet_start", sql`${table.quietStartMinute} BETWEEN 0 AND 1439`),
    check("notification_preference_quiet_end", sql`${table.quietEndMinute} BETWEEN 0 AND 1439`),
    check("notification_preference_pause_reason", sql`${table.inactivityPausedUntil} IS NULL OR char_length(${table.inactivityPauseReason}) BETWEEN 8 AND 500`),
    check("notification_preference_version", sql`${table.rowVersion} >= 1`),
  ],
);

/**
 * One durable receipt per user, reminder kind, and local calendar period.
 * The scheduler writes the receipt and its in-app/email outbox effects in one
 * transaction, so worker retries cannot duplicate a reminder.
 */
export const smartReminderDispatch = pgTable(
  "smart_reminder_dispatch",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    localPeriodKey: text("local_period_key").notNull(),
    timezone: text("timezone").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("smart_reminder_user_kind_period_unique").on(
      table.userId,
      table.kind,
      table.localPeriodKey,
    ),
    index("smart_reminder_user_time_idx").on(table.userId, table.dispatchedAt),
    index("smart_reminder_schedule_idx").on(table.scheduledFor, table.kind),
    check(
      "smart_reminder_kind_check",
      sql`${table.kind} IN ('daily_study', 'revision', 'goal', 'challenge', 'weekly_summary')`,
    ),
    check("smart_reminder_period_length", sql`char_length(${table.localPeriodKey}) BETWEEN 8 AND 32`),
    check("smart_reminder_timezone_length", sql`char_length(${table.timezone}) BETWEEN 1 AND 100`),
    check("smart_reminder_evidence_object", sql`jsonb_typeof(${table.evidence}) = 'object'`),
  ],
);

export const backgroundJob = pgTable(
  "background_job",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: jobStatusEnum("status").default("queued").notNull(),
    priority: integer("priority").default(100).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    runAfter: timestamp("run_after", { withTimezone: true }).defaultNow().notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("background_job_queue_idx").on(table.status, table.runAfter, table.priority)],
);

export const dataLifecycleRun = pgTable(
  "data_lifecycle_run",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operation: text("operation").notNull(),
    policyVersion: text("policy_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    dryRun: boolean("dry_run").default(false).notNull(),
    status: jobStatusEnum("status").default("running").notNull(),
    cutoffManifest: jsonb("cutoff_manifest")
      .$type<Record<string, string>>()
      .default({})
      .notNull(),
    report: jsonb("report")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    targetUserId: text("target_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("data_lifecycle_run_idempotency_unique").on(
      table.idempotencyKey,
    ),
    index("data_lifecycle_run_status_idx").on(table.status, table.startedAt),
    check(
      "data_lifecycle_run_operation_check",
      sql`${table.operation} IN ('retention', 'export', 'account_deletion')`,
    ),
    check(
      "data_lifecycle_run_policy_version_length",
      sql`char_length(${table.policyVersion}) BETWEEN 1 AND 100`,
    ),
    check(
      "data_lifecycle_run_idempotency_key_length",
      sql`char_length(${table.idempotencyKey}) BETWEEN 8 AND 300`,
    ),
    check(
      "data_lifecycle_run_json_object_check",
      sql`jsonb_typeof(${table.cutoffManifest}) = 'object' AND jsonb_typeof(${table.report}) = 'object'`,
    ),
  ],
);

export const accountDeletionTombstone = pgTable(
  "account_deletion_tombstone",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    identityHash: text("identity_hash").notNull(),
    policyVersion: text("policy_version").notNull(),
    requestedByUserId: text("requested_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    primaryDeletionCompletedAt: timestamp("primary_deletion_completed_at", {
      withTimezone: true,
    }).notNull(),
    backupRetentionUntil: timestamp("backup_retention_until", {
      withTimezone: true,
    }).notNull(),
    backupStatus: text("backup_status")
      .default("awaiting_retention_expiry")
      .notNull(),
    report: jsonb("report")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("account_deletion_tombstone_user_unique").on(table.userId),
    index("account_deletion_tombstone_backup_idx").on(
      table.backupStatus,
      table.backupRetentionUntil,
    ),
    check(
      "account_deletion_identity_hash_length",
      sql`${table.identityHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "account_deletion_backup_status_check",
      sql`${table.backupStatus} IN ('awaiting_retention_expiry', 'eligible_for_operator_verification', 'verified_expired')`,
    ),
    check(
      "account_deletion_policy_version_length",
      sql`char_length(${table.policyVersion}) BETWEEN 1 AND 100`,
    ),
    check(
      "account_deletion_backup_window_check",
      sql`${table.backupRetentionUntil} >= ${table.primaryDeletionCompletedAt}`,
    ),
    check(
      "account_deletion_report_object_check",
      sql`jsonb_typeof(${table.report}) = 'object'`,
    ),
  ],
);

/**
 * Administrator-authored career guidance. Cards are intentionally separate
 * from curriculum and AI output: only an active administrator can publish a
 * reviewed card, and time-sensitive market language carries dated provenance.
 */
export const careerCard = pgTable(
  "career_card",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    path: text("path").notNull(),
    technology: text("technology").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    futureScope: text("future_scope").notNull(),
    status: text("status").default("draft").notNull(),
    authoredBy: text("authored_by").notNull().references(() => user.id),
    publishedBy: text("published_by").references(() => user.id),
    marketClaim: text("market_claim"),
    marketSourceUrl: text("market_source_url"),
    marketRegion: text("market_region"),
    marketObservedAt: timestamp("market_observed_at", { withTimezone: true }),
    marketReviewedAt: timestamp("market_reviewed_at", { withTimezone: true }),
    marketExpiresAt: timestamp("market_expires_at", { withTimezone: true }),
    marketReviewedBy: text("market_reviewed_by").references(() => user.id),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("career_card_slug_unique").on(sql`lower(${table.slug})`),
    index("career_card_status_title_idx").on(table.status, table.technology, table.title),
    check("career_card_slug_check", sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{2,79}$'`),
    check("career_card_path_length", sql`char_length(${table.path}) BETWEEN 2 AND 120`),
    check("career_card_technology_length", sql`char_length(${table.technology}) BETWEEN 1 AND 120`),
    check("career_card_title_length", sql`char_length(${table.title}) BETWEEN 3 AND 160`),
    check("career_card_summary_length", sql`char_length(${table.summary}) BETWEEN 20 AND 1200`),
    check("career_card_future_scope_length", sql`char_length(${table.futureScope}) BETWEEN 20 AND 2000`),
    check("career_card_status_check", sql`${table.status} IN ('draft', 'published', 'retired')`),
    check("career_card_version_check", sql`${table.rowVersion} >= 1`),
    check(
      "career_card_publish_shape",
      sql`(${table.status} <> 'published') OR (${table.publishedBy} IS NOT NULL AND ${table.publishedAt} IS NOT NULL AND ${table.retiredAt} IS NULL)`,
    ),
    check(
      "career_card_retire_shape",
      sql`(${table.status} <> 'retired') OR ${table.retiredAt} IS NOT NULL`,
    ),
    check(
      "career_card_market_all_or_none",
      sql`(${table.marketClaim} IS NULL AND ${table.marketSourceUrl} IS NULL AND ${table.marketRegion} IS NULL
          AND ${table.marketObservedAt} IS NULL AND ${table.marketReviewedAt} IS NULL
          AND ${table.marketExpiresAt} IS NULL AND ${table.marketReviewedBy} IS NULL)
        OR (${table.marketClaim} IS NOT NULL AND ${table.marketSourceUrl} IS NOT NULL AND ${table.marketRegion} IS NOT NULL
          AND ${table.marketObservedAt} IS NOT NULL AND ${table.marketReviewedAt} IS NOT NULL
          AND ${table.marketExpiresAt} IS NOT NULL AND ${table.marketReviewedBy} IS NOT NULL)`,
    ),
    check(
      "career_card_market_metadata_check",
      sql`${table.marketClaim} IS NULL OR (
        char_length(${table.marketClaim}) BETWEEN 10 AND 1000
        AND char_length(${table.marketRegion}) BETWEEN 2 AND 120
        AND char_length(${table.marketSourceUrl}) BETWEEN 12 AND 2000
        AND ${table.marketSourceUrl} ~ '^https://[^[:space:]]+$'
        AND ${table.marketObservedAt} <= ${table.marketReviewedAt}
        AND ${table.marketReviewedAt} < ${table.marketExpiresAt}
      )`,
    ),
    check(
      "career_card_published_market_freshness",
      sql`${table.status} <> 'published' OR ${table.marketClaim} IS NULL OR (
        ${table.marketReviewedAt} <= ${table.publishedAt} AND ${table.publishedAt} < ${table.marketExpiresAt}
      )`,
    ),
  ],
);

export const careerCardPrerequisite = pgTable(
  "career_card_prerequisite",
  {
    careerCardId: uuid("career_card_id").notNull().references(() => careerCard.id, { onDelete: "cascade" }),
    courseId: uuid("course_id").notNull().references(() => course.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    rationale: text("rationale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.careerCardId, table.courseId] }),
    uniqueIndex("career_card_prerequisite_position_unique").on(table.careerCardId, table.position),
    index("career_card_prerequisite_course_idx").on(table.courseId),
    check("career_card_prerequisite_position_check", sql`${table.position} BETWEEN 1 AND 50`),
    check("career_card_prerequisite_rationale_length", sql`char_length(${table.rationale}) BETWEEN 8 AND 500`),
  ],
);

/** Append-only editorial provenance and idempotency for career mutations. */
export const careerCardEvent = pgTable(
  "career_card_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    careerCardId: uuid("career_card_id").notNull().references(() => careerCard.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull().references(() => user.id),
    requestId: uuid("request_id").notNull(),
    event: text("event").notNull(),
    inputHash: text("input_hash").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    reason: text("reason").notNull(),
    resultingVersion: bigint("resulting_version", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("career_card_event_request_unique").on(table.actorUserId, table.requestId),
    index("career_card_event_timeline_idx").on(table.careerCardId, table.occurredAt, table.id),
    check("career_card_event_type_check", sql`${table.event} IN ('created', 'updated', 'published', 'retired')`),
    check("career_card_event_input_hash_check", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("career_card_event_evidence_hash_check", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
    check("career_card_event_snapshot_check", sql`jsonb_typeof(${table.snapshot}) = 'object'`),
    check("career_card_event_reason_length", sql`char_length(${table.reason}) BETWEEN 8 AND 1000`),
    check("career_card_event_version_check", sql`${table.resultingVersion} >= 1`),
  ],
);

/**
 * Immutable learner certificate. Public verification reads only the bounded
 * display snapshot; exact completion/mastery evidence remains private.
 */
export const courseCertificate = pgTable(
  "course_certificate",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    enrollmentId: uuid("enrollment_id").notNull(),
    courseVersionId: uuid("course_version_id").notNull().references(() => courseVersion.id, { onDelete: "restrict" }),
    verificationId: text("verification_id").notNull(),
    learnerDisplayName: text("learner_display_name").notNull(),
    courseTitle: text("course_title").notNull(),
    courseVersionLabel: text("course_version_label").notNull(),
    issueEvidence: jsonb("issue_evidence").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    policyVersion: text("policy_version").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("course_certificate_verification_unique").on(table.verificationId),
    uniqueIndex("course_certificate_enrollment_unique").on(table.enrollmentId),
    uniqueIndex("course_certificate_id_user_unique").on(table.id, table.userId),
    index("course_certificate_user_time_idx").on(table.userId, table.issuedAt, table.id),
    foreignKey({
      name: "course_certificate_enrollment_owner_fk",
      columns: [table.enrollmentId, table.userId],
      foreignColumns: [enrollment.id, enrollment.userId],
    }).onDelete("cascade"),
    check("course_certificate_verification_shape", sql`${table.verificationId} ~ '^[A-Za-z0-9_-]{32,80}$'`),
    check("course_certificate_learner_name_length", sql`char_length(${table.learnerDisplayName}) BETWEEN 1 AND 160`),
    check("course_certificate_course_title_length", sql`char_length(${table.courseTitle}) BETWEEN 1 AND 300`),
    check("course_certificate_version_length", sql`char_length(${table.courseVersionLabel}) BETWEEN 1 AND 100`),
    check("course_certificate_evidence_object", sql`jsonb_typeof(${table.issueEvidence}) = 'object'`),
    check("course_certificate_evidence_hash", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
    check("course_certificate_policy_length", sql`char_length(${table.policyVersion}) BETWEEN 3 AND 100`),
  ],
);

export const certificateRevocation = pgTable(
  "certificate_revocation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    certificateId: uuid("certificate_id").notNull().references(() => courseCertificate.id, { onDelete: "cascade" }),
    revokedBy: text("revoked_by").notNull().references(() => user.id),
    requestId: uuid("request_id").notNull(),
    reason: text("reason").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("certificate_revocation_certificate_unique").on(table.certificateId),
    uniqueIndex("certificate_revocation_request_unique").on(table.revokedBy, table.requestId),
    check("certificate_revocation_reason_length", sql`char_length(${table.reason}) BETWEEN 8 AND 1000`),
    check("certificate_revocation_evidence_hash", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const certificateOperationReceipt = pgTable(
  "certificate_operation_receipt",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    operation: text("operation").notNull(),
    inputHash: text("input_hash").notNull(),
    certificateId: uuid("certificate_id").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.requestId] }),
    index("certificate_operation_receipt_time_idx").on(table.userId, table.createdAt),
    foreignKey({
      name: "certificate_operation_receipt_certificate_owner_fk",
      columns: [table.certificateId, table.userId],
      foreignColumns: [courseCertificate.id, courseCertificate.userId],
    }).onDelete("cascade"),
    check("certificate_operation_receipt_operation_check", sql`${table.operation} = 'issue'`),
    check("certificate_operation_receipt_input_hash", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("certificate_operation_receipt_result_object", sql`jsonb_typeof(${table.result}) = 'object'`),
  ],
);

/** Explicit, withdrawable public projection; private learning data is absent. */
export const publicPortfolio = pgTable(
  "public_portfolio",
  {
    userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    headline: text("headline").notNull(),
    about: text("about"),
    isPublished: boolean("is_published").default(false).notNull(),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("public_portfolio_slug_unique").on(sql`lower(${table.slug})`),
    index("public_portfolio_published_idx").on(table.isPublished, table.updatedAt),
    check("public_portfolio_slug_check", sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{2,39}$'`),
    check("public_portfolio_display_name_length", sql`char_length(${table.displayName}) BETWEEN 1 AND 120`),
    check("public_portfolio_headline_length", sql`char_length(${table.headline}) BETWEEN 10 AND 180`),
    check("public_portfolio_about_length", sql`${table.about} IS NULL OR char_length(${table.about}) BETWEEN 1 AND 1200`),
    check("public_portfolio_version_check", sql`${table.rowVersion} >= 1`),
    check("public_portfolio_publish_shape", sql`NOT ${table.isPublished} OR (${table.publishedAt} IS NOT NULL AND ${table.withdrawnAt} IS NULL)`),
  ],
);

export const publicPortfolioProject = pgTable(
  "public_portfolio_project",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.projectId] }),
    uniqueIndex("public_portfolio_project_position_unique").on(table.userId, table.position),
    foreignKey({
      name: "public_portfolio_project_owner_fk",
      columns: [table.projectId, table.userId],
      foreignColumns: [project.id, project.userId],
    }).onDelete("cascade"),
    check("public_portfolio_project_position_check", sql`${table.position} BETWEEN 1 AND 50`),
  ],
);

/**
 * Immutable allowlisted metadata captured by an explicit portfolio
 * publication. Public pages never join mutable project text directly.
 */
export const publicPortfolioProjectSnapshot = pgTable(
  "public_portfolio_project_snapshot",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    portfolioVersion: bigint("portfolio_version", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    status: text("status").notNull(),
    githubUrl: text("github_url").notNull(),
    sourceProjectUpdatedAt: timestamp("source_project_updated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.projectId, table.portfolioVersion] }),
    index("public_portfolio_project_snapshot_version_idx").on(table.userId, table.portfolioVersion),
    foreignKey({
      name: "public_portfolio_project_snapshot_owner_fk",
      columns: [table.projectId, table.userId],
      foreignColumns: [project.id, project.userId],
    }).onDelete("cascade"),
    check("public_portfolio_project_snapshot_version_check", sql`${table.portfolioVersion} >= 1`),
    check("public_portfolio_project_snapshot_title_length", sql`char_length(${table.title}) BETWEEN 1 AND 100`),
    check("public_portfolio_project_snapshot_summary_length", sql`char_length(${table.summary}) BETWEEN 1 AND 1000`),
    check(
      "public_portfolio_project_snapshot_github_url_check",
      sql`${table.githubUrl} ~ '^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'`,
    ),
  ],
);

export const publicPortfolioAchievement = pgTable(
  "public_portfolio_achievement",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    userAchievementId: uuid("user_achievement_id").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.userAchievementId] }),
    uniqueIndex("public_portfolio_achievement_position_unique").on(table.userId, table.position),
    foreignKey({
      name: "public_portfolio_achievement_owner_fk",
      columns: [table.userAchievementId, table.userId],
      foreignColumns: [userAchievement.id, userAchievement.userId],
    }).onDelete("cascade"),
    check("public_portfolio_achievement_position_check", sql`${table.position} BETWEEN 1 AND 50`),
  ],
);

export const publicPortfolioCertificate = pgTable(
  "public_portfolio_certificate",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    certificateId: uuid("certificate_id").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.certificateId] }),
    uniqueIndex("public_portfolio_certificate_position_unique").on(table.userId, table.position),
    foreignKey({
      name: "public_portfolio_certificate_owner_fk",
      columns: [table.certificateId, table.userId],
      foreignColumns: [courseCertificate.id, courseCertificate.userId],
    }).onDelete("cascade"),
    check("public_portfolio_certificate_position_check", sql`${table.position} BETWEEN 1 AND 50`),
  ],
);

/** Append-only consent and configuration history for the public projection. */
export const publicPortfolioEvent = pgTable(
  "public_portfolio_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull().references(() => user.id),
    requestId: uuid("request_id").notNull(),
    event: text("event").notNull(),
    inputHash: text("input_hash").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    reason: text("reason").notNull(),
    resultingVersion: bigint("resulting_version", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("public_portfolio_event_request_unique").on(table.userId, table.requestId),
    index("public_portfolio_event_timeline_idx").on(table.userId, table.occurredAt, table.id),
    check("public_portfolio_event_type_check", sql`${table.event} IN ('created', 'updated', 'published', 'withdrawn')`),
    check("public_portfolio_event_input_hash", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("public_portfolio_event_evidence_hash", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
    check("public_portfolio_event_snapshot_object", sql`jsonb_typeof(${table.snapshot}) = 'object'`),
    check("public_portfolio_event_reason_length", sql`char_length(${table.reason}) BETWEEN 8 AND 1000`),
    check("public_portfolio_event_version_check", sql`${table.resultingVersion} >= 1`),
  ],
);

/**
 * Closed-cohort discussion spaces. `cohort` groups are readable by every
 * authenticated active account; `members` groups fail closed unless a live
 * membership row exists. Content is stored and rendered as plain text.
 */
export const communityGroup = pgTable(
  "community_group",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    visibility: text("visibility").default("members").notNull(),
    status: text("status").default("active").notNull(),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("community_group_name_unique").on(sql`lower(${table.name})`),
    index("community_group_visibility_status_idx").on(table.visibility, table.status, table.createdAt),
    check("community_group_name_length", sql`char_length(${table.name}) BETWEEN 3 AND 80`),
    check("community_group_description_length", sql`char_length(${table.description}) BETWEEN 10 AND 500`),
    check("community_group_visibility_check", sql`${table.visibility} IN ('cohort', 'members')`),
    check("community_group_status_check", sql`${table.status} IN ('active', 'archived')`),
    check("community_group_version_check", sql`${table.rowVersion} >= 1`),
  ],
);

export const communityGroupMember = pgTable(
  "community_group_member",
  {
    groupId: uuid("group_id").notNull().references(() => communityGroup.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index("community_group_member_user_idx").on(table.userId, table.joinedAt),
    check("community_group_member_role_check", sql`${table.role} IN ('owner', 'moderator', 'member')`),
  ],
);

export const communityPost = pgTable(
  "community_post",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    groupId: uuid("group_id").notNull().references(() => communityGroup.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    state: text("state").default("active").notNull(),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    moderatedByUserId: text("moderated_by_user_id").references(() => user.id, { onDelete: "set null" }),
    moderationReason: text("moderation_reason"),
    ...timestamps,
  },
  (table) => [
    index("community_post_group_feed_idx").on(table.groupId, table.state, table.createdAt, table.id),
    index("community_post_author_idx").on(table.authorUserId, table.createdAt),
    check("community_post_kind_check", sql`${table.kind} IN ('discussion', 'help', 'project_share')`),
    check("community_post_title_length", sql`char_length(${table.title}) BETWEEN 3 AND 160`),
    check("community_post_body_length", sql`char_length(${table.body}) BETWEEN 10 AND 8000`),
    check("community_post_hash_check", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("community_post_state_check", sql`${table.state} IN ('active', 'hidden', 'deleted')`),
    check("community_post_version_check", sql`${table.rowVersion} >= 1`),
    check(
      "community_post_deletion_shape",
      sql`(${table.state} <> 'deleted' AND ${table.deletedAt} IS NULL) OR (${table.state} = 'deleted' AND ${table.deletedAt} IS NOT NULL)`,
    ),
    check(
      "community_post_moderation_shape",
      sql`(${table.moderatedByUserId} IS NULL AND ${table.moderationReason} IS NULL) OR (${table.moderatedByUserId} IS NOT NULL AND char_length(${table.moderationReason}) BETWEEN 8 AND 1000)`,
    ),
  ],
);

export const communityReply = pgTable(
  "community_reply",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    postId: uuid("post_id").notNull().references(() => communityPost.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    state: text("state").default("active").notNull(),
    rowVersion: bigint("row_version", { mode: "number" }).default(1).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    moderatedByUserId: text("moderated_by_user_id").references(() => user.id, { onDelete: "set null" }),
    moderationReason: text("moderation_reason"),
    ...timestamps,
  },
  (table) => [
    index("community_reply_post_timeline_idx").on(table.postId, table.state, table.createdAt, table.id),
    index("community_reply_author_idx").on(table.authorUserId, table.createdAt),
    check("community_reply_body_length", sql`char_length(${table.body}) BETWEEN 2 AND 4000`),
    check("community_reply_hash_check", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("community_reply_state_check", sql`${table.state} IN ('active', 'hidden', 'deleted')`),
    check("community_reply_version_check", sql`${table.rowVersion} >= 1`),
    check(
      "community_reply_deletion_shape",
      sql`(${table.state} <> 'deleted' AND ${table.deletedAt} IS NULL) OR (${table.state} = 'deleted' AND ${table.deletedAt} IS NOT NULL)`,
    ),
    check(
      "community_reply_moderation_shape",
      sql`(${table.moderatedByUserId} IS NULL AND ${table.moderationReason} IS NULL) OR (${table.moderatedByUserId} IS NOT NULL AND char_length(${table.moderationReason}) BETWEEN 8 AND 1000)`,
    ),
  ],
);

export const communityReport = pgTable(
  "community_report",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reporterUserId: text("reporter_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    postId: uuid("post_id").references(() => communityPost.id, { onDelete: "cascade" }),
    replyId: uuid("reply_id").references(() => communityReply.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    details: text("details"),
    status: text("status").default("open").notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, { onDelete: "set null" }),
    decisionReason: text("decision_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("community_report_post_reporter_unique").on(table.reporterUserId, table.postId).where(sql`${table.postId} IS NOT NULL`),
    uniqueIndex("community_report_reply_reporter_unique").on(table.reporterUserId, table.replyId).where(sql`${table.replyId} IS NOT NULL`),
    index("community_report_queue_idx").on(table.status, table.createdAt, table.id),
    check("community_report_target_check", sql`num_nonnulls(${table.postId}, ${table.replyId}) = 1`),
    check("community_report_reason_check", sql`${table.reason} IN ('harassment', 'unsafe_code', 'spam', 'privacy', 'other')`),
    check("community_report_details_length", sql`${table.details} IS NULL OR char_length(${table.details}) BETWEEN 4 AND 1000`),
    check("community_report_status_check", sql`${table.status} IN ('open', 'resolved', 'dismissed')`),
    check(
      "community_report_decision_shape",
      sql`(${table.status} = 'open' AND ${table.decidedByUserId} IS NULL AND ${table.decisionReason} IS NULL AND ${table.decidedAt} IS NULL)
        OR (${table.status} <> 'open' AND ${table.decidedByUserId} IS NOT NULL AND char_length(${table.decisionReason}) BETWEEN 8 AND 1000 AND ${table.decidedAt} IS NOT NULL)`,
    ),
  ],
);

/** Content-free replay authority for community mutations and moderation decisions. */
export const communityOperationReceipt = pgTable(
  "community_operation_receipt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    action: text("action").notNull(),
    inputHash: text("input_hash").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("community_operation_receipt_user_request_unique").on(table.userId, table.requestId),
    index("community_operation_receipt_user_time_idx").on(table.userId, table.createdAt),
    check(
      "community_operation_receipt_action_check",
      sql`${table.action} IN ('create_group','add_member','create_post','reply','moderate')`,
    ),
    check("community_operation_receipt_hash_check", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("community_operation_receipt_result_object", sql`jsonb_typeof(${table.result}) = 'object'`),
  ],
);

/** Append-only moderation provenance; it contains no private learner evidence. */
export const communityModerationEvent = pgTable(
  "community_moderation_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    reportId: uuid("report_id").references(() => communityReport.id, { onDelete: "set null" }),
    postId: uuid("post_id").references(() => communityPost.id, { onDelete: "cascade" }),
    replyId: uuid("reply_id").references(() => communityReply.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    priorState: text("prior_state").notNull(),
    resultingState: text("resulting_state").notNull(),
    reason: text("reason").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("community_moderation_target_time_idx").on(table.postId, table.replyId, table.occurredAt),
    check("community_moderation_target_check", sql`num_nonnulls(${table.postId}, ${table.replyId}) = 1`),
    check("community_moderation_action_check", sql`${table.action} IN ('hide', 'restore', 'delete')`),
    check("community_moderation_state_check", sql`${table.priorState} IN ('active', 'hidden', 'deleted') AND ${table.resultingState} IN ('active', 'hidden', 'deleted')`),
    check("community_moderation_reason_length", sql`char_length(${table.reason}) BETWEEN 8 AND 1000`),
  ],
);

/**
 * An asynchronous challenge frozen from a reviewed authored activity. The
 * immutable snapshot may contain a grading key and is therefore never sent to
 * clients directly; services return a bounded public projection.
 */
export const codingBattle = pgTable(
  "coding_battle",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    creatorUserId: text("creator_user_id").references(() => user.id, { onDelete: "set null" }),
    createRequestId: uuid("create_request_id").notNull(),
    createInputHash: text("create_input_hash").notNull(),
    activityId: uuid("activity_id").notNull().references(() => activity.id, { onDelete: "restrict" }),
    scope: text("scope").notNull(),
    competitionKey: text("competition_key"),
    title: text("title").notNull(),
    language: text("language").notNull(),
    skillKey: text("skill_key").notNull(),
    challengeKind: text("challenge_kind").notNull(),
    immutableSnapshot: jsonb("immutable_snapshot").$type<Record<string, unknown>>().notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    scoringVersion: text("scoring_version").default("battle-score-v1").notNull(),
    maxPoints: integer("max_points").default(100).notNull(),
    status: text("status").default("active").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    revealAt: timestamp("reveal_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("coding_battle_creator_request_unique").on(table.creatorUserId, table.createRequestId),
    uniqueIndex("coding_battle_competition_key_unique").on(table.competitionKey).where(sql`${table.competitionKey} IS NOT NULL`),
    index("coding_battle_discovery_idx").on(table.status, table.scope, table.startsAt, table.revealAt),
    check("coding_battle_scope_check", sql`${table.scope} IN ('invite', 'cohort', 'weekly', 'monthly')`),
    check("coding_battle_create_input_hash", sql`${table.createInputHash} ~ '^[0-9a-f]{64}$'`),
    check("coding_battle_competition_shape", sql`(${table.scope} IN ('weekly','monthly')) = (${table.competitionKey} IS NOT NULL)`),
    check("coding_battle_competition_key_length", sql`${table.competitionKey} IS NULL OR char_length(${table.competitionKey}) BETWEEN 7 AND 40`),
    check("coding_battle_title_length", sql`char_length(${table.title}) BETWEEN 3 AND 160`),
    check("coding_battle_language_length", sql`char_length(${table.language}) BETWEEN 1 AND 80`),
    check("coding_battle_skill_length", sql`char_length(${table.skillKey}) BETWEEN 2 AND 160`),
    check("coding_battle_kind_check", sql`${table.challengeKind} IN ('authored_answer', 'verified_attempt')`),
    check("coding_battle_snapshot_object", sql`jsonb_typeof(${table.immutableSnapshot}) = 'object'`),
    check("coding_battle_snapshot_hash", sql`${table.snapshotHash} ~ '^[0-9a-f]{64}$'`),
    check("coding_battle_scoring_version_length", sql`char_length(${table.scoringVersion}) BETWEEN 3 AND 100`),
    check("coding_battle_points_check", sql`${table.maxPoints} BETWEEN 1 AND 1000`),
    check("coding_battle_status_check", sql`${table.status} IN ('active', 'cancelled')`),
    check("coding_battle_time_order", sql`${table.startsAt} < ${table.endsAt} AND ${table.endsAt} <= ${table.revealAt}`),
  ],
);

export const codingBattleParticipant = pgTable(
  "coding_battle_participant",
  {
    battleId: uuid("battle_id").notNull().references(() => codingBattle.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.battleId, table.userId] }),
    index("coding_battle_participant_user_idx").on(table.userId, table.joinedAt),
    check("coding_battle_participant_role_check", sql`${table.role} IN ('creator', 'invited', 'joined')`),
  ],
);

/** One final, append-only result per participant; no client-supplied score. */
export const codingBattleSubmission = pgTable(
  "coding_battle_submission",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    battleId: uuid("battle_id").notNull(),
    userId: text("user_id").notNull(),
    requestId: uuid("request_id").notNull(),
    inputHash: text("input_hash").notNull(),
    answer: jsonb("answer").$type<Record<string, unknown>>().notNull(),
    answerHash: text("answer_hash").notNull(),
    sourceAttemptId: uuid("source_attempt_id").references(() => attempt.id, { onDelete: "restrict" }),
    score: integer("score").notNull(),
    passed: boolean("passed").notNull(),
    resultEvidence: jsonb("result_evidence").$type<Record<string, unknown>>().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("coding_battle_submission_participant_unique").on(table.battleId, table.userId),
    uniqueIndex("coding_battle_submission_request_unique").on(table.userId, table.requestId),
    index("coding_battle_submission_result_idx").on(table.battleId, table.score, table.submittedAt, table.id),
    foreignKey({
      name: "coding_battle_submission_participant_fk",
      columns: [table.battleId, table.userId],
      foreignColumns: [codingBattleParticipant.battleId, codingBattleParticipant.userId],
    }).onDelete("cascade"),
    check("coding_battle_submission_input_hash", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("coding_battle_submission_answer_object", sql`jsonb_typeof(${table.answer}) = 'object'`),
    check("coding_battle_submission_answer_hash", sql`${table.answerHash} ~ '^[0-9a-f]{64}$'`),
    check("coding_battle_submission_score", sql`${table.score} BETWEEN 0 AND 1000`),
    check("coding_battle_submission_evidence_object", sql`jsonb_typeof(${table.resultEvidence}) = 'object'`),
  ],
);

/**
 * Disposable abuse-prevention state. keyHash is an HMAC digest; raw IPs,
 * emails, invitation tokens, and user IDs must never be stored here.
 */
export const apiRateLimitWindow = pgTable(
  "api_rate_limit_window",
  {
    scope: text("scope").notNull(),
    keyHash: text("key_hash").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "api_rate_limit_window_pk",
      columns: [table.scope, table.keyHash, table.windowStart],
    }),
    index("api_rate_limit_expiry_idx").on(table.expiresAt),
    check(
      "api_rate_limit_scope_check",
      sql`char_length(${table.scope}) BETWEEN 1 AND 100`,
    ),
    check(
      "api_rate_limit_key_hash_check",
      sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "api_rate_limit_count_check",
      sql`${table.requestCount} BETWEEN 1 AND 1000001`,
    ),
    check(
      "api_rate_limit_expiry_check",
      sql`${table.expiresAt} > ${table.windowStart}`,
    ),
  ],
);

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type ProviderCredential = typeof providerCredential.$inferSelect;
export type Enrollment = typeof enrollment.$inferSelect;
export type ConceptMastery = typeof conceptMastery.$inferSelect;
