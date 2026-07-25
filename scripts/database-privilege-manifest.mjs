const APP_ROLE = "learncoding_app";
const LEGACY_WORKER_ROLE = "learncoding_worker";
const LEGACY_OPS_ROLE = "learncoding_ops";

const ALL_TABLE_PRIVILEGES = Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]);
const APPEND_ONLY_PRIVILEGES = Object.freeze(["SELECT", "INSERT"]);
const READ_ONLY_PRIVILEGES = Object.freeze(["SELECT"]);
const EMPTY_PRIVILEGES = Object.freeze([]);
const PRIVILEGE_ORDER = Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]);
const ALLOWED_PRIVILEGES = new Set(PRIVILEGE_ORDER);

const TABLE_NAMES = Object.freeze([
  "access_request",
  "account",
  "account_deletion_tombstone",
  "achievement",
  "activity",
  "admin_fallback_grant",
  "admin_fallback_reservation",
  "api_rate_limit_window",
  "appeal",
  "appeal_event",
  "assessment_attempt_effective_result",
  "assessment_correction",
  "assessment_correction_event",
  "assessment_correction_impact",
  "assessment_mastery_adjustment",
  "assessment_mastery_projection_repair",
  "assessment_regrade_job",
  "assessment_regrade_outcome",
  "attempt",
  "audit_event",
  "auth_session_history",
  "background_job",
  "career_card",
  "career_card_event",
  "career_card_prerequisite",
  "certificate_operation_receipt",
  "certificate_revocation",
  "chat_message",
  "chat_thread",
  "code_submission",
  "coding_battle",
  "coding_battle_participant",
  "coding_battle_submission",
  "cohort_profile",
  "cohort_profile_event",
  "community_group",
  "community_group_member",
  "community_moderation_event",
  "community_operation_receipt",
  "community_post",
  "community_reply",
  "community_report",
  "concept",
  "concept_mastery",
  "consent_record",
  "course",
  "course_certificate",
  "course_module",
  "course_version",
  "curriculum_artifact",
  "curriculum_publication_event",
  "curriculum_publication_pointer",
  "curriculum_release_evidence",
  "curriculum_review_event",
  "daily_review_item",
  "daily_review_session",
  "data_lifecycle_run",
  "email_outbox",
  "enrollment",
  "exam_autosave_mutation",
  "exam_event",
  "exam_finalization_job",
  "exam_mastery_recheck",
  "exam_reexam_grant",
  "exam_session",
  "inactivity_episode",
  "invitation",
  "leaderboard_score_snapshot",
  "learner_draft",
  "learner_draft_mutation",
  "learner_profile",
  "learning_request",
  "learning_session",
  "learning_session_event",
  "lesson",
  "lesson_block",
  "lesson_concept",
  "lost_device_proof",
  "mastery_evidence",
  "model_call",
  "module_project_start_receipt",
  "module_project_template",
  "module_project_template_event",
  "notification",
  "notification_preference",
  "plan_revision",
  "practice_help_event",
  "prerequisite",
  "project",
  "project_review",
  "project_review_correction",
  "project_review_correction_event",
  "project_review_effective",
  "project_revision",
  "project_revision_object",
  "provider_credential",
  "provider_operation_receipt",
  "provider_policy",
  "public_portfolio",
  "public_portfolio_achievement",
  "public_portfolio_certificate",
  "public_portfolio_event",
  "public_portfolio_project",
  "public_portfolio_project_snapshot",
  "quota_ledger",
  "response",
  "review_schedule",
  "reward_ledger",
  "reward_operation_receipt",
  "reward_reconciliation_job",
  "runner_job",
  "runner_power_rehearsal_event",
  "session",
  "session_revocation_request",
  "smart_reminder_dispatch",
  "storage_quota_change",
  "stored_object",
  "test_bundle",
  "two_factor",
  "upload_receipt",
  "user",
  "user_achievement",
  "verification",
]);

