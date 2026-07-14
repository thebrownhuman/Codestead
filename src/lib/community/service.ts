import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";
import { redactSensitiveText } from "@/lib/security/sensitive-text";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHOR_DELETED_POST_TITLE = "[deleted by author]";
const AUTHOR_DELETED_BODY = "[deleted by author]";

export type CommunityErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "IDEMPOTENCY_CONFLICT"
  | "VERSION_CONFLICT"
  | "DUPLICATE_REPORT";

export class CommunityError extends Error {
  constructor(public readonly code: CommunityErrorCode) {
    super(code);
  }
}

type Actor = { id: string; role: "admin" | "learner" };
type CommunityReplyRow = {
  id: string; post_id: string; body: string; state: string; row_version: string | number;
  created_at: Date; edited_at: Date | null; author_alias: string; own: boolean;
};

function plainText(value: string, minimum: number, maximum: number): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  const sensitiveProjection = redactSensitiveText(normalized, maximum);
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || sensitiveProjection.redacted
    || sensitiveProjection.truncated
  ) {
    throw new CommunityError("INVALID_INPUT");
  }
  return sensitiveProjection.text;
}

function optionalPlainText(value: string | null | undefined, minimum: number, maximum: number) {
  if (value === null || value === undefined || !value.trim()) return null;
  return plainText(value, minimum, maximum);
}

function contentHash(...parts: string[]) {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

async function idempotentCommunityMutation<T extends Record<string, unknown>>(input: {
  actorUserId: string;
  requestId: string;
  action: "create_group" | "add_member" | "create_post" | "reply" | "moderate";
  canonicalInput: Record<string, unknown>;
  mutate: (client: PoolClient, actor: Actor) => Promise<T>;
}): Promise<T & { replayed: boolean }> {
  if (!UUID.test(input.requestId)) throw new CommunityError("INVALID_INPUT");
  const inputHash = contentHash(input.action, JSON.stringify(input.canonicalInput));
  const client = await pool.connect();
  try {
    await client.query("begin");
    const actor = await activeActor(client, input.actorUserId);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `community-operation:${actor.id}:${input.requestId}`,
    ]);
    const prior = await client.query<{
      action: string;
      input_hash: string;
      result: T;
    }>(
      `select action,input_hash,result from community_operation_receipt
        where user_id=$1 and request_id=$2`,
      [actor.id, input.requestId],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].action !== input.action || prior.rows[0].input_hash !== inputHash) {
        throw new CommunityError("IDEMPOTENCY_CONFLICT");
      }
      await client.query("commit");
      return { ...prior.rows[0].result, replayed: true };
    }
    const result = await input.mutate(client, actor);
    await client.query(
      `insert into community_operation_receipt
        (user_id,request_id,action,input_hash,result)
       values ($1,$2,$3,$4,$5::jsonb)`,
      [actor.id, input.requestId, input.action, inputHash, JSON.stringify(result)],
    );
    await client.query("commit");
    return { ...result, replayed: false };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function activeActor(client: PoolClient, userId: string): Promise<Actor> {
  const row = (await client.query<{ id: string; role: string | null }>(
    `select id, role from "user" where id = $1 and status = 'active' and role in ('admin','learner')`,
    [userId],
  )).rows[0];
  if (!row || (row.role !== "admin" && row.role !== "learner")) throw new CommunityError("NOT_FOUND");
  return { id: row.id, role: row.role };
}

function parseCursor(cursor: string | null | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    const date = new Date(String(at));
    if (!Number.isFinite(date.getTime()) || !UUID.test(String(id))) throw new Error("bad cursor");
    return { at: date, id: String(id) };
  } catch {
    throw new CommunityError("INVALID_INPUT");
  }
}

function cursorFor(at: Date, id: string) {
  return Buffer.from(JSON.stringify([at.toISOString(), id]), "utf8").toString("base64url");
}

