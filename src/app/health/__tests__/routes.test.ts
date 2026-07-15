import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));

import { GET as getLiveness } from "../live/route";
import { GET as getReadiness } from "../ready/route";

function expectHealthHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("application health routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports process liveness without querying the database", async () => {
    const response = getLiveness();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expectHealthHeaders(response);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("reports readiness after the bounded database probe succeeds", async () => {
    mocks.query.mockResolvedValue({ rows: [{ "?column?": 1 }] });

    const response = await getReadiness();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
    expectHealthHeaders(response);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith({ text: "select 1", query_timeout: 2_000 });
  });

  it("reports generic unavailability without exposing database failures", async () => {
    const databaseFailure = new Error("database connection details must stay private");
    mocks.query.mockRejectedValue(databaseFailure);

    const response = await getReadiness();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: "unavailable" });
    expect(JSON.stringify(body)).not.toContain(databaseFailure.message);
    expectHealthHeaders(response);
  });
});
