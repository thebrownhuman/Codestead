import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockedAuthorization = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/http/authz", () => ({
  requireAdmin: vi.fn(async () => mockedAuthorization.current),
}));

import { POST as createAccessRequest } from "@/app/api/access-requests/route";
import { POST as approveAccessRequest } from "@/app/api/admin/access-requests/[id]/approve/route";
import { POST as rejectAccessRequest } from "@/app/api/admin/access-requests/[id]/reject/route";
import { POST as activateInvitation } from "@/app/api/invitations/activate/route";
import { POST as decideRevocation } from "@/app/api/admin/session-revocation-requests/[id]/decision/route";
import { auth } from "@/lib/auth";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { db, pool } from "@/lib/db/client";
import {
  accessRequest,
  account,
  auditEvent,
  authSessionHistory,
  emailOutbox,
  invitation,
  lostDeviceProof,
  notification,
  session,
  sessionRevocationRequest,
  user,
} from "@/lib/db/schema";
import {
  deriveLostDeviceProof,
  issueLostDeviceProof,
  LOST_DEVICE_PROOF_TTL_MS,
  materializeLostDeviceProofVariables,
  verifyLostDeviceProof,
} from "@/lib/security/lost-device-recovery";
import { and, eq } from "drizzle-orm";

const ADMIN_ID = "auth-recovery-admin";
const ADMIN_SESSION_ID = "auth-recovery-admin-session";
const LEARNER_A = "auth-recovery-learner-a";
const LEARNER_A_SESSION = "auth-recovery-session-a";
const LEARNER_B = "auth-recovery-learner-b";
const LEARNER_B_SESSION = "auth-recovery-session-b";
const LEARNER_A_EMAIL = "auth-recovery-a@integration.invalid";
const SESSION_TOKEN_CANARY = "AUTH_SESSION_TOKEN_CANARY_DO_NOT_COPY";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (
    process.env.INTEGRATION_TEST !== "1" ||
    !/\/learncoding_integration(?:\?|$)/.test(connectionString)
  ) {
    throw new Error(
      "Auth recovery integration tests require the disposable learncoding_integration database.",
    );
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const tables = await pool.query<{ table_name: string }>(`
    select table_name
      from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  const names = tables.rows
    .map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`)
    .join(",");
  if (names) await pool.query(`truncate table ${names} restart identity cascade`);
}

async function seedSecurityActors(now = new Date()) {
  await db.insert(user).values([
    {
      id: ADMIN_ID,
      name: "Recovery Administrator",
      email: "auth-recovery-admin@integration.invalid",
      emailVerified: true,
      role: "admin",
      status: "active",
      twoFactorEnabled: true,
    },
    {
      id: LEARNER_A,
      name: "Recovery Learner A",
      email: LEARNER_A_EMAIL,
      emailVerified: true,
      role: "learner",
      status: "active",
      twoFactorEnabled: true,
    },
    {
      id: LEARNER_B,
      name: "Recovery Learner B",
      email: "auth-recovery-b@integration.invalid",
      emailVerified: true,
      role: "learner",
      status: "active",
      twoFactorEnabled: true,
    },
  ]);
  await db.insert(session).values([
    {
      id: ADMIN_SESSION_ID,
      userId: ADMIN_ID,
      token: "auth-recovery-admin-token",
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      mfaVerifiedAt: now,
    },
    {
      id: LEARNER_A_SESSION,
      userId: LEARNER_A,
      token: SESSION_TOKEN_CANARY,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      deviceLabel: "Lost integration browser",
    },
    {
      id: LEARNER_B_SESSION,
      userId: LEARNER_B,
      token: "unrelated-owner-session-token",
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      deviceLabel: "Unrelated integration browser",
    },
  ]);
  mockedAuthorization.current = {
    session: {
      user: { id: ADMIN_ID, name: "Recovery Administrator", role: "admin" },
      session: { id: ADMIN_SESSION_ID },
    },
    account: { status: "active", role: "admin", twoFactorEnabled: true },
    response: null,
  };
}

