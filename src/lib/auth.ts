import { randomUUID } from "node:crypto";

import { and, eq, gt, sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { GenericEndpointContext } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin, twoFactor } from "better-auth/plugins";

import { db, pool } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { verificationEmailSourceEventId } from "@/lib/notifications/idempotency-authority";
import { enqueueEmail } from "@/lib/notifications/outbox";
import {
  createResetPasswordSourceVariables,
  loadResetPasswordVerificationSource,
  requireRevocableSourceVariables,
  RevocableSourceAuthorityError,
  storedResetPasswordIdentifier,
} from "@/lib/notifications/revocable-source-authority";
import {
  archiveDeletedSession,
  archiveExpiredSessions,
  boundedUserAgent,
  describeUserAgent,
} from "@/lib/session-controls";
import {
  currentActivationAuthorization,
  currentBootstrapAuthorization,
} from "@/lib/security/activation-context";
import {
  restrictedAdminRole,
  restrictedLearnerRole,
} from "@/lib/security/better-auth-admin-policy";
import { isGoogleOAuthConfigured } from "@/lib/security/oauth-provider-config";
import {
  activeSessionElsewhereError,
  consumeInternalTotpGrant,
  INTERNAL_TOTP_GRANT_HEADER,
  isTotpCodeUsed,
  consumeSessionTakeoverBudget,
  hasActiveSession,
  TRUSTED_DEVICE_MAX_AGE_SECONDS,
  recordSessionTakeoverFailure,
  revokeSessionsForTakeover,
  SECOND_FACTOR_PATHS,
  sessionTakeoverRateLimitedError,
  wantsSessionTakeover,
} from "@/lib/security/session-takeover";
import { PERSISTENT_SESSION_LIFETIME } from "@/lib/security/session-lifetime";
import { breachedPasswordPlugin } from "@/lib/security/breached-passwords";
import { atomicAuthRateLimitPlugin } from "@/lib/security/auth-rate-limit";
import {
  clearTrustedDevices,
  mayResetPassword,
  recordPasswordChanged,
} from "@/lib/security/password-security-events";
import { holdResetRequestFloor, markResetRequestStarted } from "@/lib/security/reset-request-timing";

/** Account behind a password-verified sign-in that is waiting for its second factor. */
async function pendingTwoFactorUserId(ctx: GenericEndpointContext) {
  const cookie = ctx.context.createAuthCookie("two_factor");
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return null;
  const pending = await ctx.context.internalAdapter.findVerificationValue(identifier);
  if (!pending || pending.expiresAt <= new Date()) return null;
  return pending.value;
}

const isBuild = process.env.NEXT_PHASE === "phase-production-build";
const databaseRateLimitsRequired = process.env.NODE_ENV === "production" || Boolean(process.env.DATABASE_URL?.trim());
const authSecret =
  process.env.BETTER_AUTH_SECRET ??
  (isBuild || process.env.NODE_ENV === "development"
    ? "build-only-secret-that-must-never-serve-production"
    : undefined);

if (!authSecret) {
  throw new Error("BETTER_AUTH_SECRET is required outside development/build.");
}

const googleConfigured = isGoogleOAuthConfigured();

