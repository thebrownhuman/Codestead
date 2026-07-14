import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { hashSocialEvidence } from "@/lib/social/hash";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;

export type CareerMarketClaim = Readonly<{
  claim: string;
  sourceUrl: string;
  region: string;
  observedAt: Date;
  reviewedAt: Date;
  expiresAt: Date;
}>;

export type CareerPrerequisiteInput = Readonly<{
  courseId: string;
  rationale: string;
}>;

export type CareerCardMutation = Readonly<{
  actorUserId: string;
  requestId: string;
  cardId: string | null;
  expectedVersion: number;
  action: "save" | "publish" | "retire";
  slug: string;
  path: string;
  technology: string;
  title: string;
  summary: string;
  futureScope: string;
  prerequisites: readonly CareerPrerequisiteInput[];
  market: CareerMarketClaim | null;
  reason: string;
  now?: Date;
}>;

export class CareerGuidanceError extends Error {
  constructor(public readonly code:
    | "ADMIN_REQUIRED"
    | "NOT_FOUND"
    | "INVALID_REQUEST"
    | "VERSION_CONFLICT"
    | "IDEMPOTENCY_MISMATCH"
    | "PREREQUISITE_NOT_VERIFIED"
    | "INVALID_STAGE_TRANSITION"
    | "SLUG_TAKEN") {
    super(code);
  }
}

function trimmed(value: string) {
  return value.trim();
}

export function normalizeCareerMarketClaim(market: CareerMarketClaim | null) {
  if (!market) return null;
  const source = new URL(market.sourceUrl);
  if (
    source.protocol !== "https:"
    || source.username
    || source.password
    || !source.hostname
    || !Number.isFinite(market.observedAt.getTime())
    || !Number.isFinite(market.reviewedAt.getTime())
    || !Number.isFinite(market.expiresAt.getTime())
    || market.observedAt > market.reviewedAt
    || market.reviewedAt >= market.expiresAt
  ) throw new CareerGuidanceError("INVALID_REQUEST");
  return {
    claim: trimmed(market.claim),
    sourceUrl: source.toString(),
    region: trimmed(market.region),
    observedAt: market.observedAt,
    reviewedAt: market.reviewedAt,
    expiresAt: market.expiresAt,
  } as const;
}

function normalizeMutation(input: CareerCardMutation, now: Date) {
  let market: ReturnType<typeof normalizeCareerMarketClaim>;
  try { market = normalizeCareerMarketClaim(input.market); }
  catch (error) {
    if (error instanceof CareerGuidanceError) throw error;
    throw new CareerGuidanceError("INVALID_REQUEST");
  }
  const prerequisites = input.prerequisites.map((item) => ({
    courseId: item.courseId,
    rationale: trimmed(item.rationale),
  }));
  const uniqueIds = new Set(prerequisites.map((item) => item.courseId));
  if (
    !trimmed(input.actorUserId)
    || !UUID_PATTERN.test(input.requestId)
    || (input.cardId !== null && !UUID_PATTERN.test(input.cardId))
    || !Number.isSafeInteger(input.expectedVersion)
    || input.expectedVersion < 0
    || !Number.isFinite(now.getTime())
    || !SLUG_PATTERN.test(trimmed(input.slug))
    || trimmed(input.path).length < 2 || trimmed(input.path).length > 120
    || trimmed(input.technology).length < 1 || trimmed(input.technology).length > 120
    || trimmed(input.title).length < 3 || trimmed(input.title).length > 160
    || trimmed(input.summary).length < 20 || trimmed(input.summary).length > 1_200
    || trimmed(input.futureScope).length < 20 || trimmed(input.futureScope).length > 2_000
    || trimmed(input.reason).length < 8 || trimmed(input.reason).length > 1_000
    || prerequisites.length > 50
    || uniqueIds.size !== prerequisites.length
    || prerequisites.some((item) => !UUID_PATTERN.test(item.courseId) || item.rationale.length < 8 || item.rationale.length > 500)
    || (market !== null && (market.claim.length < 10 || market.claim.length > 1_000 || market.region.length < 2 || market.region.length > 120))
    || (input.cardId === null && (input.expectedVersion !== 0 || input.action !== "save"))
  ) throw new CareerGuidanceError("INVALID_REQUEST");

  return {
    slug: trimmed(input.slug),
    path: trimmed(input.path),
    technology: trimmed(input.technology),
    title: trimmed(input.title),
    summary: trimmed(input.summary),
    futureScope: trimmed(input.futureScope),
    reason: trimmed(input.reason),
    prerequisites,
    market,
  };
}

