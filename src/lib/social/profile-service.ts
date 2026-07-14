import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";

import { hashSocialEvidence } from "./hash";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,29}$/;

export class SocialProfileError extends Error {
  constructor(public readonly code:
    | "NOT_FOUND"
    | "INVALID_REQUEST"
    | "CONSENT_REQUIRED"
    | "VERSION_CONFLICT"
    | "IDEMPOTENCY_MISMATCH"
    | "ALIAS_TAKEN"
    | "INVALID_SELECTION") {
    super(code);
  }
}

export interface CohortProfileUpdate {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly alias: string;
  readonly bio: string | null;
  readonly showBio: boolean;
  readonly showStreak: boolean;
  readonly showMasterySummary: boolean;
  readonly publish: boolean;
  readonly selectedAchievementIds: readonly string[];
  readonly selectedProjectIds: readonly string[];
  readonly now?: Date;
}

type ProfileRow = {
  user_id: string;
  alias: string;
  bio: string | null;
  is_published: boolean;
  published_consent_record_id: string | null;
  show_bio: boolean;
  show_streak: boolean;
  show_mastery_summary: boolean;
  selected_achievement_ids: string[];
  selected_project_ids: string[];
  row_version: string | number;
  published_at: Date | null;
  withdrawn_at: Date | null;
};

function sortedIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function derivedUuid(namespace: string, requestId: string) {
  const bytes = Buffer.from(createHash("sha256").update(`${namespace}\0${requestId}`).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function currentConsent(client: PoolClient, userId: string, purpose: "cohort_profile" | "leaderboard") {
  const result = await client.query<{
    id: string; decision: string; policy_version: string;
  }>(
    `select id, decision, policy_version from consent_record
      where user_id = $1 and purpose = $2
      order by occurred_at desc, created_at desc, id desc limit 1`,
    [userId, purpose],
  );
  return result.rows[0] ?? null;
}

export async function isCurrentSocialConsentAccepted(
  client: PoolClient,
  userId: string,
  purpose: "cohort_profile" | "leaderboard",
) {
  const consent = await currentConsent(client, userId, purpose);
  return consent?.decision === "accepted" && consent.policy_version === ENROLLMENT_DISCLOSURE_VERSION
    ? consent
    : null;
}

function requestFingerprint(input: Omit<CohortProfileUpdate, "now" | "actorUserId" | "expectedVersion">) {
  return hashSocialEvidence({
    requestId: input.requestId,
    alias: input.alias.trim(),
    bio: input.bio?.trim() || null,
    showBio: input.showBio,
    showStreak: input.showStreak,
    showMasterySummary: input.showMasterySummary,
    publish: input.publish,
    selectedAchievementIds: sortedIds(input.selectedAchievementIds),
    selectedProjectIds: sortedIds(input.selectedProjectIds),
  });
}

function validateUpdate(input: CohortProfileUpdate, now: Date) {
  if (
    !UUID_PATTERN.test(input.requestId)
    || !Number.isSafeInteger(input.expectedVersion)
    || input.expectedVersion < 0
    || !ALIAS_PATTERN.test(input.alias.trim())
    || (input.bio?.trim().length ?? 0) > 280
    || input.selectedAchievementIds.length > 100
    || input.selectedProjectIds.length > 100
    || !Number.isFinite(now.getTime())
  ) throw new SocialProfileError("INVALID_REQUEST");
  if ([...input.selectedAchievementIds, ...input.selectedProjectIds].some((id) => !UUID_PATTERN.test(id))) {
    throw new SocialProfileError("INVALID_SELECTION");
  }
}

export async function updateCohortProfile(input: CohortProfileUpdate) {
  const now = input.now ?? new Date();
  validateUpdate(input, now);
  const alias = input.alias.trim();
  const bio = input.bio?.trim() || null;
  const requestedAchievements = sortedIds(input.selectedAchievementIds);
  const requestedProjects = sortedIds(input.selectedProjectIds);
  const fingerprint = requestFingerprint({ ...input, alias, bio });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`cohort-profile:${input.actorUserId}`]);
    const actor = await client.query<{ status: string; role: string | null }>(
      `select status, role from "user" where id = $1 for update`, [input.actorUserId],
    );
    if (actor.rows[0]?.status !== "active" || actor.rows[0]?.role !== "learner") {
      throw new SocialProfileError("NOT_FOUND");
    }
    const prior = await client.query<{ snapshot: Record<string, unknown>; resulting_version: string | number }>(
      `select snapshot, resulting_version from cohort_profile_event where user_id = $1 and request_id = $2`,
      [input.actorUserId, input.requestId],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].snapshot.requestHash !== fingerprint) throw new SocialProfileError("IDEMPOTENCY_MISMATCH");
      await client.query("commit");
      return { rowVersion: Number(prior.rows[0].resulting_version), replayed: true } as const;
    }
    const existing = (await client.query<ProfileRow>(
      `select user_id, alias, bio, is_published, published_consent_record_id,
              show_bio, show_streak, show_mastery_summary, selected_achievement_ids,
              selected_project_ids, row_version, published_at, withdrawn_at
         from cohort_profile where user_id = $1 for update`,
      [input.actorUserId],
    )).rows[0] ?? null;
    if (Number(existing?.row_version ?? 0) !== input.expectedVersion) throw new SocialProfileError("VERSION_CONFLICT");

    const consent = input.publish
      ? await isCurrentSocialConsentAccepted(client, input.actorUserId, "cohort_profile")
      : null;
    if (input.publish && !consent) throw new SocialProfileError("CONSENT_REQUIRED");
    const achievements = requestedAchievements.length
      ? await client.query<{ id: string }>(
          `select id from user_achievement where user_id = $1 and revoked_at is null and id = any($2::uuid[])`,
          [input.actorUserId, requestedAchievements],
        )
      : { rows: [] as Array<{ id: string }> };
    const projects = requestedProjects.length
      ? await client.query<{ id: string }>(
          `select id from project where user_id = $1 and id = any($2::uuid[])`,
          [input.actorUserId, requestedProjects],
        )
      : { rows: [] as Array<{ id: string }> };
    if (achievements.rows.length !== requestedAchievements.length || projects.rows.length !== requestedProjects.length) {
      throw new SocialProfileError("INVALID_SELECTION");
    }
    const visibleAchievementIds = input.publish ? requestedAchievements : [];
    const visibleProjectIds = input.publish ? requestedProjects : [];
    const resultingVersion = input.expectedVersion + 1;
    const event = !existing
      ? (input.publish ? "published" : "created")
      : existing.is_published && !input.publish
        ? "withdrawn"
        : !existing.is_published && input.publish
          ? "published"
          : "updated";
    const snapshot = {
      requestHash: fingerprint,
      alias,
      bio,
      isPublished: input.publish,
      publishedConsentRecordId: consent?.id ?? null,
      showBio: input.showBio,
      showStreak: input.showStreak,
      showMasterySummary: input.showMasterySummary,
      selectedAchievementIds: requestedAchievements,
      selectedProjectIds: requestedProjects,
    };
    await client.query(
      `insert into cohort_profile
        (user_id, alias, bio, is_published, published_consent_record_id, show_bio, show_streak,
         show_mastery_summary, selected_achievement_ids, selected_project_ids, row_version,
         published_at, withdrawn_at, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$14)
       on conflict (user_id) do update set alias = excluded.alias, bio = excluded.bio,
         is_published = excluded.is_published,
         published_consent_record_id = excluded.published_consent_record_id,
         show_bio = excluded.show_bio, show_streak = excluded.show_streak,
         show_mastery_summary = excluded.show_mastery_summary,
         selected_achievement_ids = excluded.selected_achievement_ids,
         selected_project_ids = excluded.selected_project_ids,
         row_version = excluded.row_version,
         published_at = case when excluded.is_published then coalesce(cohort_profile.published_at, excluded.updated_at) else cohort_profile.published_at end,
         withdrawn_at = case when excluded.is_published then null else excluded.updated_at end,
         updated_at = excluded.updated_at`,
      [input.actorUserId, alias, bio, input.publish, consent?.id ?? null, input.showBio, input.showStreak,
        input.showMasterySummary, JSON.stringify(requestedAchievements), JSON.stringify(requestedProjects),
        resultingVersion, input.publish ? now : null, input.publish ? null : now, now],
    );
    await client.query(
      `update user_achievement set visibility = case when id = any($2::uuid[]) then 'cohort'::visibility else 'private'::visibility end
        where user_id = $1`,
      [input.actorUserId, visibleAchievementIds],
    );
    await client.query(
      `update project set visibility = case when id = any($2::uuid[]) then 'cohort'::visibility else 'private'::visibility end
        where user_id = $1`,
      [input.actorUserId, visibleProjectIds],
    );
    const reason = event === "published"
      ? "Learner explicitly published the cohort projection."
      : event === "withdrawn"
        ? "Learner explicitly withdrew the cohort projection."
        : "Learner edited cohort projection fields and selections.";
    await client.query(
      `insert into cohort_profile_event
        (user_id,actor_user_id,request_id,event,snapshot,evidence_hash,reason,resulting_version,occurred_at)
       values ($1,$1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      [input.actorUserId, input.requestId, event, JSON.stringify(snapshot), hashSocialEvidence(snapshot), reason, resultingVersion, now],
    );
    if (event === "published" || event === "withdrawn" || (event === "updated" && input.publish)) {
      await client.query(
        `insert into notification (user_id,type,title,body,action_url,created_at)
         values ($1,'cohort_visibility_changed',$2,$3,'/community',$4)`,
        [input.actorUserId,
          event === "published" ? "Cohort profile published" : event === "withdrawn" ? "Cohort profile withdrawn" : "Cohort profile updated",
          event === "published"
            ? "Your selected alias and fields can now appear to the closed cohort."
            : event === "withdrawn"
              ? "Your profile, badges, projects, and leaderboard entry are hidden from the cohort."
              : "Your updated alias and selected fields can now appear to the closed cohort.",
          now],
      );
    }
    await client.query("commit");
    return { rowVersion: resultingVersion, replayed: false, event } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if ((error as { code?: string; constraint?: string }).code === "23505"
      && (error as { constraint?: string }).constraint === "cohort_profile_alias_unique") {
      throw new SocialProfileError("ALIAS_TAKEN");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function withdrawCohortProfileForConsent(input: {
  readonly userId: string;
  readonly consentRequestId: string;
  readonly now?: Date;
}) {
  if (!UUID_PATTERN.test(input.consentRequestId)) throw new SocialProfileError("INVALID_REQUEST");
  const now = input.now ?? new Date();
  const requestId = derivedUuid("cohort-consent-withdrawal", input.consentRequestId);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`cohort-profile:${input.userId}`]);
    const existing = (await client.query<ProfileRow>(`select * from cohort_profile where user_id = $1 for update`, [input.userId])).rows[0] ?? null;
    const prior = await client.query(`select id from cohort_profile_event where user_id = $1 and request_id = $2`, [input.userId, requestId]);
    await client.query(`update user_achievement set visibility = 'private' where user_id = $1`, [input.userId]);
    await client.query(`update project set visibility = 'private' where user_id = $1`, [input.userId]);
    if (existing && !prior.rows[0]) {
      const resultingVersion = Number(existing.row_version) + 1;
      const snapshot = {
        requestHash: hashSocialEvidence({ consentRequestId: input.consentRequestId, action: "withdraw" }),
        alias: existing.alias,
        bio: existing.bio,
        isPublished: false,
        publishedConsentRecordId: null,
        showBio: existing.show_bio,
        showStreak: existing.show_streak,
        showMasterySummary: existing.show_mastery_summary,
        selectedAchievementIds: existing.selected_achievement_ids,
        selectedProjectIds: existing.selected_project_ids,
      };
      await client.query(
        `update cohort_profile set is_published = false, published_consent_record_id = null,
           row_version = $2, withdrawn_at = $3, updated_at = $3 where user_id = $1`,
        [input.userId, resultingVersion, now],
      );
      await client.query(
        `insert into cohort_profile_event
          (user_id,actor_user_id,request_id,event,snapshot,evidence_hash,reason,resulting_version,occurred_at)
         values ($1,$1,$2,'withdrawn',$3::jsonb,$4,'Cohort consent withdrawal hid every social projection.',$5,$6)`,
        [input.userId, requestId, JSON.stringify(snapshot), hashSocialEvidence(snapshot), resultingVersion, now],
      );
      await client.query(
        `insert into notification (user_id,type,title,body,action_url,created_at)
         values ($1,'cohort_visibility_changed','Cohort sharing withdrawn',
                 'Your profile, badges, projects, and leaderboard entry are hidden from the cohort.', '/community', $2)`,
        [input.userId, now],
      );
    }
    await client.query("commit");
    return { withdrawn: Boolean(existing), replayed: Boolean(prior.rows[0]) };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function suggestedAlias(publicId: string) {
  return `learner-${publicId.replaceAll("-", "").slice(0, 8)}`;
}

export async function loadOwnCohortSettings(userId: string, now = new Date()) {
  const client = await pool.connect();
  try {
    const actor = await client.query<{ public_id: string }>(`select public_id from "user" where id = $1 and status = 'active'`, [userId]);
    if (!actor.rows[0]) throw new SocialProfileError("NOT_FOUND");
    const profile = (await client.query<ProfileRow>(`select * from cohort_profile where user_id = $1`, [userId])).rows[0] ?? null;
    const cohortConsent = await currentConsent(client, userId, "cohort_profile");
    const leaderboardConsent = await currentConsent(client, userId, "leaderboard");
    const badges = await client.query<{ id: string; title: string; description: string; icon: string; visibility: string }>(
        `select ua.id, a.title, a.description, a.icon, ua.visibility
           from user_achievement ua join achievement a on a.id = ua.achievement_id
          where ua.user_id = $1 and ua.revoked_at is null order by ua.awarded_at desc, ua.id`, [userId],
      );
    const projects = await client.query<{ id: string; title: string; summary: string; status: string; visibility: string }>(
        `select id,title,summary,status,visibility from project where user_id = $1 order by updated_at desc,id`, [userId],
      );
    const mastery = await client.query<{ mastered: string }>(
      `select count(*)::text mastered from concept_mastery where user_id = $1 and status in ('proficient','mastered')`, [userId],
    );
    const days = await client.query<{ day_key: string }>(
      `select distinct to_char(occurred_at at time zone 'UTC','YYYY-MM-DD') day_key
         from learning_session_event where user_id = $1 and metadata->>'meaningful' = 'true'
        order by day_key desc limit 400`, [userId],
    );
    const consentAccepted = cohortConsent?.decision === "accepted" && cohortConsent.policy_version === ENROLLMENT_DISCLOSURE_VERSION;
    const leaderboardAccepted = leaderboardConsent?.decision === "accepted" && leaderboardConsent.policy_version === ENROLLMENT_DISCLOSURE_VERSION;
    const live = Boolean(profile?.is_published && consentAccepted && profile.published_consent_record_id === cohortConsent?.id);
    return {
      policyVersion: ENROLLMENT_DISCLOSURE_VERSION,
      consent: { cohortProfile: consentAccepted, leaderboard: leaderboardAccepted },
      live,
      profile: {
        alias: profile?.alias ?? suggestedAlias(actor.rows[0].public_id),
        bio: profile?.bio ?? "",
        isPublished: profile?.is_published ?? false,
        showBio: profile?.show_bio ?? false,
        showStreak: profile?.show_streak ?? false,
        showMasterySummary: profile?.show_mastery_summary ?? false,
        rowVersion: Number(profile?.row_version ?? 0),
      },
      badges: badges.rows.map((row) => ({ ...row, selected: profile?.selected_achievement_ids.includes(row.id) ?? false })),
      projects: projects.rows.map((row) => ({ ...row, selected: profile?.selected_project_ids.includes(row.id) ?? false })),
      availableAggregates: {
        streak: currentStreak(days.rows.map((row) => row.day_key), now),
        masteredConcepts: Number(mastery.rows[0]?.mastered ?? 0),
      },
      livePreview: live ? await loadVisibleCohortProfileByUserId(userId, now, client) : null,
      exclusionNotice: "Email, names, exact activity, scores, raw hours, attempts, failures, hints, code, chat, provider use, and session data are never cohort profile fields.",
    };
  } finally {
    client.release();
  }
}

function currentStreak(dayKeys: readonly string[], now: Date) {
  const set = new Set(dayKeys);
  let cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (!set.has(cursor.toISOString().slice(0, 10))) cursor = new Date(cursor.getTime() - 86_400_000);
  let streak = 0;
  while (set.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return streak;
}

async function loadVisibleCohortProfileByUserId(userId: string, now: Date, passedClient?: PoolClient) {
  const ownClient = passedClient ? null : await pool.connect();
  const client = passedClient ?? ownClient!;
  try {
    const visible = await client.query<ProfileRow & { public_id: string }>(
      `select cp.*, u.public_id
         from cohort_profile cp join "user" u on u.id = cp.user_id
         join lateral (
           select id,decision,policy_version from consent_record
            where user_id = cp.user_id and purpose = 'cohort_profile'
            order by occurred_at desc, created_at desc, id desc limit 1
         ) consent on consent.id = cp.published_consent_record_id
        where cp.user_id = $1 and cp.is_published
          and u.status = 'active'
          and consent.decision = 'accepted' and consent.policy_version = $2`,
      [userId, ENROLLMENT_DISCLOSURE_VERSION],
    );
    const profile = visible.rows[0];
    if (!profile) return null;
    const badges = await client.query<{ id: string; title: string; description: string; icon: string }>(
        `select ua.id,a.title,a.description,a.icon from user_achievement ua
          join achievement a on a.id = ua.achievement_id
         where ua.user_id = $1 and ua.visibility = 'cohort' and ua.revoked_at is null
         order by ua.awarded_at desc, ua.id`, [userId],
      );
    const projects = await client.query<{ id: string; title: string; summary: string; status: string }>(
        `select id,title,summary,status from project where user_id = $1 and visibility = 'cohort'
         order by updated_at desc,id`, [userId],
      );
    const mastery = profile.show_mastery_summary
        ? await client.query<{ mastered: string }>(
            `select count(*)::text mastered from concept_mastery where user_id = $1 and status in ('proficient','mastered')`, [userId],
          )
        : { rows: [] as Array<{ mastered: string }> };
    const days = profile.show_streak
        ? await client.query<{ day_key: string }>(
            `select distinct to_char(occurred_at at time zone 'UTC','YYYY-MM-DD') day_key
               from learning_session_event where user_id = $1 and metadata->>'meaningful' = 'true'
              order by day_key desc limit 400`, [userId],
          )
        : { rows: [] as Array<{ day_key: string }> };
    return {
      publicId: profile.public_id,
      alias: profile.alias,
      ...(profile.show_bio && profile.bio ? { bio: profile.bio } : {}),
      ...(profile.show_streak ? { streak: currentStreak(days.rows.map((row) => row.day_key), now) } : {}),
      ...(profile.show_mastery_summary ? { masteredConcepts: Number(mastery.rows[0]?.mastered ?? 0) } : {}),
      badges: badges.rows,
      projects: projects.rows,
    };
  } finally {
    ownClient?.release();
  }
}

export async function loadVisibleCohortProfile(publicId: string, now = new Date()) {
  if (!UUID_PATTERN.test(publicId)) throw new SocialProfileError("NOT_FOUND");
  const target = await pool.query<{ id: string }>(`select id from "user" where public_id = $1 and status = 'active'`, [publicId]);
  if (!target.rows[0]) throw new SocialProfileError("NOT_FOUND");
  const profile = await loadVisibleCohortProfileByUserId(target.rows[0].id, now);
  if (!profile) throw new SocialProfileError("NOT_FOUND");
  return profile;
}

export async function listVisibleProfileOwners() {
  const result = await pool.query<{ user_id: string; public_id: string; alias: string }>(
    `select cp.user_id,u.public_id,cp.alias
       from cohort_profile cp join "user" u on u.id = cp.user_id
       join lateral (
         select id,decision,policy_version from consent_record
          where user_id = cp.user_id and purpose = 'cohort_profile'
          order by occurred_at desc, created_at desc, id desc limit 1
       ) consent on consent.id = cp.published_consent_record_id
      where cp.is_published and u.status = 'active'
        and consent.decision = 'accepted' and consent.policy_version = $1
      order by lower(cp.alias),u.public_id`,
    [ENROLLMENT_DISCLOSURE_VERSION],
  );
  return result.rows.map((row) => ({ userId: row.user_id, publicId: row.public_id, alias: row.alias }));
}

export async function hasLeaderboardConsent(userId: string) {
  const client = await pool.connect();
  try { return Boolean(await isCurrentSocialConsentAccepted(client, userId, "leaderboard")); }
  finally { client.release(); }
}