function jsonPost(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await truncateApplicationTables();
  mockedAuthorization.current = null;
});

afterAll(async () => {
  await pool.end();
});

describe("out-of-band lost-device ceremony", () => {
  it("deduplicates concurrent issuance and stores no plaintext proof or proof-bearing URL", async () => {
    const now = new Date();
    await seedSecurityActors(now);
    const issued = await Promise.all(
      Array.from({ length: 12 }, () => issueLostDeviceProof(LEARNER_A_EMAIL, now)),
    );
    const ids = new Set(issued.map((item) => item?.requestId));
    expect(ids.size).toBe(1);
    const requestId = issued[0]!.requestId;
    const rawProof = deriveLostDeviceProof(requestId);

    const proofRows = await db.select().from(lostDeviceProof);
    expect(proofRows).toHaveLength(1);
    expect(proofRows[0]?.proofHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(proofRows)).not.toContain(rawProof);

    const queued = await db
      .select({ variables: emailOutbox.variables, template: emailOutbox.template })
      .from(emailOutbox)
      .where(eq(emailOutbox.template, "lost-device-proof"));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.variables).toEqual({
      name: "Recovery Learner A",
      recoveryRequestId: requestId,
    });
    expect(JSON.stringify(queued)).not.toContain(rawProof);
    expect(JSON.stringify(queued)).not.toContain("/lost-device#proof=");

    const delivery = await materializeLostDeviceProofVariables({
      requestId,
      name: "Recovery Learner A",
      now,
    });
    const deliveryUrl = new URL(delivery!.url);
    expect(deliveryUrl.search).toBe("");
    expect(deliveryUrl.hash).toContain(rawProof);
    expect(await issueLostDeviceProof("unknown@integration.invalid", now)).toBeNull();
    expect(await db.select().from(lostDeviceProof)).toHaveLength(1);
  });

  it("allows exactly one proof consumer, binds the request owner/session, and rejects replay", async () => {
    const now = new Date();
    await seedSecurityActors(now);
    const issued = await issueLostDeviceProof(LEARNER_A_EMAIL, now);
    const rawProof = deriveLostDeviceProof(issued!.requestId);
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        verifyLostDeviceProof({
          rawProof,
          reason: "The only approved laptop was stolen during travel.",
          now: new Date(now.getTime() + 1_000),
        }),
      ),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await verifyLostDeviceProof({
      rawProof,
      reason: "A replay must never create another review item.",
      now: new Date(now.getTime() + 2_000),
    })).toBeNull();

    const requests = await db.select().from(sessionRevocationRequest);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      userId: LEARNER_A,
      sessionId: LEARNER_A_SESSION,
      requestChannel: "email_proof",
      proofRequestId: issued!.requestId,
      status: "pending",
    });
    expect(requests[0]?.identityVerifiedAt).toBeInstanceOf(Date);
    expect(await db.select().from(notification).where(eq(notification.userId, ADMIN_ID))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(sessionRevocationRequest)
        .where(eq(sessionRevocationRequest.userId, LEARNER_B)),
    ).toHaveLength(0);
    expect(await materializeLostDeviceProofVariables({
      requestId: issued!.requestId,
      name: "Recovery Learner A",
      now: new Date(now.getTime() + 2_000),
    })).toBeNull();
  });

  it("rejects expiry and a corrupted cross-owner session binding without touching either session", async () => {
    const now = new Date();
    await seedSecurityActors(now);
    const expired = await issueLostDeviceProof(LEARNER_A_EMAIL, now);
    expect(await verifyLostDeviceProof({
      rawProof: deriveLostDeviceProof(expired!.requestId),
      reason: "This request arrives after the strict expiry boundary.",
      now: new Date(now.getTime() + LOST_DEVICE_PROOF_TTL_MS),
    })).toBeNull();
    expect(await db.select().from(sessionRevocationRequest)).toHaveLength(0);

    await db
      .update(lostDeviceProof)
      .set({
        sessionId: LEARNER_B_SESSION,
        expiresAt: new Date(now.getTime() + LOST_DEVICE_PROOF_TTL_MS),
      })
      .where(eq(lostDeviceProof.id, expired!.requestId));
    expect(await verifyLostDeviceProof({
      rawProof: deriveLostDeviceProof(expired!.requestId),
      reason: "A proof must not be usable against a different owner's session.",
      now: new Date(now.getTime() + 1_000),
    })).toBeNull();
    expect(await db.select().from(sessionRevocationRequest)).toHaveLength(0);
    expect(await db.select().from(session)).toHaveLength(3);
  });

  it("requires fresh administrator MFA, then approves, revokes, notifies, and archives no secrets", async () => {
    const now = new Date();
    await seedSecurityActors(now);
    const issued = await issueLostDeviceProof(LEARNER_A_EMAIL, now);
    const rawProof = deriveLostDeviceProof(issued!.requestId);
    const verified = await verifyLostDeviceProof({
      rawProof,
      reason: "The learner no longer controls the only approved laptop.",
      now: new Date(now.getTime() + 1_000),
    });
    expect(verified).not.toBeNull();

    await db
      .update(session)
      .set({ mfaVerifiedAt: new Date(now.getTime() - 10 * 60_000) })
      .where(eq(session.id, ADMIN_SESSION_ID));
    const stale = await decideRevocation(
      jsonPost(
        `http://localhost/api/admin/session-revocation-requests/${verified!.requestId}/decision`,
        {
          decision: "approved",
          reason: "Identity was confirmed through the documented callback procedure.",
        },
      ),
      { params: Promise.resolve({ id: verified!.requestId }) },
    );
    expect(stale.status).toBe(403);
    expect(
      await db
        .select()
        .from(sessionRevocationRequest)
        .where(eq(sessionRevocationRequest.status, "pending")),
    ).toHaveLength(1);
    expect(
      await db.select().from(session).where(eq(session.id, LEARNER_A_SESSION)),
    ).toHaveLength(1);

    await db
      .update(session)
      .set({ mfaVerifiedAt: new Date() })
      .where(eq(session.id, ADMIN_SESSION_ID));
    const approved = await decideRevocation(
      jsonPost(
        `http://localhost/api/admin/session-revocation-requests/${verified!.requestId}/decision`,
        {
          decision: "approved",
          reason: "Identity was confirmed through the documented callback procedure.",
        },
      ),
      { params: Promise.resolve({ id: verified!.requestId }) },
    );
    expect(approved.status).toBe(200);
    expect(
      await db.select().from(session).where(eq(session.id, LEARNER_A_SESSION)),
    ).toHaveLength(0);
    expect(
      await db.select().from(session).where(eq(session.id, LEARNER_B_SESSION)),
    ).toHaveLength(1);
    const [decision] = await db
      .select({
        status: sessionRevocationRequest.status,
        decisionReason: sessionRevocationRequest.decisionReason,
      })
      .from(sessionRevocationRequest)
      .where(eq(sessionRevocationRequest.id, verified!.requestId));
    expect(decision).toEqual({
      status: "approved",
      decisionReason: "Identity was confirmed through the documented callback procedure.",
    });

    const replay = await decideRevocation(
      jsonPost(
        `http://localhost/api/admin/session-revocation-requests/${verified!.requestId}/decision`,
        {
          decision: "approved",
          reason: "Identity was confirmed through the documented callback procedure.",
        },
      ),
      { params: Promise.resolve({ id: verified!.requestId }) },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, decision: "approved", replayed: true });
    expect(
      await db
        .select()
        .from(authSessionHistory)
        .where(eq(authSessionHistory.originalSessionId, LEARNER_A_SESSION)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(notification)
        .where(and(eq(notification.userId, LEARNER_A), eq(notification.type, "session-revocation-updated"))),
    ).toHaveLength(1);

    const oppositeDecision = await decideRevocation(
      jsonPost(
        `http://localhost/api/admin/session-revocation-requests/${verified!.requestId}/decision`,
        {
          decision: "rejected",
          reason: "A conflicting retry must not replace the committed approval.",
        },
      ),
      { params: Promise.resolve({ id: verified!.requestId }) },
    );
    expect(oppositeDecision.status).toBe(409);

    const [history] = await db
      .select()
      .from(authSessionHistory)
      .where(eq(authSessionHistory.originalSessionId, LEARNER_A_SESSION));
    expect(history?.endReason).toBe("lost_device_approved");
    const securityRows = JSON.stringify({
      history,
      request: await db
        .select()
        .from(sessionRevocationRequest)
        .where(eq(sessionRevocationRequest.id, verified!.requestId)),
      audits: await db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.subjectUserId, LEARNER_A)),
      outbox: await db
        .select({ template: emailOutbox.template, variables: emailOutbox.variables })
        .from(emailOutbox),
    });
    expect(securityRows).not.toContain(SESSION_TOKEN_CANARY);
    expect(securityRows).not.toContain(rawProof);
    expect(securityRows).not.toMatch(/"(token|password|secret|backupCodes)"\s*:/i);

    const historyColumns = await pool.query<{ column_name: string }>(`
      select column_name
        from information_schema.columns
       where table_schema = 'public' and table_name = 'auth_session_history'
    `);
    expect(historyColumns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(["token", "password", "secret", "backup_codes"]),
    );
  });

  it("account deletion erases a proof and its still-pending request in the required FK order", async () => {
    const now = new Date();
    await seedSecurityActors(now);
    const issued = await issueLostDeviceProof(LEARNER_A_EMAIL, now);
    const verified = await verifyLostDeviceProof({
      rawProof: deriveLostDeviceProof(issued!.requestId),
      reason: "The only approved laptop is unavailable during account deletion.",
      now: new Date(now.getTime() + 1_000),
    });
    expect(verified).not.toBeNull();
    const previousKey = process.env.DELETION_TOMBSTONE_KEY;
    process.env.DELETION_TOMBSTONE_KEY = "integration-auth-deletion-key-that-is-long-enough";
    try {
      const report = await deleteLearnerAccount({
        actorUserId: ADMIN_ID,
        learnerId: LEARNER_A,
        requestId: "d1000000-0000-4000-8000-000000000001",
        reason: "Erase the learner account and its pending recovery evidence.",
        now: new Date(now.getTime() + 2_000),
        objectStorageRoot: process.cwd(),
      });
      expect(report.deletedRows).toMatchObject({
        sessionRevocationRequests: 1,
        lostDeviceProofs: 1,
        sessionHistory: 0,
      });
      expect(await db.select().from(lostDeviceProof).where(eq(lostDeviceProof.userId, LEARNER_A))).toHaveLength(0);
      expect(await db.select().from(sessionRevocationRequest).where(eq(sessionRevocationRequest.userId, LEARNER_A))).toHaveLength(0);
      expect(await db.select().from(session).where(eq(session.userId, LEARNER_A))).toHaveLength(0);
      const [deleted] = await db.select({ status: user.status }).from(user).where(eq(user.id, LEARNER_A));
      expect(deleted?.status).toBe("deleted");
    } finally {
      if (previousKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
      else process.env.DELETION_TOMBSTONE_KEY = previousKey;
    }
  });

  it("rolls the session archive, deletion, request decision, and success audit back together", async () => {
    const now = new Date();
    await seedSecurityActors(now);
    const issued = await issueLostDeviceProof(LEARNER_A_EMAIL, now);
    const verified = await verifyLostDeviceProof({
      rawProof: deriveLostDeviceProof(issued!.requestId),
      reason: "The learner no longer controls the approved browser profile.",
      now: new Date(now.getTime() + 1_000),
    });
    expect(verified).not.toBeNull();

    await pool.query(`
      create function integration_fail_revocation_decision() returns trigger
      language plpgsql as $$
      begin
        if new.status = 'approved' then
          raise exception 'synthetic decision write failure';
        end if;
        return new;
      end;
      $$;
      create trigger integration_fail_revocation_decision_trigger
      before update on session_revocation_request
      for each row execute function integration_fail_revocation_decision();
    `);
    try {
      await expect(decideRevocation(
        jsonPost(
          `http://localhost/api/admin/session-revocation-requests/${verified!.requestId}/decision`,
          {
            decision: "approved",
            reason: "Identity was confirmed before the synthetic database failure.",
          },
        ),
        { params: Promise.resolve({ id: verified!.requestId }) },
      )).rejects.toThrow(/Failed query|synthetic decision write failure/i);
    } finally {
      await pool.query("drop trigger if exists integration_fail_revocation_decision_trigger on session_revocation_request");
      await pool.query("drop function if exists integration_fail_revocation_decision()");
    }

    expect(await db.select().from(session).where(eq(session.id, LEARNER_A_SESSION))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(authSessionHistory)
        .where(eq(authSessionHistory.originalSessionId, LEARNER_A_SESSION)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(sessionRevocationRequest)
        .where(and(
          eq(sessionRevocationRequest.id, verified!.requestId),
          eq(sessionRevocationRequest.status, "pending"),
        )),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(auditEvent)
        .where(and(
          eq(auditEvent.resourceId, verified!.requestId),
          eq(auditEvent.action, "session.revocation_decide"),
          eq(auditEvent.outcome, "success"),
        )),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(notification)
        .where(eq(notification.type, "session-revocation-updated")),
    ).toHaveLength(0);
  });

  it("account deletion erases an approved request, consumed proof, and token-free revoked history without orphans", async () => {
    const now = new Date();
    await seedSecurityActors(now);
    const issued = await issueLostDeviceProof(LEARNER_A_EMAIL, now);
    const verified = await verifyLostDeviceProof({
      rawProof: deriveLostDeviceProof(issued!.requestId),
      reason: "The device is lost and the learner also requested account deletion.",
      now: new Date(now.getTime() + 1_000),
    });
    const approved = await decideRevocation(
      jsonPost(
        `http://localhost/api/admin/session-revocation-requests/${verified!.requestId}/decision`,
        {
          decision: "approved",
          reason: "Identity was confirmed before account deletion was authorized.",
        },
      ),
      { params: Promise.resolve({ id: verified!.requestId }) },
    );
    expect(approved.status).toBe(200);
    expect(await db.select().from(authSessionHistory).where(eq(authSessionHistory.userId, LEARNER_A))).toHaveLength(1);

    const previousKey = process.env.DELETION_TOMBSTONE_KEY;
    process.env.DELETION_TOMBSTONE_KEY = "integration-auth-deletion-key-that-is-long-enough";
    try {
      const report = await deleteLearnerAccount({
        actorUserId: ADMIN_ID,
        learnerId: LEARNER_A,
        requestId: "d1000000-0000-4000-8000-000000000002",
        reason: "Erase the learner account after approved lost-device recovery.",
        now: new Date(now.getTime() + 2_000),
        objectStorageRoot: process.cwd(),
      });
      expect(report.deletedRows).toMatchObject({
        sessionRevocationRequests: 1,
        lostDeviceProofs: 1,
        sessionHistory: 1,
      });
      expect(await db.select().from(lostDeviceProof).where(eq(lostDeviceProof.userId, LEARNER_A))).toHaveLength(0);
      expect(await db.select().from(sessionRevocationRequest).where(eq(sessionRevocationRequest.userId, LEARNER_A))).toHaveLength(0);
      expect(await db.select().from(authSessionHistory).where(eq(authSessionHistory.userId, LEARNER_A))).toHaveLength(0);
      const orphans = await pool.query<{ count: string }>(`
        select count(*)::text as count
          from session_revocation_request request
          left join lost_device_proof proof on proof.id = request.proof_request_id
         where request.proof_request_id is not null and proof.id is null
      `);
      expect(orphans.rows[0]?.count).toBe("0");
    } finally {
      if (previousKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
      else process.env.DELETION_TOMBSTONE_KEY = previousKey;
    }
  });
});

describe("database-backed access, activation, rejection, and password recovery", () => {
  it("persists one neutral pending request, approves and activates it once, and blocks direct signup", async () => {
    const now = new Date();
    await seedSecurityActors(now);
    const email = "approved-activation@integration.invalid";
    const accessBody = {
      name: "Approved Activation",
      email,
      reason: "Private pilot integration coverage",
      adultConfirmed: true,
    };
    const first = await createAccessRequest(
      jsonPost("http://localhost/api/access-requests", accessBody),
    );
    const replay = await createAccessRequest(
      jsonPost("http://localhost/api/access-requests", accessBody),
    );
    expect(first.status).toBe(202);
    expect(await first.text()).toBe(await replay.text());
    const [pending] = await db
      .select()
      .from(accessRequest)
      .where(eq(accessRequest.email, email));
    expect(pending?.status).toBe("pending");
    expect(pending?.adultConfirmedAt).toBeInstanceOf(Date);
    await db
      .update(accessRequest)
      .set({ emailVerifiedAt: now })
      .where(eq(accessRequest.id, pending!.id));

    await expect(
      auth.api.signUpEmail({
        body: {
          name: "Bypass Attempt",
          email,
          password: "bypass-password-must-never-work-123!",
        },
      }),
    ).rejects.toBeDefined();
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0);

    const approved = await approveAccessRequest(
      jsonPost(`http://localhost/api/admin/access-requests/${pending!.id}/approve`, {
        reason: "Approved after a separate private-pilot review.",
      }),
      { params: Promise.resolve({ id: pending!.id }) },
    );
    expect(approved.status).toBe(200);
    expect(await approved.text()).not.toMatch(/token|password/i);
    const [invite] = await db
      .select()
      .from(invitation)
      .where(eq(invitation.accessRequestId, pending!.id));
    expect(invite?.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const [mail] = await db
      .select({ variables: emailOutbox.variables })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.template, "invitation"), eq(emailOutbox.toEmail, email)));
    const activationUrl = new URL(mail!.variables.url);
    const rawToken = activationUrl.searchParams.get("token");
    expect(rawToken).toBeTruthy();
    expect(invite?.tokenHash).not.toContain(rawToken!);
    expect(JSON.stringify(mail)).not.toMatch(/generated.?password/i);

    const password = "activation-password-never-emailed-123!";
    const activated = await activateInvitation(
      jsonPost("http://localhost/api/invitations/activate", {
        token: rawToken,
        name: "Approved Activation",
        password,
      }),
    );
    expect(activated.status).toBe(201);
    expect(JSON.stringify(await db.select().from(emailOutbox))).not.toContain(password);
    const activationReplay = await activateInvitation(
      jsonPost("http://localhost/api/invitations/activate", {
        token: rawToken,
        name: "Replay Attempt",
        password: "different-password-never-emailed-456!",
      }),
    );
    expect(activationReplay.status).toBe(404);
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(1);
  });

  it("rejects a pending request with an audited reason and creates no account or invitation", async () => {
    const now = new Date();
    await seedSecurityActors(now);
    const email = "rejected-access@integration.invalid";
    await createAccessRequest(
      jsonPost("http://localhost/api/access-requests", {
        name: "Rejected Access",
        email,
        reason: "Request rejection integration coverage",
        adultConfirmed: true,
      }),
    );
    const [pending] = await db
      .select()
      .from(accessRequest)
      .where(eq(accessRequest.email, email));
    const rejected = await rejectAccessRequest(
      jsonPost(`http://localhost/api/admin/access-requests/${pending!.id}/reject`, {
        reason: "The private pilot has no remaining seat for this request.",
      }),
      { params: Promise.resolve({ id: pending!.id }) },
    );
    expect(rejected.status).toBe(200);
    const [record] = await db
      .select()
      .from(accessRequest)
      .where(eq(accessRequest.id, pending!.id));
    expect(record).toMatchObject({
      status: "rejected",
      decidedBy: ADMIN_ID,
      decisionReason: "The private pilot has no remaining seat for this request.",
    });
    expect(
      await db.select().from(invitation).where(eq(invitation.accessRequestId, pending!.id)),
    ).toHaveLength(0);
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.resourceId, pending!.id)),
    ).toEqual([expect.objectContaining({ action: "access_request.reject", outcome: "success" })]);
  });

  it("uses a one-time password-reset token, revokes the session, and archives no password/token", async () => {
    const now = new Date();
    await seedSecurityActors(now);
    const password = "old-local-password-never-emailed-123!";
    const newPassword = "new-local-password-never-emailed-456!";
    const resetUserId = "auth-reset-learner";
    const resetSessionId = "auth-reset-active-session";
    const email = "password-reset@integration.invalid";
    await db.insert(user).values({
      id: resetUserId,
      name: "Password Reset Learner",
      email,
      emailVerified: true,
      status: "active",
      role: "learner",
    });
    const { hashPassword } = await import("better-auth/crypto");
    await db.insert(account).values({
      id: "auth-reset-credential-account",
      accountId: resetUserId,
      providerId: "credential",
      userId: resetUserId,
      password: await hashPassword(password),
    });
    await db.insert(session).values({
      id: resetSessionId,
      userId: resetUserId,
      token: "PASSWORD_RESET_SESSION_TOKEN_CANARY",
      expiresAt: new Date(now.getTime() + 60 * 60_000),
    });

    const known = await auth.api.requestPasswordReset({
      body: { email, redirectTo: "http://localhost:3000/reset-password" },
    });
    const unknown = await auth.api.requestPasswordReset({
      body: {
        email: "unknown-reset@integration.invalid",
        redirectTo: "http://localhost:3000/reset-password",
      },
    });
    expect(known).toEqual(unknown);
    const [resetMail] = await db
      .select({ variables: emailOutbox.variables })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.template, "reset-password"), eq(emailOutbox.toEmail, email)));
    const resetUrl = new URL(resetMail!.variables.url);
    const resetToken =
      resetUrl.searchParams.get("token") ??
      resetUrl.pathname.split("/").filter(Boolean).at(-1)!;
    expect(resetToken).toBeTruthy();
    expect(JSON.stringify(resetMail)).not.toContain(password);
    expect(JSON.stringify(resetMail)).not.toContain(newPassword);

    await expect(
      auth.api.resetPassword({ body: { newPassword, token: resetToken } }),
    ).resolves.toEqual({ status: true });
    expect(await db.select().from(session).where(eq(session.userId, resetUserId))).toHaveLength(0);
    const [history] = await db
      .select()
      .from(authSessionHistory)
      .where(eq(authSessionHistory.originalSessionId, resetSessionId));
    expect(history?.endReason).toBe("password_reset");
    expect(JSON.stringify(history)).not.toContain("PASSWORD_RESET_SESSION_TOKEN_CANARY");
    expect(JSON.stringify(history)).not.toContain(password);
    expect(JSON.stringify(history)).not.toContain(newPassword);
    await expect(
      auth.api.resetPassword({ body: { newPassword: `${newPassword}x`, token: resetToken } }),
    ).rejects.toBeDefined();
  });
});
