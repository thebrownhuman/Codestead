import { EXAM_MASTERY_RULE_VERSION } from "@/lib/achievements/exam-mastery";
import { pool } from "@/lib/db/client";

export const TROPHY_PRESENTATION_POLICY = "evidence-trophy-cabinet-2026-07-14.v1";

type CertificateTrophyRow = {
  id: string;
  course_title: string;
  course_version_label: string;
  issued_at: Date;
  verification_id: string;
  revoked_at: Date | null;
  selected: boolean;
  portfolio_published: boolean;
  portfolio_slug: string | null;
};

type MasteryTrophyRow = {
  id: string;
  title: string;
  description: string;
  icon: string;
  awarded_at: Date;
  revoked_at: Date | null;
  visibility: string;
  evidence_id: string;
  rule_version: string;
  event: string | null;
  course_id: string | null;
  module_id: string | null;
  minimum_score_percent: string | null;
  critical_requirements_required: string | null;
  attempt_id: string | null;
  attempt_score: number | null;
  attempt_status: string | null;
  mastery_awarded: boolean | null;
  assistance_level: string | null;
  solution_revealed: boolean | null;
  attempt_user_id: string | null;
  selected: boolean;
  portfolio_published: boolean;
  portfolio_slug: string | null;
};

export type Trophy = {
  id: string;
  kind: "course_completion" | "module_mastery";
  title: string;
  description: string;
  icon: string;
  earnedAt: string;
  status: "earned" | "revoked";
  visibility: "private" | "portfolio";
  evidenceLabel: string;
  verificationPath: string | null;
};

function certificateTrophy(row: CertificateTrophyRow): Trophy {
  return {
    id: `certificate:${row.id}`,
    kind: "course_completion",
    title: `${row.course_title} completed`,
    description: `Verified completion of version ${row.course_version_label}.`,
    icon: "trophy",
    earnedAt: row.issued_at.toISOString(),
    status: row.revoked_at ? "revoked" : "earned",
    visibility: row.selected && row.portfolio_published ? "portfolio" : "private",
    evidenceLabel: `Certificate ${row.verification_id.slice(0, 10)}…`,
    verificationPath: `/verify/${row.verification_id}`,
  };
}

export function validIndependentMasteryTrophy(row: MasteryTrophyRow, userId: string): boolean {
  return row.rule_version === EXAM_MASTERY_RULE_VERSION
    && row.event === "exam_mastery"
    && Boolean(row.course_id)
    && Boolean(row.module_id)
    && row.minimum_score_percent === "95"
    && row.critical_requirements_required === "true"
    && Boolean(row.attempt_id)
    && row.evidence_id === `exam-attempt:${row.attempt_id}`
    && row.attempt_user_id === userId
    && row.attempt_status === "graded"
    && row.mastery_awarded === true
    && typeof row.attempt_score === "number"
    && Math.round(row.attempt_score * 10_000) / 10_000 >= 0.95
    && row.assistance_level === "A0"
    && row.solution_revealed === false;
}

function masteryTrophy(row: MasteryTrophyRow): Trophy {
  return {
    id: `mastery:${row.id}`,
    kind: "module_mastery",
    title: row.title,
    description: row.description,
    icon: row.icon,
    earnedAt: row.awarded_at.toISOString(),
    status: row.revoked_at ? "revoked" : "earned",
    visibility: row.selected && row.portfolio_published ? "portfolio" : "private",
    evidenceLabel: "Independent closed-book mastery exam",
    verificationPath: null,
  };
}

export function assembleTrophyCabinet(input: {
  userId: string;
  certificateRows: CertificateTrophyRow[];
  masteryRows: MasteryTrophyRow[];
}) {
  const trophies = [
    ...input.certificateRows.map(certificateTrophy),
    ...input.masteryRows
      .filter((row) => validIndependentMasteryTrophy(row, input.userId))
      .map(masteryTrophy),
  ].sort((left, right) => right.earnedAt.localeCompare(left.earnedAt) || left.id.localeCompare(right.id));
  return {
    policyVersion: TROPHY_PRESENTATION_POLICY,
    rewards: {
      xpSource: "authoritative_reward_ledger" as const,
      coinsEnabled: false as const,
      coins: 0 as const,
      notice: "Projects and trophy views never mint XP, coins, badges, mastery, or certificates.",
    },
    summary: {
      earned: trophies.filter((item) => item.status === "earned").length,
      revoked: trophies.filter((item) => item.status === "revoked").length,
      shared: trophies.filter((item) => item.status === "earned" && item.visibility === "portfolio").length,
    },
    trophies,
  };
}

export async function listOwnTrophyCabinet(userId: string) {
  const [certificates, mastery] = await Promise.all([
    pool.query<CertificateTrophyRow>(
      `select certificate.id,certificate.course_title,certificate.course_version_label,
              certificate.issued_at,certificate.verification_id,revocation.revoked_at,
              (selection.certificate_id is not null) selected,
              coalesce(portfolio.is_published,false) portfolio_published,portfolio.slug portfolio_slug
         from course_certificate certificate
         left join certificate_revocation revocation on revocation.certificate_id=certificate.id
         left join public_portfolio portfolio on portfolio.user_id=certificate.user_id
         left join public_portfolio_certificate selection
           on selection.user_id=certificate.user_id and selection.certificate_id=certificate.id
        where certificate.user_id=$1
        order by certificate.issued_at desc,certificate.id`,
      [userId],
    ),
    pool.query<MasteryTrophyRow>(
      `select owned.id,badge.title,badge.description,badge.icon,owned.awarded_at,owned.revoked_at,
              owned.visibility,owned.evidence_id,badge.rule_version,
              badge.rule->>'event' event,badge.rule->>'courseId' course_id,badge.rule->>'moduleId' module_id,
              badge.rule->>'minimumScorePercent' minimum_score_percent,
              badge.rule->>'criticalRequirementsRequired' critical_requirements_required,
              evidence_attempt.id attempt_id,evidence_attempt.score attempt_score,evidence_attempt.status attempt_status,
              evidence_attempt.mastery_awarded,evidence_attempt.assistance_level,
              evidence_attempt.solution_revealed,evidence_attempt.user_id attempt_user_id,
              (selection.user_achievement_id is not null) selected,
              coalesce(portfolio.is_published,false) portfolio_published,portfolio.slug portfolio_slug
         from user_achievement owned
         join achievement badge on badge.id=owned.achievement_id
         left join attempt evidence_attempt
           on owned.evidence_id='exam-attempt:' || evidence_attempt.id::text
          and evidence_attempt.user_id=owned.user_id
         left join public_portfolio portfolio on portfolio.user_id=owned.user_id
         left join public_portfolio_achievement selection
           on selection.user_id=owned.user_id and selection.user_achievement_id=owned.id
        where owned.user_id=$1 and badge.rule_version=$2
        order by owned.awarded_at desc,owned.id`,
      [userId, EXAM_MASTERY_RULE_VERSION],
    ),
  ]);
  return assembleTrophyCabinet({
    userId,
    certificateRows: certificates.rows,
    masteryRows: mastery.rows,
  });
}