const APPEND_ONLY_TABLES = new Set([
  "account_deletion_tombstone",
  "appeal_event",
  "assessment_correction_event",
  "audit_event",
  "auth_session_history",
  "career_card_event",
  "certificate_operation_receipt",
  "certificate_revocation",
  "cohort_profile_event",
  "community_moderation_event",
  "community_operation_receipt",
  "course_certificate",
  "curriculum_publication_event",
  "curriculum_release_evidence",
  "curriculum_review_event",
  "exam_autosave_mutation",
  "exam_event",
  "learner_draft_mutation",
  "learning_session_event",
  "mastery_evidence",
  "module_project_start_receipt",
  "module_project_template_event",
  "project_review",
  "project_review_correction_event",
  "provider_operation_receipt",
  "public_portfolio_event",
  "reward_ledger",
  "reward_operation_receipt",
  "storage_quota_change",
]);

export const DATABASE_SERVICE_CREDENTIALS = Object.freeze({
  app: Object.freeze({ role: APP_ROLE, secret: "database_url" }),
  "mail-worker": Object.freeze({ role: "learncoding_mail_worker", secret: "database_mail_worker_url" }),
  "reward-worker": Object.freeze({ role: "learncoding_reward_worker", secret: "database_reward_worker_url" }),
  "regrade-worker": Object.freeze({ role: "learncoding_regrade_worker", secret: "database_regrade_worker_url" }),
  "exam-finalization-worker": Object.freeze({ role: "learncoding_exam_worker", secret: "database_exam_worker_url" }),
  "practice-runner-recovery-worker": Object.freeze({ role: "learncoding_practice_worker", secret: "database_practice_worker_url" }),
  "project-review-correction-worker": Object.freeze({ role: "learncoding_project_worker", secret: "database_project_worker_url" }),
  "scan-worker": Object.freeze({ role: "learncoding_scan_worker", secret: "database_scan_worker_url" }),
  "file-erasure-worker": Object.freeze({ role: "learncoding_erasure_worker", secret: "database_erasure_worker_url" }),
  lifecycle: Object.freeze({ role: "learncoding_lifecycle", secret: "database_lifecycle_url" }),
  "platform-seed": Object.freeze({ role: "learncoding_platform_seed", secret: "database_platform_seed_url" }),
  "admin-bootstrap": Object.freeze({ role: "learncoding_admin_bootstrap", secret: "database_admin_bootstrap_url" }),
});

