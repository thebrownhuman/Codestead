import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { redactSensitiveText } from "@/lib/security/sensitive-text";
import { hashSocialEvidence } from "@/lib/social/hash";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/;
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export class PublicPortfolioError extends Error {
  constructor(public readonly code:
    | "NOT_FOUND"
    | "INVALID_REQUEST"
    | "INVALID_SELECTION"
    | "DISCLOSURE_CONFIRMATION_REQUIRED"
    | "VERSION_CONFLICT"
    | "IDEMPOTENCY_MISMATCH"
    | "SLUG_TAKEN") {
    super(code);
  }
}

export function normalizePublicGithubRepositoryUrl(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new PublicPortfolioError("INVALID_SELECTION"); }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash
    || segments.length !== 2
    || !segments.every((segment) => GITHUB_SEGMENT.test(segment))
  ) throw new PublicPortfolioError("INVALID_SELECTION");
  const repository = segments[1]!.replace(/\.git$/i, "");
  if (!repository || !GITHUB_SEGMENT.test(repository)) throw new PublicPortfolioError("INVALID_SELECTION");
  return `https://github.com/${segments[0]}/${repository}`;
}

export type PublicPortfolioMutation = Readonly<{
  userId: string;
  requestId: string;
  expectedVersion: number;
  slug: string;
  displayName: string;
  headline: string;
  about: string | null;
  publish: boolean;
  confirmPublicDisclosure: boolean;
  selectedProjectIds: readonly string[];
  selectedAchievementIds: readonly string[];
  selectedCertificateIds: readonly string[];
  now?: Date;
}>;