async function accessibleGroup(client: PoolClient, actor: Actor, groupId: string, lock = false) {
  if (!UUID.test(groupId)) throw new CommunityError("NOT_FOUND");
  const row = (await client.query<{
    id: string; visibility: "cohort" | "members"; status: string; member_role: string | null;
  }>(
    `select g.id, g.visibility, g.status, member.role as member_role
       from community_group g
       left join community_group_member member on member.group_id = g.id and member.user_id = $2
      where g.id = $1
        and ($3 = 'admin' or g.visibility = 'cohort' or member.user_id is not null)
      ${lock ? "for update of g" : ""}`,
    [groupId, actor.id, actor.role],
  )).rows[0];
  if (!row) throw new CommunityError("NOT_FOUND");
  return row;
}

export async function listCommunity(input: {
  actorUserId: string;
  groupId?: string | null;
  cursor?: string | null;
  limit?: number;
}) {
  const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 20)));
  const cursor = parseCursor(input.cursor);
  const client = await pool.connect();
  try {
    const actor = await activeActor(client, input.actorUserId);
    if (input.groupId) await accessibleGroup(client, actor, input.groupId);
    const groups = await client.query<{
      id: string; name: string; description: string; visibility: string; status: string;
      member_role: string | null; member_count: string;
    }>(
      `select g.id,g.name,g.description,g.visibility,g.status,member.role as member_role,
              (select count(*)::text from community_group_member gm where gm.group_id = g.id) member_count
         from community_group g
         left join community_group_member member on member.group_id = g.id and member.user_id = $1
        where ($2 = 'admin' or g.visibility = 'cohort' or member.user_id is not null)
        order by case when member.user_id is null then 1 else 0 end, lower(g.name), g.id`,
      [actor.id, actor.role],
    );
    const posts = await client.query<{
      id: string; group_id: string; kind: string; title: string; body: string; state: string;
      row_version: string | number; created_at: Date; edited_at: Date | null; author_alias: string;
      own: boolean;
    }>(
      `select p.id,p.group_id,p.kind,p.title,p.body,p.state,p.row_version,p.created_at,p.edited_at,
              case
                when p.author_user_id = $1 then 'You'
                when profile.is_published and consent.decision = 'accepted' and consent.policy_version = $7 then profile.alias
                else 'Cohort learner'
              end as author_alias,
              p.author_user_id = $1 as own
         from community_post p
         join community_group g on g.id = p.group_id
         left join community_group_member member on member.group_id = g.id and member.user_id = $1
         left join cohort_profile profile on profile.user_id = p.author_user_id
         left join lateral (
           select decision,policy_version from consent_record c
            where c.user_id = p.author_user_id and c.purpose = 'cohort_profile'
            order by c.occurred_at desc,c.created_at desc,c.id desc limit 1
         ) consent on true
        where ($2::uuid is null or p.group_id = $2)
          and ($3 = 'admin' or g.visibility = 'cohort' or member.user_id is not null)
          and ($3 = 'admin' or p.state = 'active')
          and ($4::timestamptz is null or (p.created_at,p.id) < ($4,$5::uuid))
        order by p.created_at desc,p.id desc limit $6`,
      [actor.id, input.groupId ?? null, actor.role, cursor?.at ?? null, cursor?.id ?? null, limit + 1, ENROLLMENT_DISCLOSURE_VERSION],
    );
    const page = posts.rows.slice(0, limit);
    const postIds = page.map((row) => row.id);
    const replyRows: CommunityReplyRow[] = postIds.length
      ? (await client.query<CommunityReplyRow>(
          `select * from (
             select r.id,r.post_id,r.body,r.state,r.row_version,r.created_at,r.edited_at,
                    case
                      when r.author_user_id = $1 then 'You'
                      when profile.is_published and consent.decision = 'accepted' and consent.policy_version = $4 then profile.alias
                      else 'Cohort learner'
                    end as author_alias,
                    r.author_user_id = $1 as own,
                    row_number() over (partition by r.post_id order by r.created_at,r.id) as reply_rank
               from community_reply r
               left join cohort_profile profile on profile.user_id = r.author_user_id
               left join lateral (
                 select decision,policy_version from consent_record c
                  where c.user_id = r.author_user_id and c.purpose = 'cohort_profile'
                  order by c.occurred_at desc,c.created_at desc,c.id desc limit 1
               ) consent on true
              where r.post_id = any($2::uuid[]) and ($3 = 'admin' or r.state = 'active')
           ) ranked where reply_rank <= 20 order by post_id,created_at,id`,
          [actor.id, postIds, actor.role, ENROLLMENT_DISCLOSURE_VERSION],
        )).rows
      : [];
    const repliesByPost = new Map<string, CommunityReplyRow[]>();
    for (const reply of replyRows) {
      const list = repliesByPost.get(reply.post_id) ?? [];
      list.push(reply);
      repliesByPost.set(reply.post_id, list);
    }
    return {
      groups: groups.rows.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        visibility: group.visibility,
        status: group.status,
        membershipRole: group.member_role,
        memberCount: Number(group.member_count),
      })),
      posts: page.map((post) => ({
        id: post.id,
        groupId: post.group_id,
        kind: post.kind,
        title: post.title,
        body: post.body,
        state: post.state,
        rowVersion: Number(post.row_version),
        createdAt: post.created_at.toISOString(),
        editedAt: post.edited_at?.toISOString() ?? null,
        authorAlias: post.author_alias,
        own: post.own,
        replies: (repliesByPost.get(post.id) ?? []).map((reply) => ({
          id: reply.id,
          body: reply.body,
          state: reply.state,
          rowVersion: Number(reply.row_version),
          createdAt: reply.created_at.toISOString(),
          editedAt: reply.edited_at?.toISOString() ?? null,
          authorAlias: reply.author_alias,
          own: reply.own,
        })),
      })),
      nextCursor: posts.rows.length > limit && page.at(-1)
        ? cursorFor(page.at(-1)!.created_at, page.at(-1)!.id)
        : null,
      moderation: actor.role === "admin",
      privacy: "Posts expose only plain text and an eligible cohort alias. Learning evidence, real names, email, activity, and AI history are never joined.",
    };
  } finally {
    client.release();
  }
}