const SERVICE_GRANTS = Object.freeze({
  learncoding_mail_worker: Object.freeze({
    email_outbox: ["SELECT", "UPDATE"],
  }),
  learncoding_reward_worker: Object.freeze({
    achievement: READ_ONLY_PRIVILEGES,
    activity: READ_ONLY_PRIVILEGES,
    assessment_attempt_effective_result: READ_ONLY_PRIVILEGES,
    attempt: READ_ONLY_PRIVILEGES,
    course: READ_ONLY_PRIVILEGES,
    enrollment: READ_ONLY_PRIVILEGES,
    mastery_evidence: READ_ONLY_PRIVILEGES,
    reward_ledger: ["SELECT", "INSERT"],
    reward_operation_receipt: ["SELECT", "INSERT"],
    reward_reconciliation_job: ALL_TABLE_PRIVILEGES,
    user_achievement: ALL_TABLE_PRIVILEGES,
  }),
  learncoding_regrade_worker: Object.freeze({
    assessment_attempt_effective_result: ALL_TABLE_PRIVILEGES,
    assessment_correction: READ_ONLY_PRIVILEGES,
    assessment_correction_impact: ["SELECT", "UPDATE"],
    assessment_mastery_adjustment: ALL_TABLE_PRIVILEGES,
    assessment_mastery_projection_repair: ALL_TABLE_PRIVILEGES,
    assessment_regrade_job: ALL_TABLE_PRIVILEGES,
    assessment_regrade_outcome: ["SELECT", "INSERT"],
    attempt: READ_ONLY_PRIVILEGES,
    concept_mastery: ["SELECT", "UPDATE"],
    mastery_evidence: ["SELECT", "INSERT"],
    response: READ_ONLY_PRIVILEGES,
  }),
  learncoding_exam_worker: Object.freeze({
    attempt: ALL_TABLE_PRIVILEGES,
    exam_autosave_mutation: ["SELECT", "INSERT"],
    exam_event: ["SELECT", "INSERT"],
    exam_finalization_job: ALL_TABLE_PRIVILEGES,
    exam_mastery_recheck: ALL_TABLE_PRIVILEGES,
    exam_session: ["SELECT", "UPDATE"],
    response: ALL_TABLE_PRIVILEGES,
  }),
  learncoding_practice_worker: Object.freeze({
    code_submission: ["SELECT", "UPDATE"],
    learner_draft: ["SELECT", "UPDATE"],
    learner_draft_mutation: ["SELECT", "INSERT"],
    runner_job: ["SELECT", "UPDATE"],
  }),
  learncoding_project_worker: Object.freeze({
    appeal: READ_ONLY_PRIVILEGES,
    audit_event: ["SELECT", "INSERT"],
    project: READ_ONLY_PRIVILEGES,
    project_review: READ_ONLY_PRIVILEGES,
    project_review_correction: ["SELECT", "UPDATE"],
    project_review_correction_event: ["SELECT", "INSERT"],
    project_review_effective: READ_ONLY_PRIVILEGES,
    user: READ_ONLY_PRIVILEGES,
  }),
  learncoding_scan_worker: Object.freeze({
    quota_ledger: ["SELECT", "INSERT"],
    stored_object: ["SELECT", "UPDATE"],
    upload_receipt: ["SELECT", "UPDATE"],
  }),
  learncoding_erasure_worker: Object.freeze({
    background_job: ALL_TABLE_PRIVILEGES,
    data_lifecycle_run: ["SELECT", "UPDATE"],
  }),
  learncoding_lifecycle: Object.freeze(Object.fromEntries(TABLE_NAMES.map((table) => [table, ALL_TABLE_PRIVILEGES]))),
  learncoding_platform_seed: Object.freeze({
    achievement: ALL_TABLE_PRIVILEGES,
    activity: ALL_TABLE_PRIVILEGES,
    career_card: ALL_TABLE_PRIVILEGES,
    career_card_prerequisite: ALL_TABLE_PRIVILEGES,
    concept: ALL_TABLE_PRIVILEGES,
    course: ALL_TABLE_PRIVILEGES,
    course_module: ALL_TABLE_PRIVILEGES,
    course_version: ALL_TABLE_PRIVILEGES,
    curriculum_artifact: ALL_TABLE_PRIVILEGES,
    lesson: ALL_TABLE_PRIVILEGES,
    lesson_block: ALL_TABLE_PRIVILEGES,
    lesson_concept: ALL_TABLE_PRIVILEGES,
    module_project_template: ALL_TABLE_PRIVILEGES,
    prerequisite: ALL_TABLE_PRIVILEGES,
    provider_policy: ALL_TABLE_PRIVILEGES,
    test_bundle: ALL_TABLE_PRIVILEGES,
  }),
  learncoding_admin_bootstrap: Object.freeze({
    account: ALL_TABLE_PRIVILEGES,
    audit_event: ["SELECT", "INSERT"],
    session: ALL_TABLE_PRIVILEGES,
    two_factor: ALL_TABLE_PRIVILEGES,
    user: ALL_TABLE_PRIVILEGES,
    verification: ALL_TABLE_PRIVILEGES,
  }),
});

function appPrivilegesFor(table) {
  if (table === "project_review_effective") return READ_ONLY_PRIVILEGES;
  if (APPEND_ONLY_TABLES.has(table)) return APPEND_ONLY_PRIVILEGES;
  return ALL_TABLE_PRIVILEGES;
}

const tables = Object.freeze(Object.fromEntries(TABLE_NAMES.map((table) => {
  const grants = {
    [APP_ROLE]: appPrivilegesFor(table),
    [LEGACY_WORKER_ROLE]: EMPTY_PRIVILEGES,
    [LEGACY_OPS_ROLE]: EMPTY_PRIVILEGES,
  };
  for (const [role, roleTables] of Object.entries(SERVICE_GRANTS)) {
    grants[role] = Object.freeze([...(roleTables[table] ?? EMPTY_PRIVILEGES)]);
  }
  return [table, Object.freeze(grants)];
})));

