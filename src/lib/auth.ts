import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin, twoFactor } from "better-auth/plugins";

import { db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { enqueueEmail } from "@/lib/notifications/outbox";
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

const isBuild = process.env.NEXT_PHASE === "phase-production-build";
const authSecret =
  process.env.BETTER_AUTH_SECRET ??
  (isBuild || process.env.NODE_ENV === "development"
    ? "build-only-secret-that-must-never-serve-production"
    : undefined);

if (!authSecret) {
  throw new Error("BETTER_AUTH_SECRET is required outside development/build.");
}

const googleConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
);

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
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user: authUser, url }) => {
      await enqueueEmail({
        to: authUser.email,
        userId: authUser.id,
        template: "reset-password",
        variables: { name: authUser.name, url },
        idempotencySeed: url,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user: authUser, url }) => {
      await enqueueEmail({
        to: authUser.email,
        userId: authUser.id,
        template: "verify-email",
        variables: { name: authUser.name, url },
        idempotencySeed: url,
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
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
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
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 8 },
      "/sign-up/email": { window: 60 * 10, max: 3 },
      "/two-factor/verify-totp": { window: 60, max: 6 },
    },
  },
  advanced: {
    cookiePrefix: "learncoding",
    useSecureCookies: process.env.NODE_ENV === "production" && !isBuild,
    database: { generateId: () => randomUUID() },
  },
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      if (![
        "/two-factor/verify-totp",
        "/two-factor/verify-backup-code",
      ].includes(ctx.path)) return;
      const completed = ctx.context.newSession;
      if (!completed) return;
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
        before: async (candidate) => {
          await archiveExpiredSessions(candidate.userId);
          const [activeSession] = await db
            .select({ id: schema.session.id })
            .from(schema.session)
            .where(
              and(
                eq(schema.session.userId, candidate.userId),
                isNull(schema.session.revokedAt),
                gt(schema.session.expiresAt, new Date()),
              ),
            )
            .limit(1);

          // One active device family. Multiple tabs share the same auth cookie.
          if (activeSession) return false;
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
    twoFactor({
      issuer: process.env.APP_NAME ?? "Codestead",
      allowPasswordless: true,
      trustDeviceMaxAge: 0,
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
