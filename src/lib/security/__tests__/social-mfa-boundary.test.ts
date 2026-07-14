import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("social sign-in MFA boundary", () => {
  it("routes Google callbacks into the authenticator challenge", () => {
    const source = read("src/components/auth/login-form.tsx");
    expect(source).toContain('provider: "google", callbackURL: "/two-factor"');
    expect(source).not.toContain('provider: "google", callbackURL: "/onboarding"');
  });

  it("records successful Better Auth TOTP completion on the exact new session", () => {
    const source = read("src/lib/auth.ts");
    expect(source).toContain('"/two-factor/verify-totp"');
    expect(source).toContain('"/two-factor/verify-backup-code"');
    expect(source).toContain("ctx.context.newSession");
    expect(source).toContain("mfaVerifiedAt: new Date()");
    expect(source).toContain("completed.session.id");
  });

  it("fails protected requests closed until the durable session stamp exists", () => {
    const source = read("src/lib/http/authz.ts");
    expect(source).toContain("sessionMfaCompleted");
    expect(source).toContain('"MFA_CHALLENGE_REQUIRED"');
    expect(source).toContain("allowMfaChallenge");
    const layout = read("src/app/(app)/layout.tsx");
    expect(layout).toContain('denial.code === "MFA_CHALLENGE_REQUIRED"');
    expect(layout).toContain('redirect("/two-factor")');
    expect(layout).toContain('authz.response.status === 401');
    expect(layout).toContain('redirect("/login")');
    expect(layout).toContain('redirect("/login?error=account-inactive")');
  });

  it("supports both an existing social session and Better Auth's pending credential challenge", () => {
    const source = read("src/components/auth/two-factor-form.tsx");
    expect(source).toContain('fetch("/api/security/fresh-mfa"');
    expect(source).toContain("currentSessionVerification.status !== 401");
    expect(source).toContain("authClient.twoFactor.verifyTotp");
    expect(source).toContain("trustDevice: false");
  });
});