const routines = Object.freeze({
  "public.enqueue_reward_jobs_for_attempt_v1(uuid,text,timestamp with time zone)": Object.freeze({
    [LEGACY_WORKER_ROLE]: Object.freeze(["EXECUTE"]),
    learncoding_reward_worker: Object.freeze(["EXECUTE"]),
  }),
  "public.enqueue_reward_jobs_for_mastery_scope_v1(uuid,text,timestamp with time zone)": Object.freeze({
    [LEGACY_WORKER_ROLE]: Object.freeze(["EXECUTE"]),
    learncoding_reward_worker: Object.freeze(["EXECUTE"]),
  }),
  "public.delete_learner_protected_history_v1(text)": Object.freeze({
    learncoding_lifecycle: Object.freeze(["EXECUTE"]),
  }),
  "public.publish_project_review_effective_v1(uuid,uuid,uuid,text,text,text,jsonb,jsonb,text,timestamp with time zone)": Object.freeze({
    [APP_ROLE]: Object.freeze(["EXECUTE"]),
    learncoding_project_worker: Object.freeze(["EXECUTE"]),
  }),
});

export const DATABASE_RUNTIME_LOGIN_ROLES = Object.freeze([
  ...new Set([
    LEGACY_WORKER_ROLE,
    LEGACY_OPS_ROLE,
    ...Object.values(DATABASE_SERVICE_CREDENTIALS).map((service) => service.role),
  ]),
].sort());

export const DATABASE_PRIVILEGE_MANIFEST = Object.freeze({
  version: "2026-07-22.v1",
  services: DATABASE_SERVICE_CREDENTIALS,
  tables,
  routines,
  defaultPrivileges: Object.freeze({
    tables: EMPTY_PRIVILEGES,
    sequences: EMPTY_PRIVILEGES,
    types: EMPTY_PRIVILEGES,
    routines: EMPTY_PRIVILEGES,
  }),
});

export function validateDatabasePrivilegeManifest({ tableNames }) {
  if (!Array.isArray(tableNames)) throw new Error("database privilege manifest table inventory is invalid");
  const observed = [...tableNames].sort();
  if (new Set(observed).size !== observed.length) {
    throw new Error("database privilege manifest table inventory is invalid");
  }
  const declared = Object.keys(DATABASE_PRIVILEGE_MANIFEST.tables).sort();
  if (JSON.stringify(observed) !== JSON.stringify(declared)) {
    throw new Error("database privilege manifest does not exactly cover public tables");
  }

  const serviceRoles = Object.values(DATABASE_SERVICE_CREDENTIALS).map((service) => service.role);
  const serviceSecrets = Object.values(DATABASE_SERVICE_CREDENTIALS).map((service) => service.secret);
  if (new Set(serviceRoles).size !== serviceRoles.length || new Set(serviceSecrets).size !== serviceSecrets.length) {
    throw new Error("database service credentials are not isolated");
  }
  for (const [table, grants] of Object.entries(DATABASE_PRIVILEGE_MANIFEST.tables)) {
    for (const [role, privileges] of Object.entries(grants)) {
      if (!DATABASE_RUNTIME_LOGIN_ROLES.includes(role)) {
        throw new Error(`database privilege manifest has unknown role ${role}`);
      }
      if (new Set(privileges).size !== privileges.length || privileges.some((privilege) => !ALLOWED_PRIVILEGES.has(privilege))) {
        throw new Error(`database privilege manifest has invalid table privileges for ${role} on ${table}`);
      }
      const canonical = [...privileges].sort((left, right) => PRIVILEGE_ORDER.indexOf(left) - PRIVILEGE_ORDER.indexOf(right));
      if (JSON.stringify(canonical) !== JSON.stringify(privileges)) {
        throw new Error(`database privilege manifest privileges are not canonical for ${role} on ${table}`);
      }
    }
  }
  for (const [kind, grants] of Object.entries(DATABASE_PRIVILEGE_MANIFEST.defaultPrivileges)) {
    if (grants.length !== 0 || !["tables", "sequences", "types", "routines"].includes(kind)) {
      throw new Error("database default privileges must remain deny-all");
    }
  }
}