export const auth = betterAuth({
  appName: process.env.APP_NAME ?? "Codestead",
  baseURL: process.env.APP_URL ?? "http://localhost:3000",
  secret: authSecret,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    usePlural: false,
  }),
  trustedOrigins: [process.env.APP_URL ?? "http://localhost:3000"],
  account: {
    accountLinking: {
      disableImplicitLinking: true,
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user: authUser, url, token }) => {
      // Inactive, banned and Google-only accounts get the same neutral
      // response but no link; the unsent token is withdrawn immediately.
      if (!(await mayResetPassword(authUser.id))) {
        await pool.query("delete from public.verification where identifier = $1 and value = $2", [
          storedResetPasswordIdentifier(token),
          authUser.id,
        ]);
        return;
      }
      const verificationId = await loadResetPasswordVerificationSource(pool, {
        token,
        userId: authUser.id,
      });
      if (!verificationId) {
        throw new RevocableSourceAuthorityError("RESET_PASSWORD_SOURCE_UNAVAILABLE");
      }
      const variables = requireRevocableSourceVariables(
        createResetPasswordSourceVariables({
          applicationUrl: process.env.APP_URL ?? "http://localhost:3000",
          name: authUser.name,
          token,
          url,
          verificationId,
        }),
      );
      await enqueueEmail({
        to: authUser.email,
        userId: authUser.id,
        template: "reset-password",
        variables,
        idempotencySeed: `reset-password:${verificationId}`,
      });
    },
    // Runs after the new hash is stored and before sessions are revoked, so
    // it must never throw: failures are logged inside recordPasswordChanged.
    onPasswordReset: async ({ user: resetUser }) => {
      try {
        await clearTrustedDevices(resetUser.id);
      } catch {
        console.error("password_reset_trusted_device_clear_failed");
      }
      await recordPasswordChanged({ userId: resetUser.id, kind: "reset" });
    },
  },
  verification: {
    // Reset tokens are bearer credentials; keep only their SHA-256 at rest.
    // Other identifiers (two-factor, trust-device) keep Better Auth's default.
    storeIdentifier: { default: "plain", overrides: { "reset-password:": "hashed" } },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user: authUser, url, token }) => {
      await enqueueEmail({
        to: authUser.email,
        userId: authUser.id,
        template: "verify-email",
        variables: { name: authUser.name, url },
        idempotencySeed: verificationEmailSourceEventId(token),
      });
    },
  },
  socialProviders: googleConfigured
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          prompt: "select_account",
        },
      }
    : {},
  user: {
    additionalFields: {
      status: {
        type: "string",
        defaultValue: "pending",
        input: false,
      },
      timezone: {
        type: "string",
        defaultValue: "Asia/Kolkata",
        required: true,
      },
      mustChangePassword: {
        type: "boolean",
        defaultValue: true,
        input: false,
      },
    },
  },
  session: {
    ...PERSISTENT_SESSION_LIFETIME,
    cookieCache: {
      // Twenty pilot users do not justify a stale authorization window.
      // Durable session deletion must take effect on the next request across
      // both custom routes and Better Auth's own endpoints.
      enabled: false,
    },
    additionalFields: {
      deviceHash: { type: "string", required: false, input: false },
      deviceLabel: { type: "string", required: false, input: false },
      mfaVerifiedAt: { type: "date", required: false, input: false },
      revokedAt: { type: "date", required: false, input: false },
      revocationReason: { type: "string", required: false, input: false },
    },
  },
  rateLimit: {
    enabled: true,
    // Native/plugin defaults remain a secondary process-local guard. The
    // sensitive budgets below use atomic Postgres admission when DB-backed.
    storage: "memory",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": databaseRateLimitsRequired ? false : { window: 60, max: 8 },
      "/sign-up/email": databaseRateLimitsRequired ? false : { window: 60 * 10, max: 3 },
      "/two-factor/verify-totp": databaseRateLimitsRequired ? false : { window: 60, max: 6 },
    },
  },
  advanced: {
    ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    cookiePrefix: "learncoding",
    useSecureCookies: process.env.NODE_ENV === "production" && !isBuild,
    database: { generateId: () => randomUUID() },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/request-password-reset") {
        markResetRequestStarted(ctx.request);
        return;
      }
      if (ctx.path === "/reset-password") {
        // Tokens issued before the eligibility rule (or for an account that
        // changed state since) must not set a password on an ineligible user.
        const token = typeof ctx.body?.token === "string" ? ctx.body.token : "";
        const pending = token ? await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`) : null;
        if (pending && !(await mayResetPassword(pending.value))) {
          throw new APIError("BAD_REQUEST", { code: "INVALID_TOKEN", message: "Invalid token" });
        }
        return;
      }
      if (!SECOND_FACTOR_PATHS.includes(ctx.path)) return;
      const pendingUserId = await pendingTwoFactorUserId(ctx);
      if (!pendingUserId) return;
      const code = typeof ctx.body?.code === "string" ? ctx.body.code : "";
      if (ctx.path === "/two-factor/verify-totp" && code) {
        const internalGrant = consumeInternalTotpGrant(ctx.headers?.get(INTERNAL_TOTP_GRANT_HEADER));
        // A code already spent on a takeover cannot be replayed anywhere else.
        if (!internalGrant && await isTotpCodeUsed(pendingUserId, code)) {
          throw new APIError("UNAUTHORIZED", { code: "INVALID_CODE", message: "Invalid code" });
        }
      }
      if (wantsSessionTakeover(ctx.path, ctx.headers)) {
        if (!(await consumeSessionTakeoverBudget(pendingUserId))) {
          await recordSessionTakeoverFailure(pendingUserId, "rate_limited");
          throw sessionTakeoverRateLimitedError();
        }
        return;
      }
      // Refuse before the challenge or single-use code is consumed, so a
      // blocked learner can still choose to take over with a fresh code.
      await archiveExpiredSessions(pendingUserId);
      if (await hasActiveSession(pendingUserId)) throw activeSessionElsewhereError();
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/request-password-reset") {
        await holdResetRequestFloor(ctx.request);
        return;
      }
      if (ctx.path === "/sign-in/email") {
        // A second device never gets here: session creation is refused while
        // another device is active (session_one_active_user_unique), and the
        // takeover goes through /api/security/session-takeover with a code.
        const created = ctx.context.newSession;
        if (!created?.user.twoFactorEnabled) return;
        // Trusted device (24h): the plugin keeps this session without a new
        // code. Record it as MFA-completed; if the plugin instead issues a
        // challenge it deletes this provisional session and the stamp with it.
        await db
          .update(schema.session)
          .set({ mfaVerifiedAt: new Date() })
          .where(eq(schema.session.id, created.session.id));
        return;
      }
      if (![
        "/two-factor/verify-totp",
        "/two-factor/verify-backup-code",
      ].includes(ctx.path)) return;
      const completed = ctx.context.newSession;
      if (!completed) {
        if (wantsSessionTakeover(ctx.path, ctx.headers)) {
          const pendingUserId = await pendingTwoFactorUserId(ctx);
          if (pendingUserId) await recordSessionTakeoverFailure(pendingUserId, "invalid_code");
        }
        return;
      }
      await db
        .update(schema.session)
        .set({ mfaVerifiedAt: new Date() })
        .where(eq(schema.session.id, completed.session.id));
    }),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (candidate) => {
          const email = candidate.email.toLowerCase();
          const bootstrapAdmin = process.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase();
          if (bootstrapAdmin && email === bootstrapAdmin) {
            return currentBootstrapAuthorization() === email ? undefined : false;
          }

          const activation = currentActivationAuthorization();
          if (!activation || activation.email !== email) return false;
          const claimedAt = new Date(activation.consumedAt);

          const [validInvite] = await db
            .select({ id: schema.invitation.id })
            .from(schema.invitation)
            .where(
              and(
                eq(schema.invitation.id, activation.invitationId),
                sql`lower(${schema.invitation.email}) = ${activation.email}`,
                eq(schema.invitation.consumedAt, claimedAt),
                gt(schema.invitation.expiresAt, claimedAt),
              ),
            )
            .limit(1);

          if (!validInvite) return false;
          return { data: { mustChangePassword: false } };
        },
        after: async (createdUser) => {
          await db.transaction(async (tx) => {
            await tx
              .insert(schema.learnerProfile)
              .values({ userId: createdUser.id })
              .onConflictDoNothing();
          });
        },
      },
    },
    session: {
      create: {
        before: async (candidate, context) => {
          await archiveExpiredSessions(candidate.userId);
          // One active device family. Multiple tabs share the same auth cookie.
          if (!(await hasActiveSession(candidate.userId))) return;
          // Reaching session creation on the takeover path means this request
          // already verified the password challenge and a valid TOTP code.
          if (wantsSessionTakeover(context?.path, context?.headers)) {
            await revokeSessionsForTakeover(candidate.userId);
            return;
          }
          throw activeSessionElsewhereError();
        },
        after: async (createdSession) => {
          try {
            const safeUserAgent = boundedUserAgent(createdSession.userAgent);
            const deviceLabel = describeUserAgent(safeUserAgent);
            const [owner] = await db
              .select({ email: schema.user.email, name: schema.user.name })
              .from(schema.user)
              .where(eq(schema.user.id, createdSession.userId))
              .limit(1);
            await db
              .update(schema.session)
              .set({ deviceLabel, userAgent: safeUserAgent, lastSeenAt: new Date() })
              .where(eq(schema.session.id, createdSession.id));
            if (owner) {
              await Promise.all([
                db.insert(schema.notification).values({
                  userId: createdSession.userId,
                  type: "new-device",
                  title: "New browser profile approved",
                  body: `${deviceLabel} started a new session. Contact the administrator if this was not you.`,
                  actionUrl: "/settings?section=device",
                }),
                enqueueEmail({
                  to: owner.email,
                  userId: createdSession.userId,
                  template: "new-device",
                  variables: {
                    name: owner.name,
                    device: deviceLabel,
                    url: `${process.env.APP_URL ?? "http://localhost:3000"}/settings?section=device`,
                  },
                  idempotencySeed: createdSession.id,
                }),
              ]);
            }
          } catch {
            // Notification infrastructure must not create an invisible active
            // session and then turn a successful sign-in into a lockout.
            console.error("New-device security notification could not be queued.");
          }
        },
      },
      delete: {
        before: async (deletedSession, context) => {
          await archiveDeletedSession({
            id: deletedSession.id,
            userId: deletedSession.userId,
            deviceLabel:
              typeof deletedSession.deviceLabel === "string"
                ? deletedSession.deviceLabel
                : null,
            userAgent: deletedSession.userAgent,
            createdAt: deletedSession.createdAt,
            updatedAt: deletedSession.updatedAt,
            expiresAt: deletedSession.expiresAt,
            endReason: context?.path === "/sign-out"
              ? "learner_logout"
              : context?.path === "/reset-password"
                ? "password_reset"
                : "learner_logout_others",
          });
        },
      },
    },
  },
  plugins: [
    atomicAuthRateLimitPlugin(databaseRateLimitsRequired),
    breachedPasswordPlugin(),
    twoFactor({
      issuer: process.env.APP_NAME ?? "Codestead",
      allowPasswordless: true,
      // PingID-style: a TOTP-verified browser stays trusted for 24 hours.
      trustDeviceMaxAge: TRUSTED_DEVICE_MAX_AGE_SECONDS,
    }),
    admin({
      defaultRole: "learner",
      adminRoles: ["admin"],
      defaultBanReason: "Access suspended by the administrator",
      roles: { admin: restrictedAdminRole, learner: restrictedLearnerRole },
    }),
    nextCookies(),
  ],
});

export type Auth = typeof auth;
