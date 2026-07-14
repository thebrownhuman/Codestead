import { pool } from "@/lib/db/client";

import { RETENTION_POLICY_VERSION } from "./policy";

export const EXPORT_SCHEMA_VERSION = 16 as const;
export const EXPORT_EXCLUDED_DATA = Object.freeze([
  "provider credential plaintext and ciphertext",
  "password hashes and OAuth tokens",
  "MFA secrets and recovery codes",
  "session tokens, device hashes, and IP addresses",
  "hidden tests, grading keys, and internal exam blueprints",
  "internal runner request hashes and hidden-test-derived admission, correction, form, snapshot, runner, and decision digests",
  "internal module-project start request hashes",
  "other users' records",
  "backup archives and encryption material",
  "notification bodies and action URLs that may contain one-time secrets",
] as const);

const DEFAULT_MAX_RECORDS = 5_000;
const MAX_RECORDS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1_024 * 1_024;
const MAX_BYTES = 20 * 1_024 * 1_024;
const PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type QuerySpec = Readonly<{ category: string; statement: string }>;

const QUERIES: readonly QuerySpec[] = [
  {
    category: "profile",
    statement: `select jsonb_build_object(
      'id', u.id, 'publicId', u.public_id, 'name', u.name, 'email', u.email,
      'emailVerified', u.email_verified, 'status', u.status, 'timezone', u.timezone,
      'createdAt', u.created_at, 'selfReportedLevel', p.self_reported_level,
      'preferredSessionMinutes', p.preferred_session_minutes,
      'weeklyGoalMinutes', p.weekly_goal_minutes,
      'analogyFrequency', p.analogy_frequency, 'analogyInterests', p.analogy_interests,
      'learningGoals', p.learning_goals, 'selectedTracks', p.selected_tracks,
      'dsaLanguage', p.dsa_language, 'publicAlias', p.public_alias, 'bio', p.bio,
      'profileVisibility', p.profile_visibility, 'onboardingCompletedAt', p.onboarding_completed_at
    ) as data from "user" u left join learner_profile p on p.user_id = u.id
    where u.id = $1 order by u.id limit $2 offset $3`,
  },
  {
    category: "consentHistory",
    statement: `select jsonb_build_object(
      'id', c.id, 'purpose', c.purpose, 'policyVersion', c.policy_version,
      'decision', c.decision, 'dataCategories', c.data_categories,
      'source', c.source, 'occurredAt', c.occurred_at
    ) as data from consent_record c where c.user_id = $1
      order by c.occurred_at, c.id limit $2 offset $3`,
  },
  {
    category: "cohortProfile",
    statement: `select jsonb_build_object(
      'alias', p.alias, 'bio', p.bio, 'isPublished', p.is_published,
      'publishedConsentRecordId', p.published_consent_record_id,
      'showBio', p.show_bio, 'showStreak', p.show_streak,
      'showMasterySummary', p.show_mastery_summary,
      'selectedAchievementIds', p.selected_achievement_ids,
      'selectedProjectIds', p.selected_project_ids,
      'rowVersion', p.row_version, 'publishedAt', p.published_at,
      'withdrawnAt', p.withdrawn_at, 'createdAt', p.created_at, 'updatedAt', p.updated_at
    ) as data from cohort_profile p where p.user_id = $1
      order by p.user_id limit $2 offset $3`,
  },
  {
    category: "cohortProfileHistory",
    statement: `select jsonb_build_object(
      'id', e.id, 'requestId', e.request_id, 'event', e.event,
      'snapshot', e.snapshot, 'evidenceHash', e.evidence_hash,
      'reason', e.reason, 'resultingVersion', e.resulting_version,
      'occurredAt', e.occurred_at
    ) as data from cohort_profile_event e where e.user_id = $1
      order by e.occurred_at, e.id limit $2 offset $3`,
  },
  {
    category: "publicPortfolio",
    statement: `select jsonb_build_object(
      'slug', p.slug, 'displayName', p.display_name, 'headline', p.headline,
      'about', p.about, 'isPublished', p.is_published,
      'rowVersion', p.row_version, 'publishedAt', p.published_at,
      'withdrawnAt', p.withdrawn_at, 'createdAt', p.created_at, 'updatedAt', p.updated_at
    ) as data from public_portfolio p where p.user_id = $1
      order by p.user_id limit $2 offset $3`,
  },
  {
    category: "publicPortfolioHistory",
    statement: `select jsonb_build_object(
      'id', e.id, 'requestId', e.request_id, 'event', e.event,
      'snapshot', e.snapshot, 'evidenceHash', e.evidence_hash,
      'reason', e.reason, 'resultingVersion', e.resulting_version,
      'occurredAt', e.occurred_at
    ) as data from public_portfolio_event e where e.user_id = $1
      order by e.occurred_at, e.id limit $2 offset $3`,
  },
  {
    category: "publicPortfolioSelections",
    statement: `select jsonb_build_object(
      'kind', selection.kind, 'selectedId', selection.selected_id,
      'position', selection.position, 'createdAt', selection.created_at
    ) as data from (
      select 'project'::text kind, project_id::text selected_id, position, created_at
        from public_portfolio_project where user_id = $1
      union all
      select 'achievement'::text, user_achievement_id::text, position, created_at
        from public_portfolio_achievement where user_id = $1
      union all
      select 'certificate'::text, certificate_id::text, position, created_at
        from public_portfolio_certificate where user_id = $1
    ) selection order by selection.kind, selection.position, selection.selected_id limit $2 offset $3`,
  },
  {
    category: "publicPortfolioProjectSnapshots",
    statement: `select jsonb_build_object(
      'projectId', snapshot.project_id, 'portfolioVersion', snapshot.portfolio_version,
      'title', snapshot.title, 'summary', snapshot.summary, 'status', snapshot.status,
      'githubUrl', snapshot.github_url,
      'sourceProjectUpdatedAt', snapshot.source_project_updated_at,
      'createdAt', snapshot.created_at
    ) as data from public_portfolio_project_snapshot snapshot where snapshot.user_id = $1
      order by snapshot.portfolio_version, snapshot.project_id limit $2 offset $3`,
  },
  {
    category: "leaderboardScoreEvidence",
    statement: `select jsonb_build_object(
      'id', s.id, 'periodKind', s.period_kind, 'periodKey', s.period_key,
      'periodStart', s.period_start, 'periodEnd', s.period_end,
      'formulaVersion', s.formula_version, 'revision', s.revision,
      'totalPoints', s.total_points, 'components', s.components,
      'evidence', s.evidence, 'evidenceHash', s.evidence_hash,
      'computedAt', s.computed_at
    ) as data from leaderboard_score_snapshot s where s.user_id = $1
      order by s.computed_at, s.id limit $2 offset $3`,
  },
  {
    category: "enrollments",
    statement: `select jsonb_build_object(
      'id', e.id, 'status', e.status, 'implementationLanguage', e.implementation_language,
      'startedAt', e.started_at, 'completedAt', e.completed_at,
      'course', c.slug, 'courseTitle', c.title, 'courseVersion', v.version
    ) as data from enrollment e join course_version v on v.id = e.course_version_id
      join course c on c.id = v.course_id where e.user_id = $1
      order by e.created_at, e.id limit $2 offset $3`,
  },
  {
    category: "planRevisions",
    statement: `select jsonb_build_object(
      'id', p.id, 'enrollmentId', p.enrollment_id, 'revision', p.revision,
      'parentId', p.parent_id, 'source', p.source, 'reason', p.reason,
      'policyVersion', p.policy_version, 'planText', left(p.plan::text, 262144),
      'planTruncated', octet_length(p.plan::text) > 262144,
      'createdAt', p.created_at
    ) as data from plan_revision p join enrollment e on e.id = p.enrollment_id
      where e.user_id = $1 order by p.created_at, p.id limit $2 offset $3`,
  },
  {
    category: "mastery",
    statement: `select jsonb_build_object(
      'conceptId', m.concept_id, 'concept', c.slug, 'languageContext', m.language_context,
      'score', m.score, 'confidence', m.confidence, 'status', m.status,
      'criticalRequirementsMet', m.critical_requirements_met,
      'lastEvidenceAt', m.last_evidence_at, 'lastPracticedAt', m.last_practiced_at,
      'nextReviewAt', m.next_review_at, 'policyVersion', m.policy_version
    ) as data from concept_mastery m join concept c on c.id = m.concept_id
      where m.user_id = $1 order by m.updated_at, m.concept_id limit $2 offset $3`,
  },
  {
    category: "officialEvidence",
    statement: `select jsonb_build_object(
      'id', e.id, 'conceptId', e.concept_id, 'languageContext', e.language_context,
      'evidenceType', e.evidence_type, 'sourceType', e.source_type,
      'sourceId', e.source_id, 'score', e.score, 'weight', e.weight,
      'criticalCriterion', e.critical_criterion, 'validity', e.validity,
      'policyVersion', e.policy_version, 'recordedAt', e.recorded_at
    ) as data from mastery_evidence e where e.user_id = $1
      order by e.recorded_at, e.id limit $2 offset $3`,
  },
  {
    category: "reviewSchedule",
    statement: `select jsonb_build_object(
      'id', r.id, 'conceptId', r.concept_id, 'dueAt', r.due_at,
      'intervalDays', r.interval_days, 'easeFactor', r.ease_factor,
      'reason', r.reason, 'status', r.status, 'completedAttemptId', r.completed_attempt_id,
      'createdAt', r.created_at, 'updatedAt', r.updated_at
    ) as data from review_schedule r where r.user_id = $1
      order by r.created_at, r.id limit $2 offset $3`,
  },
  {
    category: "dailyReviewSessions",
    statement: `select jsonb_build_object(
      'id', s.id, 'localDate', s.local_date, 'timezone', s.timezone,
      'status', s.status, 'availableItemCount', s.available_item_count,
      'questionCount', s.question_count, 'completedCount', s.completed_count,
      'completedAt', s.completed_at, 'createdAt', s.created_at, 'updatedAt', s.updated_at
    ) as data from daily_review_session s where s.user_id = $1
      order by s.local_date, s.id limit $2 offset $3`,
  },
  {
    category: "dailyReviewItems",
    statement: `select jsonb_build_object(
      'id', i.id, 'sessionId', i.session_id, 'position', i.position,
      'skillId', i.skill_id, 'skillTitle', i.skill_title,
      'courseSlug', i.course_slug, 'courseTitle', i.course_title,
      'conceptId', i.concept_id, 'enrollmentId', i.enrollment_id,
      'priorityReason', i.priority_reason, 'confidence', i.confidence,
      'status', i.status, 'activityId', i.activity_id, 'attemptId', i.attempt_id,
      'score', i.score, 'passed', i.passed, 'answeredAt', i.answered_at,
      'createdAt', i.created_at, 'updatedAt', i.updated_at
    ) as data from daily_review_item i where i.user_id = $1
      order by i.created_at, i.session_id, i.position limit $2 offset $3`,
  },
  {
    category: "achievements",
    statement: `select jsonb_build_object(
      'id', u.id, 'slug', a.slug, 'title', a.title, 'description', a.description,
      'icon', a.icon, 'ruleVersion', a.rule_version, 'evidenceId', u.evidence_id,
      'visibility', u.visibility, 'awardedAt', u.awarded_at, 'revokedAt', u.revoked_at
    ) as data from user_achievement u join achievement a on a.id = u.achievement_id
      where u.user_id = $1 order by u.awarded_at, u.id limit $2 offset $3`,
  },
  {
    category: "courseCertificates",
    statement: `select jsonb_build_object(
      'id', certificate.id, 'enrollmentId', certificate.enrollment_id,
      'courseVersionId', certificate.course_version_id,
      'verificationId', certificate.verification_id,
      'learnerDisplayName', certificate.learner_display_name,
      'courseTitle', certificate.course_title,
      'courseVersion', certificate.course_version_label,
      'issueEvidence', certificate.issue_evidence,
      'evidenceHash', certificate.evidence_hash,
      'policyVersion', certificate.policy_version,
      'issuedAt', certificate.issued_at,
      'revokedAt', revocation.revoked_at,
      'revocationReason', revocation.reason
    ) as data from course_certificate certificate
      left join certificate_revocation revocation on revocation.certificate_id = certificate.id
      where certificate.user_id = $1
      order by certificate.issued_at, certificate.id limit $2 offset $3`,
  },
  {
    category: "certificateOperationHistory",
    statement: `select jsonb_build_object(
      'requestId', receipt.request_id, 'operation', receipt.operation,
      'certificateId', receipt.certificate_id, 'result', receipt.result,
      'createdAt', receipt.created_at, 'inputHashIncluded', false
    ) as data from certificate_operation_receipt receipt where receipt.user_id = $1
      order by receipt.created_at, receipt.request_id limit $2 offset $3`,
  },
  {
    category: "rewardLedger",
    statement: `select jsonb_build_object(
      'id', r.id, 'eventKind', r.event_kind, 'rewardCode', r.reward_code,
      'scopeKey', r.scope_key, 'enrollmentId', r.enrollment_id,
      'attemptId', r.attempt_id, 'masteryEvidenceId', r.mastery_evidence_id,
      'sourceEventId', r.source_event_id, 'xpDelta', r.xp_delta,
      'coinDelta', r.coin_delta, 'policyVersion', r.policy_version,
      'requestId', r.request_id, 'reason', r.reason,
      'evidenceOccurredAt', r.evidence_occurred_at, 'occurredAt', r.occurred_at
    ) as data from reward_ledger r where r.user_id = $1
      order by r.occurred_at, r.id limit $2 offset $3`,
  },
  {
    category: "rewardOperationHistory",
    statement: `select jsonb_build_object(
      'requestId', r.request_id, 'operation', r.operation,
      'eventId', r.event_id, 'result', r.result, 'createdAt', r.created_at,
      'inputHashIncluded', false
    ) as data from reward_operation_receipt r where r.user_id = $1
      order by r.created_at, r.request_id limit $2 offset $3`,
  },
  {
    category: "rewardReconciliationHistory",
    statement: `select jsonb_build_object(
      'id', j.id, 'operation', j.operation, 'attemptId', j.attempt_id,
      'masteryEvidenceId', j.mastery_evidence_id, 'status', j.status,
      'generation', j.generation, 'attemptCount', j.attempt_count,
      'nextAttemptAt', j.next_attempt_at, 'lastErrorCode', j.last_error_code,
      'createdAt', j.created_at, 'updatedAt', j.updated_at,
      'leaseCapabilityIncluded', false
    ) as data from reward_reconciliation_job j where j.user_id = $1
      order by j.created_at, j.id limit $2 offset $3`,
  },
  {
    category: "attempts",
    statement: `select jsonb_build_object(
      'id', a.id, 'kind', a.kind, 'attemptNumber', a.attempt_number,
      'status', a.status, 'policyVersion', a.policy_version,
      'contentVersion', a.content_version, 'score', a.score, 'passed', a.passed,
      'masteryAwarded', a.mastery_awarded, 'infrastructureFailure', a.infrastructure_failure,
      'assistanceLevel', a.assistance_level, 'solutionRevealed', a.solution_revealed,
      'helpStep', a.help_step,
      'startedAt', a.started_at, 'submittedAt', a.submitted_at, 'gradedAt', a.graded_at
    ) as data from attempt a where a.user_id = $1
      order by a.created_at, a.id limit $2 offset $3`,
  },
  {
    category: "practiceHelpEvents",
    statement: `select jsonb_build_object(
      'id', h.id, 'attemptId', h.attempt_id, 'requestId', h.request_id,
      'step', h.step, 'kind', h.kind, 'assistanceLevel', h.assistance_level,
      'solutionRevealed', h.solution_revealed, 'createdAt', h.created_at,
      'helpContentIncluded', false
    ) as data from practice_help_event h where h.user_id = $1
      order by h.created_at, h.id limit $2 offset $3`,
  },
  {
    category: "assessmentCorrections",
    statement: `select jsonb_build_object(
      'correctionId', c.id, 'sourceAppealId', c.source_appeal_id,
      'status', c.status, 'defectKind', c.defect_kind,
      'courseId', c.course_id, 'moduleId', c.module_id,
      'itemId', c.item_id, 'skillId', c.skill_id,
      'contentVersion', c.content_version,
      'faultyBundleVersion', c.faulty_bundle_version,
      'replacementBundleVersion', c.replacement_bundle_version,
      'reviewHash', c.review_hash, 'reason', c.reason,
      'attemptId', i.attempt_id, 'formId', i.form_id,
      'answerSetHash', i.answer_set_hash,
      'originalResultHash', i.original_result_hash,
      'jobStatus', j.status, 'jobAttemptCount', j.attempt_count,
      'correctedResult', o.corrected_result,
      'correctedResultHash', o.corrected_result_hash,
      'masteryEffect', m.effect, 'capturedAt', i.captured_at,
      'masteryProjectionRepairs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'skillId', ma.skill_id, 'languageContext', ma.language_context,
          'effect', ma.effect, 'status', mp.status,
          'resolution', mp.resolution_code, 'errorCode', mp.last_error_code,
          'attemptCount', mp.attempt_count, 'appliedAt', mp.applied_at
        ) order by ma.skill_id, ma.language_context)
          from assessment_mastery_adjustment ma
          join assessment_mastery_projection_repair mp on mp.adjustment_id = ma.id
         where ma.outcome_id = o.id
      ), '[]'::jsonb),
      'correctedAt', o.created_at,
      'hiddenTestsIncluded', false, 'sourceCodeIncluded', false,
      'projectionSnapshotsIncluded', false
    ) as data from assessment_correction_impact i
      join assessment_correction c on c.id = i.correction_id
      left join assessment_regrade_job j on j.impact_id = i.id
      left join assessment_regrade_outcome o on o.impact_id = i.id
      left join assessment_mastery_adjustment m on m.outcome_id = o.id and m.skill_id = c.skill_id
      where i.user_id = $1 order by i.captured_at, i.id limit $2 offset $3`,
  },
  {
    category: "assessmentResponses",
    statement: `select jsonb_build_object(
      'id', r.id, 'attemptId', r.attempt_id, 'itemKey', r.item_key,
      'revision', r.revision, 'answerText', left(r.answer::text, 524288),
      'answerTruncated', octet_length(r.answer::text) > 524288,
      'source', r.source, 'savedAt', r.saved_at, 'submittedAt', r.submitted_at
    ) as data from response r join attempt a on a.id = r.attempt_id
      where a.user_id = $1 and left(r.item_key, 2) <> '__'
      order by r.saved_at, r.id limit $2 offset $3`,
  },
  {
    category: "examSessions",
    statement: `select jsonb_build_object(
      'id', e.id, 'attemptId', e.attempt_id, 'status', e.status,
      'serverStartedAt', e.server_started_at, 'serverDeadlineAt', e.server_deadline_at,
      'lastHeartbeatAt', e.last_heartbeat_at, 'disconnectedSeconds', e.disconnected_seconds,
      'integrityReviewState', e.integrity_review_state,
      'createdAt', e.created_at, 'updatedAt', e.updated_at
    ) as data from exam_session e where e.user_id = $1
      order by e.created_at, e.id limit $2 offset $3`,
  },
  {
    category: "examIntegrityEvents",
    statement: `select jsonb_build_object(
      'id', v.id, 'examSessionId', v.exam_session_id, 'type', v.type,
      'metadataIncluded', false, 'occurredAt', v.occurred_at
    ) as data from exam_event v join exam_session e on e.id = v.exam_session_id
      where e.user_id = $1 order by v.occurred_at, v.id limit $2 offset $3`,
  },
  {
    category: "examFinalizationJobs",
    statement: `select jsonb_build_object(
      'id', j.id, 'examSessionId', j.exam_session_id, 'status', j.status,
      'dueAt', j.due_at, 'attemptCount', j.attempt_count,
      'lastErrorCode', j.last_error_code, 'completedAt', j.completed_at,
      'createdAt', j.created_at, 'updatedAt', j.updated_at,
      'workerIdentityIncluded', false
    ) as data from exam_finalization_job j join exam_session e on e.id = j.exam_session_id
      where e.user_id = $1 order by j.created_at, j.id limit $2 offset $3`,
  },
  {
    category: "examReexamGrants",
    statement: `select jsonb_build_object(
      'id', g.id, 'requestId', g.request_id, 'sourceExamSessionId', g.source_exam_session_id,
      'moduleId', g.module_id, 'reason', g.reason, 'evidence', g.evidence,
      'evidenceHash', g.evidence_hash, 'status', g.status,
      'consumedByAttemptId', g.consumed_by_attempt_id, 'consumedAt', g.consumed_at,
      'createdAt', g.created_at, 'updatedAt', g.updated_at,
      'administratorIdentityIncluded', false
    ) as data from exam_reexam_grant g where g.user_id = $1
      order by g.created_at, g.id limit $2 offset $3`,
  },
  {
    category: "examMasteryRechecks",
    statement: `select jsonb_build_object(
      'id', r.id, 'sourceAttemptId', r.source_attempt_id, 'moduleId', r.module_id,
      'contentVersion', r.content_version, 'policyVersion', r.policy_version,
      'status', r.status, 'dueAt', r.due_at,
      'targetClusterIds', r.target_cluster_ids, 'targetCodingItemIds', r.target_coding_item_ids,
      'recheckAttemptId', r.recheck_attempt_id, 'completedAt', r.completed_at,
      'resultOutcome', r.result_outcome, 'createdAt', r.created_at, 'updatedAt', r.updated_at
    ) as data from exam_mastery_recheck r where r.user_id = $1
      order by r.created_at, r.id limit $2 offset $3`,
  },
  {
    category: "chatMessages",
    statement: `select jsonb_build_object(
      'id', m.id, 'threadId', m.thread_id, 'threadTitle', t.title, 'role', m.role,
      'threadStatus', t.status, 'threadCreatedAt', t.created_at, 'threadUpdatedAt', t.updated_at,
      'content', left(m.content, 131072),
      'contentTruncated', octet_length(m.content) > 131072,
      'curriculumRefs', m.curriculum_refs, 'createdAt', m.created_at,
      'provider', mc.provider, 'model', mc.model, 'promptVersion', mc.prompt_version,
      'credentialSource', mc.context_manifest->>'credentialSource'
    ) as data from chat_message m join chat_thread t on t.id = m.thread_id
      left join model_call mc on mc.id = m.model_call_id
      where t.user_id = $1 order by m.created_at, m.id limit $2 offset $3`,
  },
  {
    category: "codeSubmissions",
    statement: `select jsonb_build_object(
      'id', s.id, 'attemptId', s.attempt_id, 'activityId', s.activity_id,
      'language', s.language, 'sourceCode', left(s.source_code, 524288),
      'sourceTruncated', octet_length(s.source_code) > 524288,
      'sourceHash', s.source_hash, 'submissionType', s.submission_type,
      'requestId', s.request_id,
      'runtimeImageDigest', s.runtime_image_digest, 'status', s.status,
      'runnerJob', case when j.id is null then null else jsonb_build_object(
        'id', j.id, 'status', j.status, 'queuedAt', j.queued_at,
        'startedAt', j.started_at, 'completedAt', j.completed_at
      ) end,
      'createdAt', s.created_at
    ) as data from code_submission s
      left join runner_job j on j.submission_id = s.id where s.user_id = $1
      order by s.created_at, s.id limit $2 offset $3`,
  },
  {
    category: "learnerDrafts",
    statement: `select jsonb_build_object(
      'id', d.id, 'kind', d.kind, 'courseId', d.course_id, 'skillId', d.skill_id,
      'language', d.language, 'content', d.content, 'rowVersion', d.row_version,
      'createdAt', d.created_at, 'updatedAt', d.updated_at
    ) as data from learner_draft d where d.user_id = $1
      order by d.updated_at, d.id limit $2 offset $3`,
  },
  {
    category: "learnerDraftMutationHistory",
    statement: `select jsonb_build_object(
      'requestId', m.request_id, 'draftId', m.draft_id,
      'expectedRowVersion', m.expected_row_version,
      'resultingRowVersion', m.resulting_row_version,
      'inputHash', m.input_hash, 'resultingUpdatedAt', m.resulting_updated_at,
      'createdAt', m.created_at
    ) as data from learner_draft_mutation m
      join learner_draft d on d.id = m.draft_id where d.user_id = $1
      order by m.created_at, m.request_id limit $2 offset $3`,
  },
  {
    category: "aiRequestLedger",
    statement: `select jsonb_build_object(
      'id', m.id, 'provider', m.provider, 'model', m.model, 'operation', m.operation,
      'promptVersion', m.prompt_version, 'contextManifestIncluded', false,
      'inputTokens', m.input_tokens, 'outputTokens', m.output_tokens,
      'latencyMs', m.latency_ms, 'status', m.status, 'errorCode', m.error_code,
      'requestHash', m.request_hash, 'responseHash', m.response_hash,
      'createdAt', m.created_at
    ) as data from model_call m where m.user_id = $1
      order by m.created_at, m.id limit $2 offset $3`,
  },
  {
    category: "projects",
    statement: `select jsonb_build_object(
      'id', p.id, 'title', p.title, 'summary', p.summary, 'status', p.status,
      'visibility', p.visibility, 'prdText', left(coalesce(p.prd::text, ''), 262144),
      'prdTruncated', octet_length(coalesce(p.prd::text, '')) > 262144,
      'githubUrl', p.github_url, 'githubCommitSha', p.github_commit_sha,
      'assignmentTemplateId', p.assignment_template_id,
      'assignmentContentHash', p.assignment_content_hash,
      'assignmentStageAtStart', p.assignment_stage_at_start,
      'assignmentProvenance', p.assignment_provenance,
      'createdAt', p.created_at, 'updatedAt', p.updated_at
    ) as data from project p where p.user_id = $1
      order by p.created_at, p.id limit $2 offset $3`,
  },
  {
    category: "moduleProjectStartHistory",
    statement: `select jsonb_build_object(
      'requestId', receipt.request_id, 'templateId', receipt.template_id,
      'projectId', receipt.project_id, 'templateKey', template.template_key,
      'templateVersion', template.template_version,
      'templateContentHash', template.content_hash,
      'templateStageNow', template.stage,
      'title', template.title, 'createdAt', receipt.created_at,
      'inputHashIncluded', false
    ) as data from module_project_start_receipt receipt
      join module_project_template template on template.id = receipt.template_id
      join project owned on owned.id = receipt.project_id and owned.user_id = receipt.user_id
      where receipt.user_id = $1
      order by receipt.created_at, receipt.request_id limit $2 offset $3`,
  },
  {
    category: "projectReviews",
    statement: `select jsonb_build_object(
      'id', r.id, 'projectId', r.project_id, 'commitSha', r.commit_sha,
      'analyzerVersion', r.analyzer_version, 'rubricVersion', r.rubric_version,
      'analysisProvenance', r.analysis_provenance, 'findingsHash', r.findings_hash,
      'findingsText', left(r.findings::text, 262144),
      'findingsTruncated', octet_length(r.findings::text) > 262144,
      'status', r.status, 'createdAt', r.created_at
    ) as data from project_review r join project p on p.id = r.project_id
      where p.user_id = $1 order by r.created_at, r.id limit $2 offset $3`,
  },
  {
    category: "projectReviewCorrections",
    statement: `select jsonb_build_object(
      'id', c.id, 'projectId', c.project_id, 'sourceReviewId', c.source_review_id,
      'sourceAppealId', c.source_appeal_id, 'revision', c.revision, 'status', c.status,
      'reason', c.reason, 'sourceCommitSha', c.source_commit_sha,
      'sourceAnalyzerVersion', c.source_analyzer_version, 'sourceRubricVersion', c.source_rubric_version,
      'sourceProvenance', c.source_provenance, 'sourceFindingsHash', c.source_findings_hash,
      'targetAnalyzerVersion', c.target_analyzer_version, 'targetRubricVersion', c.target_rubric_version,
      'resultProvenance', c.result_provenance, 'resultFindingsHash', c.result_findings_hash,
      'resultFindingsText', left(coalesce(c.result_findings::text,''), 262144),
      'resultFindingsTruncated', octet_length(coalesce(c.result_findings::text,'')) > 262144,
      'evidence', case when c.evidence is null then null else jsonb_strip_nulls(jsonb_build_object(
        'schemaVersion', c.evidence -> 'schemaVersion',
        'correctionId', c.evidence -> 'correctionId',
        'correctionRevision', c.evidence -> 'correctionRevision',
        'sourceAppealId', c.evidence -> 'sourceAppealId',
        'source', c.evidence -> 'source',
        'result', c.evidence -> 'result',
        'authority', jsonb_build_object(
          'adminReasonHash', c.evidence #> '{authority,adminReasonHash}'
        ),
        'execution', c.evidence -> 'execution',
        'projection', c.evidence -> 'projection',
        'completedAt', c.evidence -> 'completedAt'
      )) end,
      'evidenceRedacted', c.evidence is not null,
      'evidenceHash', c.evidence_hash,
      'evidenceHashVerifiableFromExport', false,
      'projectionApplied', c.projection_applied, 'attemptCount', c.attempt_count,
      'lastErrorCode', c.last_error_code, 'deadLetteredAt', c.dead_lettered_at,
      'startedAt', c.started_at, 'completedAt', c.completed_at,
      'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'workerIdentityIncluded', false, 'administratorIdentityIncluded', false
    ) as data from project_review_correction c join project p on p.id = c.project_id
      where p.user_id = $1 order by c.created_at, c.id limit $2 offset $3`,
  },
  {
    category: "projectReviewCorrectionEvents",
    statement: `select jsonb_build_object(
      'id', e.id, 'correctionId', e.correction_id, 'event', e.event,
      'actorRole', e.actor_role, 'reason', e.reason, 'evidence', e.evidence,
      'evidenceHash', e.evidence_hash, 'occurredAt', e.occurred_at,
      'actorIdentityIncluded', false
    ) as data from project_review_correction_event e
      join project_review_correction c on c.id = e.correction_id
      join project p on p.id = c.project_id where p.user_id = $1
      order by e.occurred_at, e.id limit $2 offset $3`,
  },
  {
    category: "projectReviewEffective",
    statement: `select jsonb_build_object(
      'projectId', e.project_id, 'sourceReviewId', e.source_review_id,
      'correctionId', e.correction_id, 'commitSha', e.commit_sha,
      'analyzerVersion', e.analyzer_version, 'rubricVersion', e.rubric_version,
      'provenance', e.provenance, 'findingsHash', e.findings_hash,
      'findingsText', left(e.findings::text, 262144),
      'findingsTruncated', octet_length(e.findings::text) > 262144,
      'revision', e.revision, 'updatedAt', e.updated_at
    ) as data from project_review_effective e join project p on p.id = e.project_id
      where p.user_id = $1 order by e.updated_at, e.project_id limit $2 offset $3`,
  },
  {
    category: "projectRevisions",
    statement: `select jsonb_build_object(
      'id', r.id, 'projectId', r.project_id, 'sequence', r.sequence,
      'clientRequestId', r.client_request_id, 'inputHash', r.input_hash,
      'changeSummary', r.change_summary, 'reflection', r.reflection,
      'createdAt', r.created_at
    ) as data from project_revision r join project p on p.id = r.project_id
      where p.user_id = $1 order by r.created_at, r.id limit $2 offset $3`,
  },
  {
    category: "projectRevisionFiles",
    statement: `select jsonb_build_object(
      'revisionId', f.revision_id, 'ordinal', f.ordinal,
      'objectId', f.object_id, 'originalName', f.original_name,
      'mediaType', f.media_type, 'sizeBytes', f.size_bytes,
      'sha256', f.sha256, 'createdAt', f.created_at,
      'binaryIncluded', false
    ) as data from project_revision_object f
      join project_revision r on r.id = f.revision_id
      join project p on p.id = r.project_id
      where p.user_id = $1 order by r.sequence, f.ordinal limit $2 offset $3`,
  },
  {
    category: "storedFileMetadata",
    statement: `select jsonb_build_object(
      'id', o.id, 'originalName', o.original_name, 'mediaType', o.media_type,
      'sizeBytes', o.size_bytes, 'sha256', o.sha256, 'scanStatus', o.scan_status,
      'retentionClass', o.retention_class, 'createdAt', o.created_at,
      'deletedAt', o.deleted_at, 'binaryIncluded', false
    ) as data from stored_object o where o.owner_user_id = $1
      order by o.created_at, o.id limit $2 offset $3`,
  },
  {
    category: "securitySessionHistory",
    statement: `select jsonb_build_object(
      'sessionId', h.original_session_id, 'deviceLabel', h.device_label,
      'startedAt', h.started_at, 'lastSeenAt', h.last_seen_at,
      'expiresAt', h.expires_at, 'endedAt', h.ended_at, 'endReason', h.end_reason
    ) as data from auth_session_history h where h.user_id = $1
      order by h.ended_at, h.id limit $2 offset $3`,
  },
  {
    category: "activeSessionMetadata",
    statement: `select jsonb_build_object(
      'deviceLabel', s.device_label, 'createdAt', s.created_at,
      'lastSeenAt', s.last_seen_at, 'expiresAt', s.expires_at,
      'revokedAt', s.revoked_at, 'sessionTokenIncluded', false,
      'networkAndDeviceFingerprintIncluded', false
    ) as data from "session" s where s.user_id = $1
      order by s.created_at limit $2 offset $3`,
  },
  {
    category: "deviceRevocationRequests",
    statement: `select jsonb_build_object(
      'id', r.id, 'reason', r.reason, 'status', r.status,
      'decisionReason', r.decision_reason, 'decidedAt', r.decided_at,
      'createdAt', r.created_at, 'updatedAt', r.updated_at,
      'sessionIdentifierIncluded', false
    ) as data from session_revocation_request r where r.user_id = $1
      order by r.created_at, r.id limit $2 offset $3`,
  },
  {
    category: "learningSessions",
    statement: `select jsonb_build_object(
      'id', s.id, 'enrollmentId', s.enrollment_id, 'goal', s.goal,
      'plannedMinutes', s.planned_minutes, 'status', s.status,
      'startedAt', s.started_at, 'lastActivityAt', s.last_activity_at,
      'endedAt', s.ended_at
    ) as data from learning_session s where s.user_id = $1
      order by s.started_at, s.id limit $2 offset $3`,
  },
  {
    category: "learningSessionEvents",
    statement: `select jsonb_build_object(
      'id', e.id, 'sessionId', e.session_id, 'type', e.type,
      'subjectType', e.subject_type, 'metadataIncluded', false,
      'clientTime', e.client_time, 'occurredAt', e.occurred_at
    ) as data from learning_session_event e where e.user_id = $1
      order by e.occurred_at, e.id limit $2 offset $3`,
  },
  {
    category: "auditSummary",
    statement: `select jsonb_build_object(
      'action', a.action, 'resourceType', a.resource_type, 'resourceIdentifierIncluded', false,
      'reasonIncluded', false, 'outcome', a.outcome, 'occurredAt', a.occurred_at
    ) as data from audit_event a
      where a.actor_user_id = $1 or a.subject_user_id = $1
      order by a.occurred_at, a.id limit $2 offset $3`,
  },
  {
    category: "requestsAndAppeals",
    statement: `select jsonb_build_object(
      'recordType', 'learning_request', 'id', r.id, 'kind', r.kind,
      'subject', r.subject, 'details', r.details, 'status', r.status,
      'decisionReason', r.decision_reason, 'createdAt', r.created_at
    ) as data from learning_request r where r.user_id = $1
      order by r.created_at, r.id limit $2 offset $3`,
  },
  {
    category: "requestsAndAppeals",
    statement: `select jsonb_build_object(
      'recordType', 'appeal', 'id', a.id, 'attemptId', a.attempt_id,
      'projectReviewId', a.project_review_id, 'reason', a.reason,
      'evidence', a.evidence, 'status', a.status, 'decision', a.decision,
      'decisionReason', a.decision_reason, 'createdAt', a.created_at,
      'decidedAt', a.decided_at
    ) as data from appeal a where a.user_id = $1
      order by a.created_at, a.id limit $2 offset $3`,
  },
  {
    category: "notifications",
    statement: `select jsonb_build_object(
      'id', n.id, 'type', n.type, 'title', n.title,
      'bodyIncluded', false, 'actionUrlIncluded', false,
      'readAt', n.read_at, 'createdAt', n.created_at
    ) as data from notification n where n.user_id = $1
      order by n.created_at, n.id limit $2 offset $3`,
  },
  {
    category: "inactivityEpisodes",
    statement: `select jsonb_build_object(
      'id', i.id, 'lastActivityAt', i.last_activity_at, 'openedAt', i.opened_at,
      'eligibleAt', i.eligible_at, 'secondEligibleAt', i.second_eligible_at,
      'learnerFirstQueuedAt', i.learner_first_queued_at,
      'adminNoticeQueuedAt', i.admin_notice_queued_at,
      'learnerSecondQueuedAt', i.learner_second_queued_at,
      'policyVersion', i.policy_version, 'closedAt', i.closed_at,
      'createdAt', i.created_at, 'updatedAt', i.updated_at
    ) as data from inactivity_episode i where i.user_id = $1
      order by i.opened_at, i.id limit $2 offset $3`,
  },
  {
    category: "notificationPreferences",
    statement: `select jsonb_build_object(
      'dailyStudyEnabled', p.daily_study_enabled,
      'revisionEnabled', p.revision_enabled, 'goalEnabled', p.goal_enabled,
      'challengeEnabled', p.challenge_enabled,
      'weeklySummaryEnabled', p.weekly_summary_enabled,
      'learningEmailEnabled', p.learning_email_enabled,
      'timezone', p.timezone, 'dailyStudyMinute', p.daily_study_minute,
      'revisionMinute', p.revision_minute,
      'quietHoursEnabled', p.quiet_hours_enabled,
      'quietStartMinute', p.quiet_start_minute, 'quietEndMinute', p.quiet_end_minute,
      'inactivityPausedUntil', p.inactivity_paused_until,
      'inactivityPauseReason', p.inactivity_pause_reason,
      'rowVersion', p.row_version, 'createdAt', p.created_at, 'updatedAt', p.updated_at
    ) as data from notification_preference p where p.user_id = $1
      order by p.user_id limit $2 offset $3`,
  },
  {
    category: "smartReminderDispatches",
    statement: `select jsonb_build_object(
      'id', d.id, 'kind', d.kind, 'localPeriodKey', d.local_period_key,
      'timezone', d.timezone, 'evidence', d.evidence,
      'scheduledFor', d.scheduled_for, 'dispatchedAt', d.dispatched_at
    ) as data from smart_reminder_dispatch d where d.user_id = $1
      order by d.dispatched_at, d.id limit $2 offset $3`,
  },
  {
    category: "emailDeliveryMetadata",
    statement: `select jsonb_build_object(
      'id', e.id, 'template', e.template, 'templateVersion', e.template_version,
      'status', e.status, 'attemptCount', e.attempt_count,
      'nextAttemptAt', e.next_attempt_at, 'sentAt', e.sent_at,
      'createdAt', e.created_at, 'updatedAt', e.updated_at,
      'recipientAndVariablesIncluded', false
    ) as data from email_outbox e where e.user_id = $1
      order by e.created_at, e.id limit $2 offset $3`,
  },
  {
    category: "storageQuotaLedger",
    statement: `select jsonb_build_object(
      'id', q.id, 'objectId', q.object_id, 'operation', q.operation,
      'bytes', q.bytes, 'occurredAt', q.occurred_at
    ) as data from quota_ledger q where q.user_id = $1
      order by q.occurred_at, q.id limit $2 offset $3`,
  },
  {
    category: "storageQuotaChanges",
    statement: `select jsonb_build_object(
      'requestId', q.request_id, 'requestedBytes', q.requested_bytes,
      'expectedRowVersion', q.expected_row_version,
      'previousQuotaBytes', q.previous_quota_bytes,
      'previousRowVersion', q.previous_row_version,
      'usedBytesAtChange', q.used_bytes_at_change,
      'resultingRowVersion', q.resulting_row_version,
      'reason', q.reason, 'createdAt', q.created_at
    ) as data from storage_quota_change q where q.learner_user_id = $1
      order by q.created_at, q.request_id limit $2 offset $3`,
  },
  {
    category: "communityGroups",
    statement: `select jsonb_build_object(
      'id', g.id, 'name', g.name, 'description', g.description,
      'visibility', g.visibility, 'status', g.status,
      'membershipRole', member.role, 'joinedAt', member.joined_at,
      'createdByLearner', g.created_by_user_id = $1,
      'rowVersion', g.row_version, 'createdAt', g.created_at, 'updatedAt', g.updated_at
    ) as data from community_group g
      left join community_group_member member
        on member.group_id = g.id and member.user_id = $1
      where g.created_by_user_id = $1 or member.user_id is not null
      order by g.created_at, g.id limit $2 offset $3`,
  },
  {
    category: "communityOperationHistory",
    statement: `select jsonb_build_object(
      'requestId', receipt.request_id, 'action', receipt.action,
      'result', receipt.result, 'inputHashIncluded', false,
      'createdAt', receipt.created_at
    ) as data from community_operation_receipt receipt where receipt.user_id = $1
      order by receipt.created_at, receipt.id limit $2 offset $3`,
  },
  {
    category: "communityPosts",
    statement: `select jsonb_build_object(
      'id', p.id, 'groupId', p.group_id, 'kind', p.kind,
      'title', p.title, 'body', p.body, 'state', p.state,
      'rowVersion', p.row_version, 'editedAt', p.edited_at,
      'deletedAt', p.deleted_at, 'moderationReason', p.moderation_reason,
      'createdAt', p.created_at, 'updatedAt', p.updated_at
    ) as data from community_post p where p.author_user_id = $1
      order by p.created_at, p.id limit $2 offset $3`,
  },
  {
    category: "communityReplies",
    statement: `select jsonb_build_object(
      'id', r.id, 'postId', r.post_id, 'body', r.body, 'state', r.state,
      'rowVersion', r.row_version, 'editedAt', r.edited_at,
      'deletedAt', r.deleted_at, 'moderationReason', r.moderation_reason,
      'createdAt', r.created_at, 'updatedAt', r.updated_at
    ) as data from community_reply r where r.author_user_id = $1
      order by r.created_at, r.id limit $2 offset $3`,
  },
  {
    category: "communityReports",
    statement: `select jsonb_build_object(
      'id', r.id, 'postId', r.post_id, 'replyId', r.reply_id,
      'reason', r.reason, 'details', r.details, 'status', r.status,
      'decisionReason', r.decision_reason, 'decidedAt', r.decided_at,
      'createdAt', r.created_at, 'updatedAt', r.updated_at
    ) as data from community_report r where r.reporter_user_id = $1
      order by r.created_at, r.id limit $2 offset $3`,
  },
  {
    category: "communityModerationHistory",
    statement: `select jsonb_build_object(
      'id', event.id, 'reportId', event.report_id,
      'postId', event.post_id, 'replyId', event.reply_id,
      'action', event.action, 'priorState', event.prior_state,
      'resultingState', event.resulting_state, 'reason', event.reason,
      'occurredAt', event.occurred_at,
      'moderatorIdentityIncluded', false
    ) as data from community_moderation_event event
      where exists (
        select 1 from community_post p
         where p.id = event.post_id and p.author_user_id = $1
      ) or exists (
        select 1 from community_reply r
         where r.id = event.reply_id and r.author_user_id = $1
      ) or exists (
        select 1 from community_report report
         where report.id = event.report_id and report.reporter_user_id = $1
      )
      order by event.occurred_at, event.id limit $2 offset $3`,
  },
  {
    category: "codingBattles",
    statement: `select jsonb_build_object(
      'id', battle.id, 'scope', battle.scope,
      'competitionKey', battle.competition_key, 'title', battle.title,
      'language', battle.language, 'skillKey', battle.skill_key,
      'challengeKind', battle.challenge_kind,
      'scoringVersion', battle.scoring_version, 'maxPoints', battle.max_points,
      'status', battle.status, 'startsAt', battle.starts_at,
      'endsAt', battle.ends_at, 'revealAt', battle.reveal_at,
      'participantRole', participant.role, 'joinedAt', participant.joined_at,
      'createdByLearner', battle.creator_user_id = $1,
      'gradingSnapshotIncluded', false,
      'createdAt', battle.created_at, 'updatedAt', battle.updated_at
    ) as data from coding_battle battle
      left join coding_battle_participant participant
        on participant.battle_id = battle.id and participant.user_id = $1
      where battle.creator_user_id = $1 or participant.user_id is not null
      order by battle.created_at, battle.id limit $2 offset $3`,
  },
  {
    category: "codingBattleSubmissions",
    statement: `select jsonb_build_object(
      'id', submission.id, 'battleId', submission.battle_id,
      'answer', submission.answer, 'sourceAttemptId', submission.source_attempt_id,
      'score', case when battle.reveal_at <= now() then submission.score else null end,
      'passed', case when battle.reveal_at <= now() then submission.passed else null end,
      'resultEvidence', case when battle.reveal_at <= now() then submission.result_evidence else null end,
      'resultsSealed', battle.reveal_at > now(),
      'submittedAt', submission.submitted_at, 'createdAt', submission.created_at,
      'internalRequestAndAnswerHashesIncluded', false
    ) as data from coding_battle_submission submission
      join coding_battle battle on battle.id = submission.battle_id
      where submission.user_id = $1
      order by submission.submitted_at, submission.id limit $2 offset $3`,
  },
] as const;

