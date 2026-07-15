import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { POST as rawAuthPost } from "@/app/api/auth/[...all]/route";
import { auth } from "@/lib/auth";
import { db, pool } from "@/lib/db/client";
import {
  account,
  auditEvent,
  session,
  twoFactor,
  user,
} from "@/lib/db/schema";

const USER_ID = "auth-management-active-user";
const PASSWORD = "integration-auth-management-password-123!";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (
    process.env.INTEGRATION_TEST !== "1" ||
    !/\/learncoding_integration(?:\?|$)/.test(connectionString)
  ) {
    throw new Error(
      "Auth-management integration tests require the disposable learncoding_integration database.",
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

async function seedAuthenticatedActiveAccount() {
  await db.insert(user).values({
    id: USER_ID,
    name: "Auth Management Learner",
    email: "auth-management@integration.invalid",
    emailVerified: true,
    role: "learner",
    status: "active",
    twoFactorEnabled: false,
  });
  await db.insert(account).values({
    id: "auth-management-credential-account",
    accountId: USER_ID,
    providerId: "credential",
    userId: USER_ID,
    password: await hashPassword(PASSWORD),
  });
  const signIn = await auth.api.signInEmail({
    asResponse: true,
    headers: new Headers({ "user-agent": "Auth management integration browser" }),
    body: {
      email: "auth-management@integration.invalid",
      password: PASSWORD,
      rememberMe: true,
    },
  });
  expect(signIn.ok).toBe(true);
  const cookie = (signIn.headers.get("set-cookie") ?? "")
    .match(/learncoding\.session_token=[^;,\s]+/)?.[0];
  expect(cookie).toBeTruthy();

  await db
    .update(user)
    .set({ twoFactorEnabled: true })
    .where(eq(user.id, USER_ID));
  await db.insert(twoFactor).values({
    id: "auth-management-factor",
    userId: USER_ID,
    secret: "encrypted-factor-canary",
    backupCodes: "encrypted-backup-code-canary",
    verified: true,
  });
  await db
    .update(session)
    .set({ mfaVerifiedAt: new Date() })
    .where(eq(session.userId, USER_ID));

  const durableSession = await auth.api.getSession({
    headers: new Headers({ cookie: cookie! }),
    query: { disableCookieCache: true, disableRefresh: false },
  });
  expect(durableSession?.user.id).toBe(USER_ID);
  expect(durableSession?.user.twoFactorEnabled).toBe(true);
  return cookie!;
}

async function securitySnapshot() {
  const [users, accounts, factors, sessions, audits] = await Promise.all([
    db.select().from(user).where(eq(user.id, USER_ID)),
    db.select().from(account).where(eq(account.userId, USER_ID)),
    db.select().from(twoFactor).where(eq(twoFactor.userId, USER_ID)),
    db.select().from(session).where(eq(session.userId, USER_ID)),
    db.select().from(auditEvent),
  ]);
  return JSON.parse(JSON.stringify({ users, accounts, factors, sessions, audits }));
}

function request(path: string, cookie: string, body: unknown = {}) {
  return new NextRequest(`https://learn.test/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

beforeEach(truncateApplicationTables);
afterAll(async () => pool.end());

describe("PostgreSQL-backed raw auth management boundary", () => {
  it("denies active factor/account mutation without changing security authority", async () => {
    const cookie = await seedAuthenticatedActiveAccount();
    const before = await securitySnapshot();
    const attempts = [
      ["/two-factor/enable", {}],
      ["/two-factor/disable", {}],
      ["/two-factor/get-totp-uri", {}],
      ["/two-factor/generate-backup-codes", {}],
      ["/unlink-account", { providerId: "credential" }],
    ] as const;

    for (const [path, body] of attempts) {
      const response = await rawAuthPost(request(path, cookie, body));
      expect(response.status, path).toBe(403);
      expect(response.headers.get("cache-control"), path).toBe("private, no-store");
      expect(JSON.stringify(await response.json()), path).not.toMatch(
        /otpauth|encrypted-factor-canary|encrypted-backup-code-canary/i,
      );
    }

    expect(await securitySnapshot()).toEqual(before);
  });
});
