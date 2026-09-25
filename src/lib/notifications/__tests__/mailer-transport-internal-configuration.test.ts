import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureMailTransportConfiguration,
  capturePreparedMailTransportPlan,
  discardPreparedMailTransportPlan,
  type PreparedMailTransportTiming,
} from "../mailer-transport-internal";

// Mirrors the module's own internal deadlines; capturePreparedMailTransportPlan
// rejects any other exact values.
const VALID_TIMING: PreparedMailTransportTiming = Object.freeze({
  oauthDeadlineMs: 20_000,
  guardedSendDeadlineMs: 20_000,
  providerAbortSettlementMs: 5_000,
});

describe("captureMailTransportConfiguration", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllEnvs();
  });

  it("rejects an adapter that is neither console nor gmail", () => {
    // @ts-expect-error intentionally invalid adapter
    expect(() => captureMailTransportConfiguration("smtp")).toThrow(
      "Invalid mail adapter.",
    );
  });

  it("captures a console configuration without reading Gmail env vars", () => {
    const handle = captureMailTransportConfiguration("console");
    expect(Object.isFrozen(handle)).toBe(true);
  });

  it("throws when Gmail OAuth env vars are missing", () => {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN;
    expect(() => captureMailTransportConfiguration("gmail")).toThrow(
      "Gmail OAuth is not configured.",
    );
  });

  it("throws when a Gmail credential contains a newline", () => {
    process.env.GMAIL_CLIENT_ID = "client\nid";
    process.env.GMAIL_CLIENT_SECRET = "secret";
    process.env.GMAIL_REFRESH_TOKEN = "refresh";
    expect(() => captureMailTransportConfiguration("gmail")).toThrow(
      "Gmail OAuth is not configured.",
    );
  });

  it("captures a Gmail configuration when every credential is present and safe", () => {
    process.env.GMAIL_CLIENT_ID = "client-id";
    process.env.GMAIL_CLIENT_SECRET = "client-secret";
    process.env.GMAIL_REFRESH_TOKEN = "refresh-token";
    const handle = captureMailTransportConfiguration("gmail");
    expect(Object.isFrozen(handle)).toBe(true);
  });
});

describe("capturePreparedMailTransportPlan", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("rejects an unfrozen timing object", () => {
    const configuration = captureMailTransportConfiguration("console");
    expect(() =>
      capturePreparedMailTransportPlan(
        "console",
        { ...VALID_TIMING },
        configuration,
      ),
    ).toThrow("Invalid prepared mail transport timing.");
  });

  it("rejects timing values that do not match the exact required deadlines", () => {
    const configuration = captureMailTransportConfiguration("console");
    const badTiming = Object.freeze({ ...VALID_TIMING, oauthDeadlineMs: 1 });
    expect(() =>
      capturePreparedMailTransportPlan("console", badTiming, configuration),
    ).toThrow("Invalid prepared mail transport timing.");
  });

  it("rejects a transport configuration for a different adapter", () => {
    process.env.GMAIL_CLIENT_ID = "client-id";
    process.env.GMAIL_CLIENT_SECRET = "client-secret";
    process.env.GMAIL_REFRESH_TOKEN = "refresh-token";
    const gmailConfiguration = captureMailTransportConfiguration("gmail");
    expect(() =>
      capturePreparedMailTransportPlan(
        "console",
        VALID_TIMING,
        gmailConfiguration,
      ),
    ).toThrow("Mail transport configuration is invalid.");
  });

  it("rejects a transport configuration handle that was mutated (no longer frozen)", () => {
    // A frozen empty object cannot actually be un-frozen; simulate an
    // untrusted caller passing an arbitrary non-frozen object instead.
    const forged = {} as ReturnType<typeof captureMailTransportConfiguration>;
    expect(() =>
      capturePreparedMailTransportPlan("console", VALID_TIMING, forged),
    ).toThrow("Mail transport configuration is invalid.");
  });

  it("captures a console plan bound to a console configuration", () => {
    const configuration = captureMailTransportConfiguration("console");
    const plan = capturePreparedMailTransportPlan(
      "console",
      VALID_TIMING,
      configuration,
    );
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("captures a gmail plan bound to a gmail configuration", () => {
    process.env.GMAIL_CLIENT_ID = "client-id";
    process.env.GMAIL_CLIENT_SECRET = "client-secret";
    process.env.GMAIL_REFRESH_TOKEN = "refresh-token";
    const configuration = captureMailTransportConfiguration("gmail");
    const plan = capturePreparedMailTransportPlan(
      "gmail",
      VALID_TIMING,
      configuration,
    );
    expect(Object.isFrozen(plan)).toBe(true);
  });
});

describe("discardPreparedMailTransportPlan", () => {
  it("returns false for a plan-shaped object that was never captured", () => {
    expect(discardPreparedMailTransportPlan(Object.freeze({}) as never)).toBe(
      false,
    );
  });

  it("returns false for an unfrozen value", () => {
    expect(discardPreparedMailTransportPlan({} as never)).toBe(false);
  });

  it("discards a captured plan exactly once", () => {
    const configuration = captureMailTransportConfiguration("console");
    const plan = capturePreparedMailTransportPlan(
      "console",
      VALID_TIMING,
      configuration,
    );
    expect(discardPreparedMailTransportPlan(plan)).toBe(true);
    expect(discardPreparedMailTransportPlan(plan)).toBe(false);
  });
});
