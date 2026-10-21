import { describe, expect, it, vi } from "vitest";
import {
  inheritMailWorkerRole, lockMailWorkerSource, mailWorkerCallableQuery,
  mailWorkerReleaseRoutine, registerMailWorkerResources, usesMailWorkerRole,
} from "../mail-worker-role";
import { lockMailWorkerRevocableSources } from "../mail-worker-source-locks";
import type { RevocableSourceAuthorityQuery } from "../revocable-source-authority";

function mark(executor: object) {
  const url = new URL("postgresql://localhost/fixture");
  url.username = "learncoding_mail_worker";
  registerMailWorkerResources(executor, {}, url.href);
}

describe("mail worker SQL adapters", () => {
  it.each(["outbox", "candidate"])("delegates %s private-marker checks without removing receipt matching", alias => {
    const client = {};
    const text = `select 1 where ${alias}.delivery_hold_version='task7-v1'
      and ${alias}.delivery_release_insert_xid is null
      and ${alias}.delivery_release_insert_system_identifier is null
      and exists (select 1 from public.mail_delivery_release_receipt release
        where release.outbox_id=${alias}.id and release.operation_id=${alias}.operation_id)`;
    expect(mailWorkerCallableQuery(client, text)).toBe(text);
    mark(client);
    const delegated = mailWorkerCallableQuery(client, text);
    expect(delegated).toContain(`public.mail_worker_mail_delivery_release_receipt_sha256(${alias}.id, ${alias}.operation_id, ${alias}.idempotency_authority_version, ${alias}.idempotency_authority_sha256, ${alias}.idempotency_original_payload_sha256, ${alias}.delivery_hold_version) is not null`);
    expect(delegated).toContain(`${alias}.delivery_hold_version='task7-v1'`);
    expect(delegated).toContain(`release.outbox_id=${alias}.id and release.operation_id=${alias}.operation_id`);
    expect(delegated).not.toContain(`${alias}.delivery_release_insert_xid`);
    expect(delegated).not.toContain(`${alias}.delivery_release_insert_system_identifier`);
    expect(mailWorkerCallableQuery(client, delegated)).toBe(delegated);
  });

  it("keeps application and shared-worker executors on the original routines", () => {
    const executor = {};
    const query = "select public.backup_status_mail_authorized($1)";
    expect(usesMailWorkerRole(executor)).toBe(false);
    expect(mailWorkerCallableQuery(executor, query)).toBe(query);
    expect(mailWorkerReleaseRoutine(executor)).toBe("public.release_email_outbox_delivery");
  });

  it("inherits the dedicated adapter only from its registered pool or database", () => {
    const pool = {}, client = {};
    mark(pool);
    inheritMailWorkerRole(pool, client);
    expect(usesMailWorkerRole(client)).toBe(true);
    expect(mailWorkerReleaseRoutine(client)).toBe("public.mail_worker_release_email_outbox_delivery");
    const query = "select public.backup_status_mail_authorized($1), public.mail_delivery_release_receipt_sha256($2)";
    expect(mailWorkerCallableQuery(client, query)).toBe(
      "select public.mail_worker_backup_status_mail_authorized($1), public.mail_worker_mail_delivery_release_receipt_sha256($2)",
    );
    const catalog = "select to_regprocedure('public.backup_status_mail_authorized(uuid)')";
    expect(mailWorkerCallableQuery(client, catalog)).toBe(catalog);
  });

  it("redacts invalid database configuration and rejects malformed helper results", async () => {
    expect(() => registerMailWorkerResources({}, {}, "invalid"))
      .toThrow("Mail database configuration is invalid.");
    for (const rows of [[], [{ locked: "true" }], [{ locked: true }, { locked: false }]]) {
      await expect(lockMailWorkerSource({ query: async () => ({ rows }) }, "user", "fixture"))
        .rejects.toThrow("Mail source lock result is invalid.");
    }
  });

  it("locks account, subject, source, and session before a fresh proof re-read", async () => {
    const query = vi.fn(async (text: string, values?: unknown[]) => { void values; return ({ rows: text.startsWith("select user_id")
      ? [{ user_id: "subject", session_id: "session" }]
      : [{ locked: true }] }); });
    const client = { query };
    mark(client);
    const authority: RevocableSourceAuthorityQuery = {
      kind: "lost-device-proof",
      text: "select 1 where original_predicate for share of recipient_user, source_proof, source_session",
      values: ["outbox", "source"],
    };
    const locked = await lockMailWorkerRevocableSources(client, "recipient", authority);
    expect(query.mock.calls.map(([, values]) => values).filter(Boolean)).toEqual([
      ["user", "recipient", "share"], ["source"], ["user", "subject", "share"],
      ["lost_device_proof", "source", "share"], ["session", "session", "share"],
    ]);
    expect(locked?.text).toBe(
      "select 1 where original_predicate and source_proof.user_id=$3::text and source_proof.session_id=$4::text",
    );
    expect(locked?.values).toEqual(["outbox", "source", "subject", "session"]);
    expect(authority.text).toContain("for share");
  });

  it("fails closed on missing source locks and changed lock-clause contracts", async () => {
    const authority: RevocableSourceAuthorityQuery = {
      kind: "reset-password",
      text: "select 1 where original_predicate for share of recipient_user, source_verification",
      values: ["outbox", "source"],
    };
    const missing = { query: vi.fn(async () => ({ rows: [{ locked: false }] })) };
    mark(missing);
    expect(await lockMailWorkerRevocableSources(missing, "recipient", authority)).toBeNull();
    const client = { query: vi.fn(async () => ({ rows: [{ locked: true }] })) };
    mark(client);
    await expect(lockMailWorkerRevocableSources(client, "recipient", {
      ...authority, text: "select 1 where original_predicate",
    })).rejects.toThrow("Mail source authority lock contract is invalid.");
    const shared = { query: vi.fn() };
    expect(await lockMailWorkerRevocableSources(shared, "recipient", authority)).toBe(authority);
    expect(shared.query).not.toHaveBeenCalled();
  });

  it.each([
    ["reset-password", "recipient_user, source_verification", "verification"],
    ["session-revocation-requested", "recipient_user, source_request, subject_user", "session_revocation_request"],
    ["inactivity", "recipient_user, learner_user, source_episode", "inactivity_episode"],
    ["smart-reminder", "recipient_user, recipient_preference, source_dispatch", "smart_reminder_dispatch"],
  ] as const)("locks %s sources and refreshes the proof clock after waiting", async (kind, aliases, source) => {
    const fresh = new Date("2026-10-21T00:00:01Z");
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      void values;
      return { rows: text.startsWith("select user_id") ? [{ user_id: "recipient" }]
        : text.includes("statement_timestamp") ? [{ mail_source_now: fresh }]
          : [{ locked: true }] };
    });
    const client = { query };
    mark(client);
    const authority: RevocableSourceAuthorityQuery = {
      kind, text: `select 1 where original_predicate for share of ${aliases}`,
      values: ["outbox", "source", new Date("2026-10-21T00:00:00Z")],
    };
    const locked = await lockMailWorkerRevocableSources(client, "recipient", authority);
    expect(locked?.text).toContain("original_predicate");
    expect(locked?.text).not.toContain("for share");
    expect(locked?.values[2]).toBe(fresh);
    expect(query).toHaveBeenCalledWith("select public.mail_worker_lock_source_v1($1,$2,$3) as locked",
      [source, "source", "share"]);
    expect(query.mock.calls.at(-1)?.[0]).toContain("statement_timestamp");
    if (kind === "smart-reminder") {
      expect(query).toHaveBeenCalledWith(expect.any(String), ["notification_preference", "recipient", "share"]);
    }
  });
});