export type ExportMetrics = Readonly<{
  runId: string;
  records: number;
  bytes: number;
  truncated: boolean;
  completed: boolean;
}>;

export function exportBounds(input: { maxRecords?: number; maxBytes?: number }) {
  const records = input.maxRecords ?? DEFAULT_MAX_RECORDS;
  const bytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(records) || records < 1 || records > MAX_RECORDS) {
    throw new Error(`maxRecords must be from 1 to ${MAX_RECORDS}.`);
  }
  if (!Number.isSafeInteger(bytes) || bytes < 1_024 || bytes > MAX_BYTES) {
    throw new Error(`maxBytes must be from 1024 to ${MAX_BYTES}.`);
  }
  return { maxRecords: records, maxBytes: bytes };
}

export function encodeExportLine(value: Record<string, unknown>) {
  return `${JSON.stringify(value)}\n`;
}

function encodeExportFooter(input: {
  records: number;
  bytesBeforeFooter: number;
  truncated: boolean;
}) {
  return encodeExportLine({
    type: "footer",
    records: input.records,
    bytesBeforeFooter: input.bytesBeforeFooter,
    truncated: input.truncated,
    completed: true,
  });
}

export async function createLearnerExport(input: {
  learnerId: string;
  actorUserId: string;
  requestId: string;
  now?: Date;
  maxRecords?: number;
  maxBytes?: number;
}) {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("A valid export timestamp is required.");
  if (!UUID_PATTERN.test(input.requestId)) throw new Error("requestId must be a UUID.");
  const limits = exportBounds(input);
  const inserted = await pool.query<{ id: string }>(
    `insert into data_lifecycle_run
      (operation, policy_version, idempotency_key, dry_run, status, actor_user_id, target_user_id, started_at)
     select 'export', $1, $2, false, 'running', actor.id, target.id, $5
       from "user" actor
      join "user" target on target.id = $4
      where actor.id = $3 and actor.role = 'admin' and actor.status = 'active'
        and target.role = 'learner' and target.status not in ('deletion_pending', 'deleted')
     on conflict (idempotency_key) do nothing returning id`,
    [
      RETENTION_POLICY_VERSION,
      `export:${input.learnerId}:${input.requestId}`,
      input.actorUserId,
      input.learnerId,
      now,
    ],
  );
  const runId = inserted.rows[0]?.id;
  if (!runId) {
    throw new Error("Export is not authorized, the learner is unavailable, or this request id was already used.");
  }

  let resolveCompletion!: (metrics: ExportMetrics) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<ExportMetrics>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let records = 0;
      let bytes = 0;
      let truncated = false;
      const enqueue = (line: string, reserveBytes = 0) => {
        const encoded = encoder.encode(line);
        if (bytes + encoded.byteLength + reserveBytes > limits.maxBytes) return false;
        controller.enqueue(encoded);
        bytes += encoded.byteLength;
        return true;
      };
      // Reserve the encoded worst-case footer for this request instead of a
      // magic allowance. The largest permitted record/byte values and the
      // longer boolean spelling make this an upper bound for the final footer.
      const footerReserveBytes = encoder.encode(encodeExportFooter({
        records: limits.maxRecords,
        bytesBeforeFooter: limits.maxBytes,
        truncated: false,
      })).byteLength;
      try {
        if (!enqueue(encodeExportLine({
          type: "manifest",
          schemaVersion: EXPORT_SCHEMA_VERSION,
          policyVersion: RETENTION_POLICY_VERSION,
          generatedAt: now.toISOString(),
          learnerId: input.learnerId,
          limits,
          excluded: EXPORT_EXCLUDED_DATA,
          note: "Binary file contents are not embedded; downloadable file metadata is included.",
        }), footerReserveBytes)) {
          throw new Error("Export byte limit is too small for its manifest and footer.");
        }
        outer: for (let queryIndex = 0; queryIndex < QUERIES.length; queryIndex += 1) {
          const query = QUERIES[queryIndex]!;
          let offset = 0;
          while (records < limits.maxRecords) {
            const pageLimit = Math.min(PAGE_SIZE, limits.maxRecords - records);
            const result = await pool.query<{ data: Record<string, unknown> }>(
              query.statement,
              [input.learnerId, pageLimit + 1, offset],
            );
            if (!result.rows.length) break;
            const rows = result.rows.slice(0, pageLimit);
            const hasMoreInQuery = result.rows.length > pageLimit;
            for (const row of rows) {
              const line = encodeExportLine({ type: "record", category: query.category, data: row.data });
              if (!enqueue(line, footerReserveBytes)) {
                truncated = true;
                break outer;
              }
              records += 1;
              if (records >= limits.maxRecords) {
                truncated = hasMoreInQuery;
                if (!truncated) {
                  for (const remaining of QUERIES.slice(queryIndex + 1)) {
                    const probe = await pool.query(
                      remaining.statement,
                      [input.learnerId, 1, 0],
                    );
                    if (probe.rows.length) {
                      truncated = true;
                      break;
                    }
                  }
                }
                break outer;
              }
            }
            offset += rows.length;
            if (!hasMoreInQuery) break;
          }
        }
        if (!enqueue(encodeExportFooter({
          records,
          bytesBeforeFooter: bytes,
          truncated,
        }))) {
          throw new Error("Export footer exceeded its reserved byte budget.");
        }
        controller.close();
        const metrics = { runId, records, bytes, truncated, completed: true } as const;
        await pool.query(
          `update data_lifecycle_run set status = 'succeeded', report = $2::jsonb,
             completed_at = $3, updated_at = $3 where id = $1`,
          [runId, JSON.stringify(metrics), new Date()],
        );
        resolveCompletion(metrics);
      } catch (error) {
        controller.error(error);
        await pool.query(
          `update data_lifecycle_run set status = 'failed', error_code = 'EXPORT_STREAM_FAILED',
             completed_at = $2, updated_at = $2 where id = $1`,
          [runId, new Date()],
        ).catch(() => undefined);
        rejectCompletion(error);
      }
    },
  });
  return { stream, completion, runId };
}