async function assertAdmin(client: PoolClient, actorUserId: string) {
  const actor = await client.query<{ role: string | null; status: string }>(
    `select role,status from "user" where id = $1 for update`, [actorUserId],
  );
  if (actor.rows[0]?.role !== "admin" || actor.rows[0]?.status !== "active") {
    throw new CareerGuidanceError("ADMIN_REQUIRED");
  }
}

async function validatePrerequisites(
  client: PoolClient,
  prerequisiteIds: readonly string[],
  requireVerified: boolean,
) {
  if (!prerequisiteIds.length) return;
  const courses = await client.query<{ id: string; verified: boolean }>(
    `select course.id,
            coalesce(version.stage = 'verified' and version.approved_by is not null
              and version.published_at is not null, false) as verified
       from course
       left join curriculum_publication_pointer pointer on pointer.course_id = course.id
       left join course_version version on version.id = pointer.current_course_version_id
      where course.id = any($1::uuid[])`,
    [prerequisiteIds],
  );
  if (courses.rows.length !== prerequisiteIds.length) throw new CareerGuidanceError("INVALID_REQUEST");
  if (requireVerified && courses.rows.some((row) => !row.verified)) {
    throw new CareerGuidanceError("PREREQUISITE_NOT_VERIFIED");
  }
}

function mutationFingerprint(input: CareerCardMutation, normalized: ReturnType<typeof normalizeMutation>) {
  return hashSocialEvidence({
    requestId: input.requestId,
    cardId: input.cardId,
    expectedVersion: input.expectedVersion,
    action: input.action,
    slug: normalized.slug,
    path: normalized.path,
    technology: normalized.technology,
    title: normalized.title,
    summary: normalized.summary,
    futureScope: normalized.futureScope,
    prerequisites: normalized.prerequisites,
    market: normalized.market ? {
      ...normalized.market,
      observedAt: normalized.market.observedAt.toISOString(),
      reviewedAt: normalized.market.reviewedAt.toISOString(),
      expiresAt: normalized.market.expiresAt.toISOString(),
    } : null,
    reason: normalized.reason,
  });
}

