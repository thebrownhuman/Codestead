import { createOTP } from "@better-auth/utils/otp";
import { hashPassword, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { POST as takeoverPost } from "@/app/api/security/session-takeover/route";

import { auth } from "@/lib/auth";
import { db, pool } from "@/lib/db/client";
import { account, auditEvent, session, twoFactor, user } from "@/lib/db/schema";
import { resetDisposableIntegrationDatabase } from "./support/reset-disposable-database";

const USER_ID = "trusted-device-learner";
const EMAIL = "trusted-device@integration.invalid";
const PASSWORD = "integration-trusted-device-password-123!";
const TOTP_SECRET = "integration-trusted-device-totp-secret";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (
    process.env.INTEGRATION_TEST !== "1" ||
    !/\/learncoding_integration(?:\?|$)/.test(connectionString)
  ) {
    throw new Error("Trusted-device integration tests require the disposable learncoding_integration database.");
  }
}

/** Minimal per-browser cookie jar. */
class Browser {
  private readonly cookies = new Map<string, string>();
  constructor(readonly userAgent: string) {}

  headers(extra: Record<string, string> = {}) {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    return new Headers({ "user-agent": this.userAgent, ...(cookie ? { cookie } : {}), ...extra });
  }

  absorb(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const separator = pair!.indexOf("=");
      const name = pair!.slice(0, separator).trim();
      const value = pair!.slice(separator + 1).trim();
      const expired = !value || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()));
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  has(fragment: string) {
    return [...this.cookies.keys()].some((name) => name.includes(fragment));
  }
}

async function code() {
  return createOTP(TOTP_SECRET, { period: 30, digits: 6 }).totp();
}

async function activeSessions() {
  return db
    .select({ id: session.id, userAgent: session.userAgent, mfaVerifiedAt: session.mfaVerifiedAt })
    .from(session)
    .where(and(eq(session.userId, USER_ID), isNull(session.revokedAt), gt(session.expiresAt, new Date())));
}

async function signIn(browser: Browser) {
  const response = browser.absorb(await auth.api.signInEmail({
    asResponse: true,
    headers: browser.headers(),
    body: { email: EMAIL, password: PASSWORD, rememberMe: true },
  }));
  return { response, body: await response.clone().json().catch(() => null) as Record<string, unknown> | null };
}

const ORIGIN = process.env.APP_URL ?? "http://localhost:3000";

async function takeover(browser: Browser, input: { email?: string; password?: string; code?: string; origin?: string | null } = {}) {
  const headers = new Headers({ "content-type": "application/json", "user-agent": browser.userAgent, "x-forwarded-for": "203.0.113.7" });
  if (input.origin !== null) headers.set("origin", input.origin ?? ORIGIN);
  const response = await takeoverPost(new NextRequest(`${ORIGIN}/api/security/session-takeover`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: input.email ?? EMAIL, password: input.password ?? PASSWORD, code: input.code ?? await code() }),
  }));
  return browser.absorb(response);
}

async function wrongCode() {
  const current = await code();
  return String((Number(current) + 1) % 1_000_000).padStart(6, "0");
}

async function verifyTotp(browser: Browser) {
  return browser.absorb(await auth.api.verifyTOTP({
    asResponse: true,
    headers: browser.headers(),
    body: { code: await code(), trustDevice: true },
  }));
}

async function sessionOf(browser: Browser) {
  return auth.api.getSession({ headers: browser.headers(), query: { disableCookieCache: true } });
}

beforeEach(async () => {
  assertDisposableDatabase();
  await resetDisposableIntegrationDatabase(pool);
  const context = await auth.$context;
  await db.insert(user).values({
    id: USER_ID, name: "Trusted Device Learner", email: EMAIL, emailVerified: true,
    role: "learner", status: "active", twoFactorEnabled: true,
  });
  await db.insert(account).values({
    id: "trusted-device-credential", accountId: USER_ID, providerId: "credential", userId: USER_ID,
    password: await hashPassword(PASSWORD),
  });
  await db.insert(twoFactor).values({
    id: "trusted-device-factor", userId: USER_ID, verified: true,
    secret: await symmetricEncrypt({ key: context.secretConfig, data: TOTP_SECRET }),
    backupCodes: await symmetricEncrypt({ key: context.secretConfig, data: JSON.stringify(["unused-backup-code"]) }),
  });
});

afterAll(async () => pool.end());