export async function createCommunityGroup(input: {
  actorUserId: string; requestId: string; name: string; description: string; visibility: "cohort" | "members";
}) {
  const name = plainText(input.name, 3, 80);
  const description = plainText(input.description, 10, 500);
  try {
    return await idempotentCommunityMutation({
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      action: "create_group",
      canonicalInput: { name, description, visibility: input.visibility },
      mutate: async (client, actor) => {
        const group = (await client.query<{ id: string }>(
          `insert into community_group (created_by_user_id,name,description,visibility)
           values ($1,$2,$3,$4) returning id`,
          [actor.id, name, description, input.visibility],
        )).rows[0];
        if (!group) throw new CommunityError("INVALID_INPUT");
        await client.query(
          `insert into community_group_member (group_id,user_id,role) values ($1,$2,'owner')`,
          [group.id, actor.id],
        );
        return { id: group.id };
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new CommunityError("INVALID_INPUT");
    throw error;
  }
}

export async function addCommunityGroupMember(input: {
  actorUserId: string; requestId: string; groupId: string; learnerPublicId: string;
}) {
  if (!UUID.test(input.learnerPublicId)) throw new CommunityError("NOT_FOUND");
  return idempotentCommunityMutation({
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    action: "add_member",
    canonicalInput: { groupId: input.groupId, learnerPublicId: input.learnerPublicId },
    mutate: async (client, actor) => {
      const group = await accessibleGroup(client, actor, input.groupId);
      if (actor.role !== "admin" && group.member_role !== "owner" && group.member_role !== "moderator") {
        throw new CommunityError("NOT_FOUND");
      }
      const target = (await client.query<{ id: string }>(
        `select u.id from "user" u
          join cohort_profile profile on profile.user_id = u.id and profile.is_published
          join lateral (
            select decision,policy_version from consent_record consent
             where consent.user_id=u.id and consent.purpose='cohort_profile'
             order by consent.occurred_at desc,consent.created_at desc,consent.id desc limit 1
          ) consent on consent.decision='accepted' and consent.policy_version=$2
          where u.public_id = $1 and u.status = 'active' and u.role = 'learner'`,
        [input.learnerPublicId, ENROLLMENT_DISCLOSURE_VERSION],
      )).rows[0];
      if (!target) throw new CommunityError("NOT_FOUND");
      await client.query(
        `insert into community_group_member (group_id,user_id,role) values ($1,$2,'member')
         on conflict (group_id,user_id) do nothing`,
        [input.groupId, target.id],
      );
      return { added: true };
    },
  });
}

export async function createCommunityPost(input: {
  actorUserId: string; requestId: string; groupId: string; kind: "discussion" | "help" | "project_share";
  title: string; body: string;
}) {
  const title = plainText(input.title, 3, 160);
  const body = plainText(input.body, 10, 8_000);
  return idempotentCommunityMutation({
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    action: "create_post",
    canonicalInput: { groupId: input.groupId, kind: input.kind, title, body },
    mutate: async (client, actor) => {
      const group = await accessibleGroup(client, actor, input.groupId);
      if (group.status !== "active") throw new CommunityError("NOT_FOUND");
      const row = (await client.query<{ id: string; row_version: string | number }>(
        `insert into community_post (group_id,author_user_id,kind,title,body,content_hash)
         values ($1,$2,$3,$4,$5,$6) returning id,row_version`,
        [input.groupId, actor.id, input.kind, title, body, contentHash(title, body)],
      )).rows[0];
      return { id: row!.id, rowVersion: Number(row!.row_version) };
    },
  });
}

export async function createCommunityReply(input: { actorUserId: string; requestId: string; postId: string; body: string }) {
  if (!UUID.test(input.postId)) throw new CommunityError("NOT_FOUND");
  const body = plainText(input.body, 2, 4_000);
  return idempotentCommunityMutation({
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    action: "reply",
    canonicalInput: { postId: input.postId, body },
    mutate: async (client, actor) => {
      const post = (await client.query<{ group_id: string }>(
        `select p.group_id from community_post p where p.id = $1 and p.state = 'active'`, [input.postId],
      )).rows[0];
      if (!post) throw new CommunityError("NOT_FOUND");
      await accessibleGroup(client, actor, post.group_id);
      const row = (await client.query<{ id: string; row_version: string | number }>(
        `insert into community_reply (post_id,author_user_id,body,content_hash)
         values ($1,$2,$3,$4) returning id,row_version`,
        [input.postId, actor.id, body, contentHash("", body)],
      )).rows[0];
      return { id: row!.id, rowVersion: Number(row!.row_version) };
    },
  });
}

export async function editCommunityContent(input: {
  actorUserId: string; target: "post" | "reply"; targetId: string; expectedVersion: number;
  title?: string; body: string;
}) {
  if (!UUID.test(input.targetId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new CommunityError("INVALID_INPUT");
  }
  const body = plainText(input.body, input.target === "post" ? 10 : 2, input.target === "post" ? 8_000 : 4_000);
  const title = input.target === "post" ? plainText(input.title ?? "", 3, 160) : null;
  const client = await pool.connect();
  try {
    await activeActor(client, input.actorUserId);
    const table = input.target === "post" ? "community_post" : "community_reply";
    const row = (await client.query<{ row_version: string | number }>(
      input.target === "post"
        ? `update ${table} set title=$4,body=$5,content_hash=$6,row_version=row_version+1,edited_at=now(),updated_at=now()
             where id=$1 and author_user_id=$2 and row_version=$3 and state='active' returning row_version`
        : `update ${table} set body=$5,content_hash=$6,row_version=row_version+1,edited_at=now(),updated_at=now()
             where id=$1 and author_user_id=$2 and row_version=$3 and state='active' returning row_version`,
      [input.targetId, input.actorUserId, input.expectedVersion, title, body, contentHash(title ?? "", body)],
    )).rows[0];
    if (row) return { rowVersion: Number(row.row_version) };
    const owned = await client.query(`select 1 from ${table} where id=$1 and author_user_id=$2`, [input.targetId, input.actorUserId]);
    if (!owned.rows[0]) throw new CommunityError("NOT_FOUND");
    throw new CommunityError("VERSION_CONFLICT");
  } finally {
    client.release();
  }
}

export async function deleteCommunityContent(input: {
  actorUserId: string; target: "post" | "reply"; targetId: string; expectedVersion: number;
}) {
  if (!UUID.test(input.targetId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new CommunityError("INVALID_INPUT");
  }
  const client = await pool.connect();
  try {
    await activeActor(client, input.actorUserId);
    const table = input.target === "post" ? "community_post" : "community_reply";
    const row = (await client.query<{ row_version: string | number }>(
      input.target === "post"
        ? `update ${table}
              set title=$4,body=$5,content_hash=$6,state='deleted',deleted_at=now(),
                  moderated_by_user_id=null,moderation_reason=null,
                  row_version=row_version+1,edited_at=null,updated_at=now()
            where id=$1 and author_user_id=$2 and row_version=$3 and state='active'
            returning row_version`
        : `update ${table}
              set body=$4,content_hash=$5,state='deleted',deleted_at=now(),
                  moderated_by_user_id=null,moderation_reason=null,
                  row_version=row_version+1,edited_at=null,updated_at=now()
            where id=$1 and author_user_id=$2 and row_version=$3 and state='active'
            returning row_version`,
      input.target === "post"
        ? [
            input.targetId,
            input.actorUserId,
            input.expectedVersion,
            AUTHOR_DELETED_POST_TITLE,
            AUTHOR_DELETED_BODY,
            contentHash(AUTHOR_DELETED_POST_TITLE, AUTHOR_DELETED_BODY),
          ]
        : [
            input.targetId,
            input.actorUserId,
            input.expectedVersion,
            AUTHOR_DELETED_BODY,
            contentHash("", AUTHOR_DELETED_BODY),
          ],
    )).rows[0];
    if (row) return { rowVersion: Number(row.row_version) };
    const owned = await client.query(`select 1 from ${table} where id=$1 and author_user_id=$2`, [input.targetId, input.actorUserId]);
    if (!owned.rows[0]) throw new CommunityError("NOT_FOUND");
    throw new CommunityError("VERSION_CONFLICT");
  } finally {
    client.release();
  }
}

export async function reportCommunityContent(input: {
  actorUserId: string; target: "post" | "reply"; targetId: string;
  reason: "harassment" | "unsafe_code" | "spam" | "privacy" | "other"; details?: string | null;
}) {
  if (!UUID.test(input.targetId)) throw new CommunityError("NOT_FOUND");
  const details = optionalPlainText(input.details, 4, 1_000);
  const client = await pool.connect();
  try {
    const actor = await activeActor(client, input.actorUserId);
    const target = input.target === "post"
      ? (await client.query<{ group_id: string }>(`select group_id from community_post where id=$1 and state='active'`, [input.targetId])).rows[0]
      : (await client.query<{ group_id: string }>(
          `select p.group_id from community_reply r join community_post p on p.id=r.post_id
            where r.id=$1 and r.state='active' and p.state='active'`, [input.targetId],
        )).rows[0];
    if (!target) throw new CommunityError("NOT_FOUND");
    await accessibleGroup(client, actor, target.group_id);
    try {
      const row = (await client.query<{ id: string }>(
        `insert into community_report (reporter_user_id,post_id,reply_id,reason,details)
         values ($1,$2,$3,$4,$5) returning id`,
        [actor.id, input.target === "post" ? input.targetId : null, input.target === "reply" ? input.targetId : null, input.reason, details],
      )).rows[0];
      return { id: row!.id, replayed: false };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const replay = (await client.query<{ id: string }>(
          `select id from community_report where reporter_user_id=$1 and ${input.target === "post" ? "post_id" : "reply_id"}=$2`,
          [actor.id, input.targetId],
        )).rows[0];
        if (replay) return { id: replay.id, replayed: true };
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function listCommunityReports(actorUserId: string, limit = 100) {
  const client = await pool.connect();
  try {
    const actor = await activeActor(client, actorUserId);
    if (actor.role !== "admin") throw new CommunityError("NOT_FOUND");
    const rows = await client.query<{
      id: string; reason: string; details: string | null; status: string; post_id: string | null;
      reply_id: string | null; created_at: Date; excerpt: string;
    }>(
      `select report.id,report.reason,report.details,report.status,report.post_id,report.reply_id,report.created_at,
              left(coalesce(post.body,reply.body,''),500) excerpt
         from community_report report
         left join community_post post on post.id=report.post_id
         left join community_reply reply on reply.id=report.reply_id
        order by case when report.status='open' then 0 else 1 end,report.created_at,report.id
        limit $1`,
      [Math.min(200, Math.max(1, Math.trunc(limit)))],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      details: row.details,
      status: row.status,
      target: row.post_id ? "post" as const : "reply" as const,
      targetId: row.post_id ?? row.reply_id!,
      excerpt: row.excerpt,
      createdAt: row.created_at.toISOString(),
    }));
  } finally {
    client.release();
  }
}

export async function moderateCommunityContent(input: {
  actorUserId: string; requestId: string; reportId?: string | null; target: "post" | "reply"; targetId: string;
  action: "hide" | "restore" | "delete"; reason: string;
}) {
  if (!UUID.test(input.targetId) || (input.reportId && !UUID.test(input.reportId))) throw new CommunityError("NOT_FOUND");
  const reason = plainText(input.reason, 8, 1_000);
  const resultingState = input.action === "hide" ? "hidden" : input.action === "restore" ? "active" : "deleted";
  return idempotentCommunityMutation({
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    action: "moderate",
    canonicalInput: {
      reportId: input.reportId ?? null,
      target: input.target,
      targetId: input.targetId,
      action: input.action,
      reason,
    },
    mutate: async (client, actor) => {
      if (actor.role !== "admin") throw new CommunityError("NOT_FOUND");
      const table = input.target === "post" ? "community_post" : "community_reply";
      const target = (await client.query<{ state: string }>(
        `select state from ${table} where id=$1 for update`, [input.targetId],
      )).rows[0];
      if (!target) throw new CommunityError("NOT_FOUND");
      // Author deletion is an irreversible withdrawal. Moderation can restore
      // only content hidden by moderation, never republish an author's deletion.
      if (input.action === "restore" && target.state === "deleted") {
        throw new CommunityError("INVALID_INPUT");
      }
      await client.query(
        `update ${table} set state=$2,deleted_at=case when $2='deleted' then now() else null end,
           moderated_by_user_id=$3,moderation_reason=$4,row_version=row_version+1,updated_at=now() where id=$1`,
        [input.targetId, resultingState, actor.id, reason],
      );
      if (input.reportId) {
        const report = await client.query(
          `update community_report set status=$2,decided_by_user_id=$3,decision_reason=$4,decided_at=now(),updated_at=now()
            where id=$1 and status='open' and ${input.target === "post" ? "post_id" : "reply_id"}=$5 returning id`,
          [input.reportId, input.action === "restore" ? "dismissed" : "resolved", actor.id, reason, input.targetId],
        );
        if (!report.rows[0]) throw new CommunityError("NOT_FOUND");
      }
      await client.query(
        `insert into community_moderation_event
          (actor_user_id,report_id,post_id,reply_id,action,prior_state,resulting_state,reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [actor.id, input.reportId ?? null, input.target === "post" ? input.targetId : null,
          input.target === "reply" ? input.targetId : null, input.action, target.state, resultingState, reason],
      );
      return { priorState: target.state, resultingState };
    },
  });
}

export const communityTextPolicy = Object.freeze({
  rendering: "plain_text_only",
  stripsControlCharacters: true,
  htmlInterpretation: false,
  maximumPostBodyCharacters: 8_000,
  maximumReplyBodyCharacters: 4_000,
});
