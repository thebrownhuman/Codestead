import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const values = vi.fn();
  const insert = vi.fn(() => ({ values }));
  return { limit, orderBy, where, from, select, values, insert, callProvider: vi.fn() };
});

vi.mock("@/lib/db/client", () => ({
  db: { select: mocks.select, insert: mocks.insert },
}));
vi.mock("@/lib/ai/providers", () => ({ callProvider: mocks.callProvider }));

import { validateProviderCredential } from "../credential-validation";
import { ProviderError } from "../types";

const base = {
  userId: "learner-1",
  credentialId: "credential-1",
  provider: "nvidia_nim" as const,
  secret: "synthetic-test-credential",
};

describe("provider credential validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockReset().mockResolvedValue([]);
    mocks.values.mockResolvedValue(undefined);
    mocks.callProvider.mockResolvedValue({
      provider: "nvidia_nim",
      model: "test/model",
      content: "OK",
      inputTokens: 2,
      outputTokens: 1,
      latencyMs: 5,
    });
  });

  it("uses the safe default NIM probe and records hashes, never the secret", async () => {
    await expect(validateProviderCredential(base)).resolves.toMatchObject({
      status: "active",
      failureCode: null,
      model: "test/model",
    });
    expect(mocks.callProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: "nvidia_nim",
      apiKey: base.secret,
      maxOutputTokens: 4,
    }));
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: "credential-1",
      operation: "credential_validation",
      status: "succeeded",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      responseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(JSON.stringify(mocks.values.mock.calls)).not.toContain(base.secret);
  });

  it("returns pending without transmitting an optional provider key when no policy exists", async () => {
    const result = await validateProviderCredential({ ...base, provider: "openai" });
    expect(result).toEqual({ status: "pending_validation", failureCode: null, model: null });
    expect(mocks.callProvider).not.toHaveBeenCalled();
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it("classifies rate limits without logging key material", async () => {
    mocks.callProvider.mockRejectedValueOnce(
      new ProviderError("Rate limited", "RATE_LIMIT", 429),
    );
    await expect(validateProviderCredential(base)).resolves.toMatchObject({
      status: "rate_limited",
      failureCode: "RATE_LIMIT",
    });
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorCode: "RATE_LIMIT",
    }));
    expect(JSON.stringify(mocks.values.mock.calls)).not.toContain(base.secret);
  });

  it("keeps transient provider failures pending instead of declaring the key invalid", async () => {
    mocks.callProvider.mockRejectedValueOnce(
      new ProviderError("Temporary outage", "UNAVAILABLE", 503),
    );
    await expect(validateProviderCredential(base)).resolves.toMatchObject({
      status: "pending_validation",
      failureCode: "UNAVAILABLE",
    });
  });

  it("marks only an explicit provider authentication rejection as invalid", async () => {
    mocks.callProvider.mockRejectedValueOnce(
      new ProviderError("Unauthorized", "AUTHENTICATION", 401),
    );
    await expect(validateProviderCredential(base)).resolves.toMatchObject({
      status: "invalid",
      failureCode: "AUTHENTICATION",
    });
  });

  it("propagates a persistence failure after a successful probe instead of mislabeling the key", async () => {
    mocks.values.mockRejectedValueOnce(new Error("model-call write unavailable"));
    await expect(validateProviderCredential(base)).rejects.toThrow("model-call write unavailable");
    expect(mocks.callProvider).toHaveBeenCalledTimes(1);
    expect(mocks.values).toHaveBeenCalledTimes(1);
  });
});