describe("PingID-style trusted device with one active device (real Better Auth sign-in)", () => {
  it("never leaves a usable provisional session before TOTP, then trusts the same browser for re-sign-in", async () => {
    const laptop = new Browser("Integration laptop");

    const first = await signIn(laptop);
    expect(first.body?.twoFactorRedirect).toBe(true);
    expect(await activeSessions()).toEqual([]);
    expect(await sessionOf(laptop)).toBeNull();

    expect((await verifyTotp(laptop)).ok).toBe(true);
    expect(laptop.has("trust_device")).toBe(true);
    const [afterTotp] = await activeSessions();
    expect(afterTotp?.mfaVerifiedAt).toBeInstanceOf(Date);

    laptop.absorb(await auth.api.signOut({ asResponse: true, headers: laptop.headers() }));
    expect(await activeSessions()).toEqual([]);

    const again = await signIn(laptop);
    expect(again.body?.twoFactorRedirect).toBeUndefined();
    const sessions = await activeSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.mfaVerifiedAt).toBeInstanceOf(Date);
    expect((await sessionOf(laptop))?.user.id).toBe(USER_ID);
  });

  it("blocks a second device at password sign-in and takes over only with the right password and a fresh single-use code", async () => {
    const laptop = new Browser("Integration laptop");
    await signIn(laptop);
    expect((await verifyTotp(laptop)).ok).toBe(true);
    const [laptopSession] = await activeSessions();

    const phone = new Browser("Integration phone");
    const blocked = await signIn(phone);
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: "ACTIVE_SESSION_ELSEWHERE" });
    expect(await sessionOf(phone)).toBeNull();
    expect((await activeSessions()).map((row) => row.id)).toEqual([laptopSession!.id]);

    const badCode = await takeover(phone, { code: await wrongCode() });
    expect(badCode.status).toBe(401);
    const badPassword = await takeover(phone, { password: "not-the-password-123!" });
    expect(badPassword.status).toBe(401);
    expect(await badPassword.json()).toEqual(await badCode.clone().json());
    expect((await activeSessions()).map((row) => row.id)).toEqual([laptopSession!.id]);

    const freshCode = await code();
    const ok = await takeover(phone, { code: freshCode });
    expect(ok.status).toBe(200);
    const afterTakeover = await activeSessions();
    expect(afterTakeover).toHaveLength(1);
    expect(afterTakeover[0]!.id).not.toBe(laptopSession!.id);
    expect(afterTakeover[0]!.mfaVerifiedAt).toBeInstanceOf(Date);
    expect(await sessionOf(laptop)).toBeNull();
    expect((await sessionOf(phone))?.user.id).toBe(USER_ID);

    const attacker = new Browser("Integration attacker");
    const replay = await takeover(attacker, { code: freshCode });
    expect(replay.status).toBe(401);
    expect((await sessionOf(phone))?.user.id).toBe(USER_ID);

    const outcomes = await db.select({ outcome: auditEvent.outcome, reason: auditEvent.reason })
      .from(auditEvent).where(eq(auditEvent.action, "session.takeover"));
    expect(outcomes.filter((row) => row.outcome === "success")).toHaveLength(1);
    expect(outcomes.filter((row) => row.outcome === "failure").map((row) => row.reason).sort())
      .toEqual(["invalid_code", "invalid_code", "invalid_credentials"]);
  });

  it("does not let a trusted browser skip the code while another device is active", async () => {
    const laptop = new Browser("Integration laptop");
    await signIn(laptop);
    await verifyTotp(laptop);
    laptop.absorb(await auth.api.signOut({ asResponse: true, headers: laptop.headers() }));

    const phone = new Browser("Integration phone");
    await signIn(phone);
    expect((await verifyTotp(phone)).ok).toBe(true);
    const [phoneSession] = await activeSessions();

    const trustedReturn = await signIn(laptop);
    expect(trustedReturn.response.status).toBe(409);
    expect((await activeSessions()).map((row) => row.id)).toEqual([phoneSession!.id]);
    expect(await sessionOf(laptop)).toBeNull();
  });

  it("gives unknown accounts the same answer and rejects cross-origin takeover requests", async () => {
    const stranger = new Browser("Integration stranger");
    const unknown = await takeover(stranger, { email: "nobody@integration.invalid" });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: "Email, password, or authenticator code is incorrect." });
    expect((await takeover(stranger, { origin: "https://evil.example" })).status).toBe(403);
    expect((await takeover(stranger, { origin: null })).status).toBe(403);
  });
});