function uniqueSortedIds(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function containsSensitivePublicText(value: string | null) {
  if (!value) return false;
  return redactSensitiveText(value, Math.max(1, value.length)).redacted;
}

function normalizeMutation(input: PublicPortfolioMutation, now: Date) {
  const slug = input.slug.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const headline = input.headline.trim();
  const about = input.about?.trim() || null;
  const selectedProjectIds = uniqueSortedIds(input.selectedProjectIds);
  const selectedAchievementIds = uniqueSortedIds(input.selectedAchievementIds);
  const selectedCertificateIds = uniqueSortedIds(input.selectedCertificateIds);
  if (
    !input.userId.trim() || !UUID_PATTERN.test(input.requestId)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || !Number.isFinite(now.getTime()) || !SLUG_PATTERN.test(slug)
    || displayName.length < 1 || displayName.length > 120
    || headline.length < 10 || headline.length > 180
    || (about !== null && about.length > 1_200)
    || selectedProjectIds.length > 50 || selectedAchievementIds.length > 50 || selectedCertificateIds.length > 50
    || [...selectedProjectIds, ...selectedAchievementIds, ...selectedCertificateIds].some((id) => !UUID_PATTERN.test(id))
  ) throw new PublicPortfolioError("INVALID_REQUEST");
  if (
    containsSensitivePublicText(displayName)
    || containsSensitivePublicText(headline)
    || containsSensitivePublicText(about)
  ) throw new PublicPortfolioError("INVALID_REQUEST");
  if (input.publish && !input.confirmPublicDisclosure) {
    throw new PublicPortfolioError("DISCLOSURE_CONFIRMATION_REQUIRED");
  }
  return { slug, displayName, headline, about, selectedProjectIds, selectedAchievementIds, selectedCertificateIds };
}

function mutationHash(input: PublicPortfolioMutation, normalized: ReturnType<typeof normalizeMutation>) {
  return hashSocialEvidence({
    operation: "public-portfolio-update",
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    publish: input.publish,
    confirmPublicDisclosure: input.confirmPublicDisclosure,
    ...normalized,
  });
}

async function assertOwner(client: PoolClient, userId: string) {
  const result = await client.query<{ role: string | null; status: string }>(
    `select role,status from "user" where id=$1 for update`, [userId],
  );
  if (result.rows[0]?.role !== "learner" || result.rows[0]?.status !== "active") {
    throw new PublicPortfolioError("NOT_FOUND");
  }
}

async function validateSelections(
  client: PoolClient,
  userId: string,
  normalized: ReturnType<typeof normalizeMutation>,
  publish: boolean,
) {
  const selectedProjects: Array<{
    id: string;
    title: string;
    summary: string;
    status: string;
    githubUrl: string;
    sourceUpdatedAt: Date;
  }> = [];
  if (normalized.selectedProjectIds.length) {
    // Lock selected rows through commit so validation and the immutable
    // publication snapshot always describe the same project revision.
    const projects = await client.query<{
      id: string; title: string; summary: string; status: string;
      github_url: string | null; updated_at: Date;
    }>(
      `select id,title,summary,status,github_url,updated_at from project
        where user_id=$1 and id=any($2::uuid[]) for share`,
      [userId, normalized.selectedProjectIds],
    );
    if (projects.rows.length !== normalized.selectedProjectIds.length) throw new PublicPortfolioError("INVALID_SELECTION");
    const projectsById = new Map(projects.rows.map((project) => [project.id, project]));
    for (const projectId of normalized.selectedProjectIds) {
      const project = projectsById.get(projectId);
      if (!project) throw new PublicPortfolioError("INVALID_SELECTION");
      if (!project.github_url) throw new PublicPortfolioError("INVALID_SELECTION");
      const githubUrl = normalizePublicGithubRepositoryUrl(project.github_url);
      if (publish && (
        containsSensitivePublicText(project.title)
        || containsSensitivePublicText(project.summary)
      )) throw new PublicPortfolioError("INVALID_SELECTION");
      if (!Number.isFinite(project.updated_at.getTime())) throw new PublicPortfolioError("INVALID_SELECTION");
      selectedProjects.push({
        id: project.id,
        title: project.title,
        summary: project.summary,
        status: project.status,
        githubUrl,
        sourceUpdatedAt: project.updated_at,
      });
    }
  }
  if (normalized.selectedAchievementIds.length) {
    const achievements = await client.query<{ id: string }>(
      `select id from user_achievement where user_id=$1 and revoked_at is null and id=any($2::uuid[])`,
      [userId, normalized.selectedAchievementIds],
    );
    if (achievements.rows.length !== normalized.selectedAchievementIds.length) {
      throw new PublicPortfolioError("INVALID_SELECTION");
    }
  }
  if (normalized.selectedCertificateIds.length) {
    const certificates = await client.query<{ id: string }>(
      `select certificate.id from course_certificate certificate
        where certificate.user_id=$1 and certificate.id=any($2::uuid[])
          and not exists (select 1 from certificate_revocation revoked where revoked.certificate_id=certificate.id)`,
      [userId, normalized.selectedCertificateIds],
    );
    if (certificates.rows.length !== normalized.selectedCertificateIds.length) {
      throw new PublicPortfolioError("INVALID_SELECTION");
    }
  }
  return { selectedProjects } as const;
}

export async function updatePublicPortfolio(input: PublicPortfolioMutation) {
  const now = input.now ?? new Date();
  const normalized = normalizeMutation(input, now);
  const inputHash = mutationHash(input, normalized);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`public-portfolio:${input.userId}`]);
    await assertOwner(client, input.userId);
    const replay = await client.query<{
      input_hash: string; event: string; resulting_version: string | number;
    }>(
      `select input_hash,event,resulting_version from public_portfolio_event
        where user_id=$1 and request_id=$2`, [input.userId, input.requestId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].input_hash !== inputHash) throw new PublicPortfolioError("IDEMPOTENCY_MISMATCH");
      await client.query("commit");
      return { rowVersion: Number(replay.rows[0].resulting_version), event: replay.rows[0].event, replayed: true } as const;
    }
    const existing = await client.query<{ row_version: string | number; is_published: boolean }>(
      `select row_version,is_published from public_portfolio where user_id=$1 for update`, [input.userId],
    );
    if (Number(existing.rows[0]?.row_version ?? 0) !== input.expectedVersion) {
      throw new PublicPortfolioError("VERSION_CONFLICT");
    }
    const selections = await validateSelections(client, input.userId, normalized, input.publish);
    const resultingVersion = input.expectedVersion + 1;
    const event = !existing.rows[0]
      ? input.publish ? "published" : "created"
      : existing.rows[0].is_published && !input.publish ? "withdrawn"
        : !existing.rows[0].is_published && input.publish ? "published" : "updated";
    await client.query(
      `insert into public_portfolio
        (user_id,slug,display_name,headline,about,is_published,row_version,published_at,withdrawn_at,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       on conflict (user_id) do update set slug=excluded.slug,display_name=excluded.display_name,
         headline=excluded.headline,about=excluded.about,is_published=excluded.is_published,
         row_version=excluded.row_version,
         published_at=case when excluded.is_published then coalesce(public_portfolio.published_at,excluded.updated_at) else public_portfolio.published_at end,
         withdrawn_at=case when excluded.is_published then null else excluded.updated_at end,
         updated_at=excluded.updated_at`,
      [input.userId, normalized.slug, normalized.displayName, normalized.headline, normalized.about,
        input.publish, resultingVersion, input.publish ? now : null, input.publish ? null : now, now],
    );
    await client.query(`delete from public_portfolio_project where user_id=$1`, [input.userId]);
    await client.query(`delete from public_portfolio_achievement where user_id=$1`, [input.userId]);
    await client.query(`delete from public_portfolio_certificate where user_id=$1`, [input.userId]);
    for (const [position, projectId] of normalized.selectedProjectIds.entries()) {
      await client.query(
        `insert into public_portfolio_project (user_id,project_id,position,created_at) values ($1,$2,$3,$4)`,
        [input.userId, projectId, position + 1, now],
      );
    }
    if (input.publish) {
      // A new portfolio version appends a new allowlisted projection. Later
      // project edits cannot silently change what this publication exposes.
      for (const project of selections.selectedProjects) {
        await client.query(
          `insert into public_portfolio_project_snapshot
            (user_id,project_id,portfolio_version,title,summary,status,github_url,source_project_updated_at,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [input.userId, project.id, resultingVersion, project.title, project.summary,
            project.status, project.githubUrl, project.sourceUpdatedAt, now],
        );
      }
    }
    for (const [position, achievementId] of normalized.selectedAchievementIds.entries()) {
      await client.query(
        `insert into public_portfolio_achievement (user_id,user_achievement_id,position,created_at) values ($1,$2,$3,$4)`,
        [input.userId, achievementId, position + 1, now],
      );
    }
    for (const [position, certificateId] of normalized.selectedCertificateIds.entries()) {
      await client.query(
        `insert into public_portfolio_certificate (user_id,certificate_id,position,created_at) values ($1,$2,$3,$4)`,
        [input.userId, certificateId, position + 1, now],
      );
    }
    const snapshot = {
      requestHash: inputHash,
      slug: normalized.slug,
      displayName: normalized.displayName,
      headline: normalized.headline,
      about: normalized.about,
      isPublished: input.publish,
      publicDisclosureConfirmed: input.publish,
      selectedProjectIds: normalized.selectedProjectIds,
      selectedProjects: input.publish ? selections.selectedProjects.map((project) => ({
        id: project.id,
        title: project.title,
        summary: project.summary,
        status: project.status,
        githubUrl: project.githubUrl,
        sourceUpdatedAt: project.sourceUpdatedAt.toISOString(),
      })) : [],
      selectedAchievementIds: normalized.selectedAchievementIds,
      selectedCertificateIds: normalized.selectedCertificateIds,
    };
    const reason = event === "published"
      ? "Learner explicitly opted in to the bounded public portfolio projection."
      : event === "withdrawn"
        ? "Learner explicitly withdrew the public portfolio projection."
        : "Learner edited private portfolio configuration and selections.";
    await client.query(
      `insert into public_portfolio_event
        (user_id,actor_user_id,request_id,event,input_hash,snapshot,evidence_hash,reason,resulting_version,occurred_at)
       values ($1,$1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [input.userId, input.requestId, event, inputHash, JSON.stringify(snapshot),
        hashSocialEvidence(snapshot), reason, resultingVersion, now],
    );
    await client.query("commit");
    return { rowVersion: resultingVersion, event, replayed: false } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    const pg = error as { code?: string; constraint?: string };
    if (pg.code === "23505" && pg.constraint === "public_portfolio_slug_unique") {
      throw new PublicPortfolioError("SLUG_TAKEN");
    }
    if (pg.code === "23514") throw new PublicPortfolioError("INVALID_SELECTION");
    throw error;
  } finally {
    client.release();
  }
}

type PortfolioRow = {
  user_id: string; slug: string; display_name: string; headline: string; about: string | null;
  is_published: boolean; row_version: string | number; published_at: Date | null; withdrawn_at: Date | null;
};

function suggestedSlug(publicId: string) {
  return `learner-${publicId.replaceAll("-", "").slice(0, 12)}`;
}

export async function loadOwnPublicPortfolioSettings(userId: string) {
  const owner = await pool.query<{ name: string; public_id: string }>(
    `select name,public_id from "user" where id=$1 and status='active'`, [userId],
  );
  if (!owner.rows[0]) throw new PublicPortfolioError("NOT_FOUND");
  const profile = (await pool.query<PortfolioRow>(`select * from public_portfolio where user_id=$1`, [userId])).rows[0] ?? null;
  const [projects, achievements, certificates, selectedProjects, selectedAchievements, selectedCertificates] = await Promise.all([
    pool.query<{ id: string; title: string; summary: string; status: string; github_url: string }>(
      `select id,title,summary,status,github_url from project
        where user_id=$1 and github_url is not null order by updated_at desc,id`, [userId],
    ),
    pool.query<{ id: string; title: string; description: string; icon: string }>(
      `select owned.id,achievement.title,achievement.description,achievement.icon
         from user_achievement owned join achievement on achievement.id=owned.achievement_id
        where owned.user_id=$1 and owned.revoked_at is null order by owned.awarded_at desc,owned.id`, [userId],
    ),
    pool.query<{ id: string; title: string; version: string; verification_id: string; issued_at: Date }>(
      `select certificate.id,certificate.course_title title,certificate.course_version_label version,
              certificate.verification_id,certificate.issued_at
         from course_certificate certificate
        where certificate.user_id=$1 and not exists (
          select 1 from certificate_revocation revoked where revoked.certificate_id=certificate.id)
        order by certificate.issued_at desc,certificate.id`, [userId],
    ),
    pool.query<{ project_id: string }>(`select project_id from public_portfolio_project where user_id=$1`, [userId]),
    pool.query<{ user_achievement_id: string }>(`select user_achievement_id from public_portfolio_achievement where user_id=$1`, [userId]),
    pool.query<{ certificate_id: string }>(`select certificate_id from public_portfolio_certificate where user_id=$1`, [userId]),
  ]);
  const projectSet = new Set(selectedProjects.rows.map((row) => row.project_id));
  const achievementSet = new Set(selectedAchievements.rows.map((row) => row.user_achievement_id));
  const certificateSet = new Set(selectedCertificates.rows.map((row) => row.certificate_id));
  return {
    profile: {
      slug: profile?.slug ?? suggestedSlug(owner.rows[0].public_id),
      displayName: profile?.display_name ?? owner.rows[0].name,
      headline: profile?.headline ?? "Learning in public, one verified milestone at a time",
      about: profile?.about ?? "",
      isPublished: profile?.is_published ?? false,
      rowVersion: Number(profile?.row_version ?? 0),
      publishedAt: profile?.published_at?.toISOString() ?? null,
      withdrawnAt: profile?.withdrawn_at?.toISOString() ?? null,
    },
    projects: projects.rows.flatMap((row) => {
      try {
        return [{ id: row.id, title: row.title, summary: row.summary, status: row.status,
          githubUrl: normalizePublicGithubRepositoryUrl(row.github_url), selected: projectSet.has(row.id) }];
      } catch { return []; }
    }),
    achievements: achievements.rows.map((row) => ({ ...row, selected: achievementSet.has(row.id) })),
    certificates: certificates.rows.map((row) => ({
      id: row.id, title: row.title, version: row.version, verificationId: row.verification_id,
      issuedAt: row.issued_at.toISOString(), selected: certificateSet.has(row.id),
    })),
    disclosure: "Publishing exposes only your chosen display name, headline, about text, selected project summaries and GitHub links, selected badge labels, and selected certificate verification links. Email, scores, attempts, activity, study time, code, chat, and provider data are excluded.",
  };
}

export async function loadPublicPortfolio(slug: string) {
  if (!SLUG_PATTERN.test(slug)) throw new PublicPortfolioError("NOT_FOUND");
  const result = await pool.query<PortfolioRow>(
    `select portfolio.* from public_portfolio portfolio
      join "user" owner on owner.id=portfolio.user_id
     where lower(portfolio.slug)=lower($1) and portfolio.is_published and owner.status='active'`,
    [slug],
  );
  const profile = result.rows[0];
  if (!profile) throw new PublicPortfolioError("NOT_FOUND");
  if (
    containsSensitivePublicText(profile.display_name)
    || containsSensitivePublicText(profile.headline)
    || containsSensitivePublicText(profile.about)
  ) throw new PublicPortfolioError("NOT_FOUND");
  const [projects, achievements, certificates] = await Promise.all([
    pool.query<{ id: string; title: string; summary: string; status: string; github_url: string; position: number }>(
      `select snapshot.project_id id,snapshot.title,snapshot.summary,snapshot.status,
              snapshot.github_url,selected.position
         from public_portfolio_project selected
         join public_portfolio_project_snapshot snapshot
           on snapshot.user_id=selected.user_id and snapshot.project_id=selected.project_id
          and snapshot.portfolio_version=$2
        where selected.user_id=$1 order by selected.position,snapshot.project_id`,
      [profile.user_id, Number(profile.row_version)],
    ),
    pool.query<{ id: string; title: string; description: string; icon: string; position: number }>(
      `select owned.id,achievement.title,achievement.description,achievement.icon,selected.position
         from public_portfolio_achievement selected
         join user_achievement owned on owned.id=selected.user_achievement_id and owned.user_id=selected.user_id
         join achievement on achievement.id=owned.achievement_id
        where selected.user_id=$1 and owned.revoked_at is null order by selected.position,owned.id`,
      [profile.user_id],
    ),
    pool.query<{ id: string; title: string; version: string; verification_id: string; issued_at: Date; position: number }>(
      `select certificate.id,certificate.course_title title,certificate.course_version_label version,
              certificate.verification_id,certificate.issued_at,selected.position
         from public_portfolio_certificate selected
         join course_certificate certificate on certificate.id=selected.certificate_id and certificate.user_id=selected.user_id
        where selected.user_id=$1 and not exists (
          select 1 from certificate_revocation revoked where revoked.certificate_id=certificate.id)
        order by selected.position,certificate.id`,
      [profile.user_id],
    ),
  ]);
  return {
    slug: profile.slug,
    displayName: profile.display_name,
    headline: profile.headline,
    ...(profile.about ? { about: profile.about } : {}),
    publishedAt: profile.published_at!.toISOString(),
    projects: projects.rows.flatMap((row) => {
      if (containsSensitivePublicText(row.title) || containsSensitivePublicText(row.summary)) return [];
      try {
        return [{ id: row.id, title: row.title, summary: row.summary, status: row.status,
          githubUrl: normalizePublicGithubRepositoryUrl(row.github_url) }];
      } catch { return []; }
    }),
    achievements: achievements.rows.map((row) => ({
      id: row.id, title: row.title, description: row.description, icon: row.icon,
    })),
    certificates: certificates.rows.map((row) => ({
      id: row.id, title: row.title, version: row.version, issuedAt: row.issued_at.toISOString(),
      verificationPath: `/verify/${row.verification_id}`,
    })),
    privacyNotice: "This page is a learner-selected public projection. It does not expose email, assessment scores, attempts, activity, study time, code, chat, or AI-provider data.",
  };
}
