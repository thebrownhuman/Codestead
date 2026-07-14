import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/lib/privacy/consent", () => ({
  getCurrentConsentsFrom: vi.fn(async () => new Map()),
  consentPurposeForProvider: vi.fn(() => "provider:nvidia_nim"),
  isCurrentConsentAccepted: vi.fn(() => true),
}));
vi.mock("@/lib/security/user-authority-lock", () => ({
  lockUserAuthority: vi.fn(async () => undefined),
}));

import {
  fallbackCostPaise,
  reconcileFallbackBudget,
  reserveFallbackBudget,
} from "../fallback-budget";

function insertBuilder(inserted: unknown[] = [{ id: "reservation-1" }]) {
  const returning = vi.fn(async () => inserted);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  return { insert: vi.fn(() => ({ values })), returning };
}

function updateBuilder(rows: unknown[] = [{ id: "grant-1" }]) {
  const returning = vi.fn(async () => rows);
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.set = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.returning = returning;
  return { update: vi.fn(() => builder), returning };
}

function authoritySelectBuilder(rows: unknown[]) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.from = vi.fn(() => builder);
  builder.innerJoin = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.for = vi.fn(async () => rows);
  return { select: vi.fn(() => builder) };
}

const authority = {
  grantId: "grant-1",
  learnerId: "learner-1",
  credentialId: "credential-1",
  provider: "nvidia_nim",
  model: "model-1",
  grantedBy: "admin-1",
  tokenBudget: 1_000,
  tokensUsed: 0,
  rupeeBudgetPaise: 500,
  rupeesUsedPaise: 0,
  credentialOwnerId: "admin-1",
};

const reservationAuthority = {
  credentialId: "credential-1",
  provider: "nvidia_nim" as const,
  model: "model-1",
};

function selectBuilder(rows: unknown[]) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.from = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.for = vi.fn(async () => rows);
  return { select: vi.fn(() => builder) };
}

describe("atomic fallback token and rupee accounting", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rounds the frozen pricing snapshot up to whole paise", () => {
    expect(fallbackCostPaise({
      inputTokens: 10,
      outputTokens: 8,
      inputPaisePerMillionTokens: 100_000,
      outputPaisePerMillionTokens: 200_000,
    })).toBe(3);
    expect(fallbackCostPaise({
      inputTokens: 0,
      outputTokens: 0,
      inputPaisePerMillionTokens: 100_000,
      outputPaisePerMillionTokens: 200_000,
    })).toBe(0);
    expect(() => fallbackCostPaise({
      inputTokens: -1,
      outputTokens: 0,
      inputPaisePerMillionTokens: 1,
      outputPaisePerMillionTokens: 1,
    })).toThrow(/safe non-negative integers/);
  });

  it("commits a reservation only when the dual guarded update succeeds", async () => {
    const inserted = insertBuilder();
    const updated = updateBuilder([{ id: "grant-1" }]);
    const selected = authoritySelectBuilder([authority]);
    mocks.transaction.mockImplementationOnce(async (callback) => callback({
      select: selected.select,
      insert: inserted.insert,
      update: updated.update,
    }));
    await expect(reserveFallbackBudget({
      reservationId: "10000000-0000-4000-8000-000000000001",
      grantId: "grant-1",
      learnerId: "learner-1",
      ...reservationAuthority,
      tokens: 400,
      costPaise: 75,
      now: new Date("2026-07-12T10:00:00.000Z"),
    })).resolves.toBe(true);

    const rejectedInsert = insertBuilder();
    const rejectedUpdate = updateBuilder([]);
    const rejectedSelected = authoritySelectBuilder([authority]);
    mocks.transaction.mockImplementationOnce(async (callback) => callback({
      select: rejectedSelected.select,
      insert: rejectedInsert.insert,
      update: rejectedUpdate.update,
    }));
    await expect(reserveFallbackBudget({
      reservationId: "10000000-0000-4000-8000-000000000002",
      grantId: "grant-1",
      learnerId: "learner-1",
      ...reservationAuthority,
      tokens: 400,
      costPaise: 75,
    })).resolves.toBe(false);
  });

  it("rejects malformed reservations before touching the database", async () => {
    await expect(reserveFallbackBudget({
      reservationId: "reservation-1",
      grantId: "grant-1",
      learnerId: "learner-1",
      ...reservationAuthority,
      tokens: 0,
      costPaise: 1,
    })).resolves.toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("reconciles both resources once and accepts an exact idempotent replay", async () => {
    const reservation = {
      grantId: "grant-1",
      learnerId: "learner-1",
      reservedTokens: 500,
      reservedPaise: 80,
      actualTokens: null,
      actualPaise: null,
      status: "reserved",
    };
    const selected = selectBuilder([reservation]);
    const updated = updateBuilder([{ id: "grant-1" }]);
    mocks.transaction.mockImplementationOnce(async (callback) => callback({
      select: selected.select,
      update: updated.update,
    }));
    await reconcileFallbackBudget({
      reservationId: "10000000-0000-4000-8000-000000000001",
      grantId: "grant-1",
      learnerId: "learner-1",
      reservedTokens: 500,
      reservedCostPaise: 80,
      actualTokens: 125,
      actualCostPaise: 20,
    });
    expect(updated.update).toHaveBeenCalledTimes(2);

    const replayed = selectBuilder([{
      ...reservation,
      actualTokens: 125,
      actualPaise: 20,
      status: "reconciled",
    }]);
    const replayUpdate = updateBuilder();
    mocks.transaction.mockImplementationOnce(async (callback) => callback({
      select: replayed.select,
      update: replayUpdate.update,
    }));
    await reconcileFallbackBudget({
      reservationId: "10000000-0000-4000-8000-000000000001",
      grantId: "grant-1",
      learnerId: "learner-1",
      reservedTokens: 500,
      reservedCostPaise: 80,
      actualTokens: 125,
      actualCostPaise: 20,
    });
    expect(replayUpdate.update).not.toHaveBeenCalled();
  });

  it("refuses reconciliation beyond either reserved upper bound", async () => {
    await expect(reconcileFallbackBudget({
      reservationId: "reservation-1",
      grantId: "grant-1",
      learnerId: "learner-1",
      reservedTokens: 100,
      reservedCostPaise: 10,
      actualTokens: 101,
      actualCostPaise: 10,
    })).rejects.toThrow(/outside the reservation/);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("wires a reservation ledger and dual-budget accounting into the tutor route", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/app/api/ai/tutor/route.ts"),
      "utf8",
    );
    expect(source).toContain("reserveFallbackBudget");
    expect(source).toContain("reconcileFallbackBudget");
    expect(source).toContain("fallbackCostRemainingPaise");
    expect(source).toContain("fallbackInputPaisePerMillionTokens");
  });
});
