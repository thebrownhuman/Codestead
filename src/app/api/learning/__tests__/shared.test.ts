import { afterEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { z } from "zod";

import { LearningServiceError } from "@/lib/learning-service";
import {
  learningJson,
  learningRoute,
  parseLearningBody,
  secureLearningResponse,
} from "../_shared";

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

afterEach(() => vi.restoreAllMocks());

describe("adaptive learning HTTP privacy contract", () => {
  it("applies private no-store headers to every learning response", async () => {
    const response = learningJson({ ok: true }, 201);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0, must-revalidate");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("adds the same privacy headers to upstream authentication responses", () => {
    const response = secureLearningResponse(NextResponse.json({ error: "Authentication required." }, { status: 401 }));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("maps typed service errors to stable public codes and bounded details", async () => {
    const response = await learningRoute(async () => {
      throw new LearningServiceError("VERSION_CONFLICT", "Reload and retry.", 409, { resource: "session" });
    });
    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      error: "Reload and retry.", code: "VERSION_CONFLICT", details: { resource: "session" },
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("does not reflect unknown exception details to the learner", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await learningRoute(async () => {
      throw new Error("database password and internal host must stay private");
    });
    expect(response.status).toBe(503);
    const body = await json(response);
    expect(body).toEqual({
      error: "Adaptive learning is temporarily unavailable.", code: "LEARNING_SERVICE_UNAVAILABLE",
    });
    expect(JSON.stringify(body)).not.toContain("database password");
    expect(error).toHaveBeenCalledOnce();
  });

  it("returns successful work with the requested status", async () => {
    const response = await learningRoute(async () => ({ state: "ready" }), 202);
    expect(response.status).toBe(202);
    expect(await json(response)).toEqual({ state: "ready" });
  });
});

describe("learning request parsing", () => {
  const schema = z.object({ goal: z.string().trim().min(3), minutes: z.number().int().min(5) }).strict();

  it("parses and normalizes a valid JSON body", async () => {
    const request = new Request("https://example.test/api/learning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "  Study loops  ", minutes: 25 }),
    });
    await expect(parseLearningBody(request, schema)).resolves.toEqual({ goal: "Study loops", minutes: 25 });
  });

  it.each([
    ["not-json", []],
    [JSON.stringify({ goal: "x", minutes: 1, unexpected: "field" }), ["goal", "minutes"]],
  ])("rejects malformed or schema-invalid payload", async (body, expectedFields) => {
    const request = new Request("https://example.test/api/learning", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    const error = await parseLearningBody(request, schema).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    const fields = (error as LearningServiceError).details?.fields as string[];
    for (const field of expectedFields) expect(fields).toContain(field);
    expect(fields.length).toBeLessThanOrEqual(12);
  });
});