export async function mutateCareerCard(input: CareerCardMutation) {
  const now = input.now ?? new Date();
  const normalized = normalizeMutation(input, now);
  if (input.action === "publish" && normalized.market && normalized.market.expiresAt <= now) {
    throw new CareerGuidanceError("INVALID_REQUEST");
  }
  const inputHash = mutationFingerprint(input, normalized);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `career-card:${input.cardId ?? normalized.slug}`,
    ]);
    await assertAdmin(client, input.actorUserId);
    const replay = await client.query<{
      career_card_id: string; input_hash: string; resulting_version: string | number; event: string;
    }>(
      `select career_card_id,input_hash,resulting_version,event from career_card_event
        where actor_user_id = $1 and request_id = $2`,
      [input.actorUserId, input.requestId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].input_hash !== inputHash) throw new CareerGuidanceError("IDEMPOTENCY_MISMATCH");
      await client.query("commit");
      return {
        cardId: replay.rows[0].career_card_id,
        rowVersion: Number(replay.rows[0].resulting_version),
        event: replay.rows[0].event,
        replayed: true,
      } as const;
    }
    await validatePrerequisites(
      client,
      normalized.prerequisites.map((item) => item.courseId),
      input.action === "publish",
    );

    let cardId = input.cardId;
    let resultingVersion: number;
    let event: "created" | "updated" | "published" | "retired";
    let prerequisitesInserted = false;
    if (!cardId) {
      const created = await client.query<{ id: string }>(
        `insert into career_card
          (slug,path,technology,title,summary,future_scope,status,authored_by,
           market_claim,market_source_url,market_region,market_observed_at,
           market_reviewed_at,market_expires_at,market_reviewed_by,row_version,
           created_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$15)
         returning id`,
        [normalized.slug, normalized.path, normalized.technology, normalized.title,
          normalized.summary, normalized.futureScope, input.actorUserId,
          normalized.market?.claim ?? null, normalized.market?.sourceUrl ?? null,
          normalized.market?.region ?? null, normalized.market?.observedAt ?? null,
          normalized.market?.reviewedAt ?? null, normalized.market?.expiresAt ?? null,
          normalized.market ? input.actorUserId : null, now],
      );
      cardId = created.rows[0]!.id;
      resultingVersion = 1;
      event = "created";
    } else {
      const current = await client.query<{ row_version: string | number; status: string }>(
        `select row_version,status from career_card where id = $1 for update`, [cardId],
      );
      if (!current.rows[0]) throw new CareerGuidanceError("NOT_FOUND");
      if (Number(current.rows[0].row_version) !== input.expectedVersion) throw new CareerGuidanceError("VERSION_CONFLICT");
      if (current.rows[0].status === "retired") throw new CareerGuidanceError("INVALID_STAGE_TRANSITION");
      // A published card may only leave the public surface through the
      // explicit, fresh-MFA-protected retire action. Saving it as a draft
      // would otherwise be an implicit withdrawal that bypasses that gate.
      if (input.action === "save" && current.rows[0].status === "published") {
        throw new CareerGuidanceError("INVALID_STAGE_TRANSITION");
      }
      if (input.action === "retire" && current.rows[0].status !== "published") {
        throw new CareerGuidanceError("INVALID_STAGE_TRANSITION");
      }
      resultingVersion = input.expectedVersion + 1;
      event = input.action === "publish" ? "published" : input.action === "retire" ? "retired" : "updated";
      const status = input.action === "publish" ? "published" : input.action === "retire" ? "retired" : "draft";
      await client.query(`delete from career_card_prerequisite where career_card_id = $1`, [cardId]);
      for (const [index, prerequisite] of normalized.prerequisites.entries()) {
        await client.query(
          `insert into career_card_prerequisite (career_card_id,course_id,position,rationale,created_at)
           values ($1,$2,$3,$4,$5)`,
          [cardId, prerequisite.courseId, index + 1, prerequisite.rationale, now],
        );
      }
      prerequisitesInserted = true;
      await client.query(
        `update career_card set slug=$2,path=$3,technology=$4,title=$5,summary=$6,future_scope=$7,
           status=$8, published_by=case when $8='published' then $9 else case when $8='draft' then null else published_by end end,
           published_at=case when $8='published' then $10 else case when $8='draft' then null else published_at end end,
           retired_at=case when $8='retired' then $10 else null end,
           market_claim=$11,market_source_url=$12,market_region=$13,market_observed_at=$14,
           market_reviewed_at=$15,market_expires_at=$16,market_reviewed_by=$17,
           row_version=$18,updated_at=$10 where id=$1`,
        [cardId, normalized.slug, normalized.path, normalized.technology, normalized.title,
          normalized.summary, normalized.futureScope, status, input.actorUserId, now,
          normalized.market?.claim ?? null, normalized.market?.sourceUrl ?? null,
          normalized.market?.region ?? null, normalized.market?.observedAt ?? null,
          normalized.market?.reviewedAt ?? null, normalized.market?.expiresAt ?? null,
          normalized.market ? input.actorUserId : null, resultingVersion],
      );
    }

    if (!prerequisitesInserted) {
      for (const [index, prerequisite] of normalized.prerequisites.entries()) {
        await client.query(
          `insert into career_card_prerequisite (career_card_id,course_id,position,rationale,created_at)
           values ($1,$2,$3,$4,$5)`,
          [cardId, prerequisite.courseId, index + 1, prerequisite.rationale, now],
        );
      }
    }
    const snapshot = {
      requestHash: inputHash,
      cardId,
      status: input.action === "publish" ? "published" : input.action === "retire" ? "retired" : "draft",
      slug: normalized.slug,
      path: normalized.path,
      technology: normalized.technology,
      title: normalized.title,
      summary: normalized.summary,
      futureScope: normalized.futureScope,
      prerequisites: normalized.prerequisites,
      market: normalized.market ? {
        claim: normalized.market.claim,
        sourceUrl: normalized.market.sourceUrl,
        region: normalized.market.region,
        observedAt: normalized.market.observedAt.toISOString(),
        reviewedAt: normalized.market.reviewedAt.toISOString(),
        expiresAt: normalized.market.expiresAt.toISOString(),
      } : null,
    };
    await client.query(
      `insert into career_card_event
        (career_card_id,actor_user_id,request_id,event,input_hash,snapshot,evidence_hash,
         reason,resulting_version,occurred_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
      [cardId, input.actorUserId, input.requestId, event, inputHash,
        JSON.stringify(snapshot), hashSocialEvidence(snapshot), normalized.reason,
        resultingVersion, now],
    );
    await client.query("commit");
    return { cardId, rowVersion: resultingVersion, event, replayed: false } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    const pg = error as { code?: string; constraint?: string };
    if (pg.code === "23505" && pg.constraint === "career_card_slug_unique") {
      throw new CareerGuidanceError("SLUG_TAKEN");
    }
    throw error;
  } finally {
    client.release();
  }
}

type CareerCardRow = {
  id: string; slug: string; path: string; technology: string; title: string;
  summary: string; future_scope: string; status: string; authored_by: string;
  author_name: string; published_by: string | null; publisher_name: string | null;
  market_claim: string | null; market_source_url: string | null; market_region: string | null;
  market_observed_at: Date | null; market_reviewed_at: Date | null; market_expires_at: Date | null;
  row_version: string | number; published_at: Date | null; retired_at: Date | null; updated_at: Date;
};

async function loadPrerequisites(cardIds: readonly string[]) {
  if (!cardIds.length) return new Map<string, Array<Record<string, unknown>>>();
  const result = await pool.query<{
    career_card_id: string; course_id: string; slug: string; title: string; position: number; rationale: string;
  }>(
    `select prerequisite.career_card_id,prerequisite.course_id,course.slug,course.title,
            prerequisite.position,prerequisite.rationale
       from career_card_prerequisite prerequisite
       join course on course.id = prerequisite.course_id
      where prerequisite.career_card_id = any($1::uuid[])
      order by prerequisite.career_card_id,prerequisite.position`,
    [cardIds],
  );
  const byCard = new Map<string, Array<Record<string, unknown>>>();
  for (const row of result.rows) {
    const values = byCard.get(row.career_card_id) ?? [];
    values.push({ courseId: row.course_id, courseSlug: row.slug, courseTitle: row.title, rationale: row.rationale });
    byCard.set(row.career_card_id, values);
  }
  return byCard;
}

export async function listCareerAdminCards() {
  const result = await pool.query<CareerCardRow>(
    `select card.*,author.name author_name,publisher.name publisher_name
       from career_card card
       join "user" author on author.id = card.authored_by
       left join "user" publisher on publisher.id = card.published_by
      order by case card.status when 'draft' then 0 when 'published' then 1 else 2 end,
               lower(card.technology),lower(card.title),card.id`,
  );
  const prerequisites = await loadPrerequisites(result.rows.map((row) => row.id));
  return result.rows.map((row) => ({
    id: row.id, slug: row.slug, path: row.path, technology: row.technology, title: row.title,
    summary: row.summary, futureScope: row.future_scope, status: row.status,
    author: { id: row.authored_by, name: row.author_name },
    publisher: row.published_by ? { id: row.published_by, name: row.publisher_name! } : null,
    market: row.market_claim ? {
      claim: row.market_claim, sourceUrl: row.market_source_url!, region: row.market_region!,
      observedAt: row.market_observed_at!.toISOString(), reviewedAt: row.market_reviewed_at!.toISOString(),
      expiresAt: row.market_expires_at!.toISOString(),
    } : null,
    prerequisites: prerequisites.get(row.id) ?? [], rowVersion: Number(row.row_version),
    publishedAt: row.published_at?.toISOString() ?? null, retiredAt: row.retired_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function listCareerPrerequisiteCourses() {
  const result = await pool.query<{
    id: string; slug: string; title: string; version: string | null; stage: string | null;
  }>(
    `select course.id,course.slug,course.title,version.version,version.stage
       from course
       left join curriculum_publication_pointer pointer on pointer.course_id=course.id
       left join course_version version on version.id=pointer.current_course_version_id
      order by lower(course.title),course.id`,
  );
  return result.rows.map((row) => ({
    id: row.id, slug: row.slug, title: row.title,
    currentVersion: row.version, currentStage: row.stage,
    eligibleForPublishedPrerequisite: row.stage === "verified",
  }));
}

type PrerequisiteEvidence = {
  courseId: string; courseSlug: string; courseTitle: string; rationale: string;
  version: string | null; verified: boolean; enrollmentId: string | null;
  enrollmentStatus: string | null; completedAt: string | null;
  masteredConcepts: number; totalConcepts: number; satisfied: boolean;
};

async function learnerPrerequisiteEvidence(userId: string, prerequisite: Record<string, unknown>): Promise<PrerequisiteEvidence> {
  const courseId = String(prerequisite.courseId);
  const result = await pool.query<{
    course_slug: string; course_title: string; version: string | null; verified: boolean;
    enrollment_id: string | null; enrollment_status: string | null; completed_at: Date | null;
    total_concepts: string | number; mastered_concepts: string | number;
  }>(
    `with current_course as (
       select course.id,course.slug course_slug,course.title course_title,version.id version_id,version.version,
              coalesce(version.stage='verified' and version.approved_by is not null and version.published_at is not null
                and exists (select 1 from curriculum_release_evidence release where release.course_version_id=version.id)
                and exists (select 1 from curriculum_artifact artifact where artifact.course_version_id=version.id)
                and not exists (select 1 from curriculum_artifact artifact where artifact.course_version_id=version.id and artifact.review_status<>'approved'),false) verified
         from course
         left join curriculum_publication_pointer pointer on pointer.course_id=course.id
         left join course_version version on version.id=pointer.current_course_version_id
        where course.id=$2
     ), selected_enrollment as (
       select enrollment.* from enrollment,current_course
        where enrollment.user_id=$1 and enrollment.course_version_id=current_course.version_id
        order by case enrollment.status when 'completed' then 0 else 1 end,
                 enrollment.completed_at desc nulls last,enrollment.created_at desc,enrollment.id
        limit 1
     ), covered as (
       select distinct link.concept_id
         from current_course
         join course_module module on module.course_version_id=current_course.version_id
         join lesson on lesson.module_id=module.id
         join lesson_concept link on link.lesson_id=lesson.id
     )
     select current_course.course_slug,current_course.course_title,current_course.version,current_course.verified,
            selected_enrollment.id enrollment_id,selected_enrollment.status enrollment_status,
            selected_enrollment.completed_at,count(covered.concept_id)::int total_concepts,
            count(covered.concept_id) filter (where exists (
              select 1 from concept_mastery mastery
               where mastery.user_id=$1 and mastery.enrollment_id=selected_enrollment.id
                 and mastery.concept_id=covered.concept_id and mastery.status='mastered'
                 and exists (select 1 from mastery_evidence evidence
                   where evidence.user_id=$1 and evidence.enrollment_id=selected_enrollment.id
                     and evidence.concept_id=covered.concept_id and evidence.validity='valid')
            ))::int mastered_concepts
       from current_course left join selected_enrollment on true left join covered on true
      group by current_course.course_slug,current_course.course_title,current_course.version,current_course.verified,
               selected_enrollment.id,selected_enrollment.status,selected_enrollment.completed_at`,
    [userId, courseId],
  );
  const row = result.rows[0];
  const total = Number(row?.total_concepts ?? 0);
  const mastered = Number(row?.mastered_concepts ?? 0);
  const verified = row?.verified === true;
  return {
    courseId,
    courseSlug: row?.course_slug ?? String(prerequisite.courseSlug),
    courseTitle: row?.course_title ?? String(prerequisite.courseTitle),
    rationale: String(prerequisite.rationale),
    version: row?.version ?? null,
    verified,
    enrollmentId: row?.enrollment_id ?? null,
    enrollmentStatus: row?.enrollment_status ?? null,
    completedAt: row?.completed_at?.toISOString() ?? null,
    masteredConcepts: mastered,
    totalConcepts: total,
    satisfied: verified && row?.enrollment_status === "completed" && Boolean(row.completed_at) && total > 0 && mastered === total,
  };
}

export async function listLearnerCareerRecommendations(userId: string, now = new Date()) {
  if (!userId.trim() || !Number.isFinite(now.getTime())) throw new CareerGuidanceError("NOT_FOUND");
  const actor = await pool.query(`select 1 from "user" where id=$1 and status='active'`, [userId]);
  if (!actor.rows[0]) throw new CareerGuidanceError("NOT_FOUND");
  const cards = (await listCareerAdminCards()).filter((card) => card.status === "published");
  const recommendations = await Promise.all(cards.map(async (card) => {
    const evidence = await Promise.all(card.prerequisites.map((prerequisite) => learnerPrerequisiteEvidence(userId, prerequisite)));
    const satisfied = evidence.filter((item) => item.satisfied).length;
    const readiness = evidence.length === 0 ? "explore" : satisfied === evidence.length ? "ready" : satisfied > 0 ? "building" : "locked";
    const freshMarket = card.market && new Date(card.market.expiresAt) > now ? card.market : null;
    return {
      id: card.id, slug: card.slug, path: card.path, technology: card.technology, title: card.title,
      summary: card.summary, futureScope: card.futureScope, readiness,
      readinessReason: evidence.length === 0
        ? "This path has no required course prerequisite."
        : `${satisfied} of ${evidence.length} verified prerequisites are complete with mastery evidence.`,
      prerequisiteEvidence: evidence,
      market: freshMarket,
      marketNotice: card.market && !freshMarket ? "Market note hidden until an administrator reviews a fresh source." : null,
      publishedAt: card.publishedAt,
    };
  }));
  const rank: Record<string, number> = { ready: 0, building: 1, explore: 2, locked: 3 };
  recommendations.sort((left, right) => rank[left.readiness]! - rank[right.readiness]!
    || left.technology.localeCompare(right.technology) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return {
    available: recommendations.length > 0,
    recommendations,
    basis: "Deterministic guidance from the current verified curriculum pointer, completed enrollments, mastered concepts, and valid mastery evidence. AI is not used for ranking.",
    emptyMessage: recommendations.length ? null : "No administrator-reviewed career paths are published yet.",
  };
}
