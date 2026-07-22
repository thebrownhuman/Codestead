import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { auditApiSurface } from "../api-surface";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({
  requireAuth: mocks.requireAuth,
  requireAdmin: mocks.requireAdmin,
}));

// The MFA routes import the Better Auth singleton at module load. Their
// handlers must still stop at requireAuth in this matrix, so no auth API is
// needed and the test must not depend on a deployment secret.
vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));

type RouteModule = Partial<Record<string, (...args: never[]) => Promise<Response>>>;
type ViteRouteGlob = {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
};

const routeModules = (import.meta as unknown as ViteRouteGlob)
  .glob("../../../app/api/**/route.ts");

function moduleKey(file: string) {
  return `../../../${file.slice("src/".length)}`;
}

function routeUrl(route: string) {
  return route
    .replace("[...all]", "session")
    .replace("[publicId]", "10000000-0000-4000-8000-000000000001")
    .replace("[attemptId]", "10000000-0000-4000-8000-000000000002")
    .replace("[sessionId]", "10000000-0000-4000-8000-000000000003")
    .replace("[reviewId]", "10000000-0000-4000-8000-000000000004")
    .replace("[learnerId]", "10000000-0000-4000-8000-000000000005")
    .replace("[enrollmentId]", "10000000-0000-4000-8000-000000000006")
    .replace("[appealId]", "10000000-0000-4000-8000-000000000007")
    .replace("[artifactId]", "10000000-0000-4000-8000-000000000008")
    .replace("[courseId]", "10000000-0000-4000-8000-000000000009")
    .replace("[versionId]", "10000000-0000-4000-8000-000000000010")
    .replace("[correctionId]", "10000000-0000-4000-8000-000000000011")
    .replace("[jobId]", "10000000-0000-4000-8000-000000000013")
    .replace("[id]", "10000000-0000-4000-8000-000000000012");
}

function requestFor(route: string, method: string) {
  const hasBody = !["GET", "HEAD"].includes(method);
  return new NextRequest(`https://learn.test${routeUrl(route)}`, {
    method,
    ...(hasBody
      ? { body: JSON.stringify({}), headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

const context = {
  params: Promise.resolve({
    id: "10000000-0000-4000-8000-000000000012",
    publicId: "10000000-0000-4000-8000-000000000001",
    attemptId: "10000000-0000-4000-8000-000000000002",
    sessionId: "10000000-0000-4000-8000-000000000003",
    reviewId: "10000000-0000-4000-8000-000000000004",
    learnerId: "10000000-0000-4000-8000-000000000005",
    enrollmentId: "10000000-0000-4000-8000-000000000006",
    appealId: "10000000-0000-4000-8000-000000000007",
    artifactId: "10000000-0000-4000-8000-000000000008",
    courseId: "10000000-0000-4000-8000-000000000009",
    versionId: "10000000-0000-4000-8000-000000000010",
    correctionId: "10000000-0000-4000-8000-000000000011",
    jobId: "10000000-0000-4000-8000-000000000013",
  }),
};

async function protectedOperations(boundary: "authenticated" | "admin") {
  const surface = await auditApiSurface(process.cwd());
  return surface.entries
    .filter((entry) => entry.boundary === boundary)
    .flatMap((entry) => entry.methods.map((method) => ({ entry, method })));
}

async function invoke(file: string, route: string, method: string) {
  const load = routeModules[moduleKey(file)];
  expect(load, `Vite route loader for ${file}`).toBeTypeOf("function");
  const routeModule = await load!() as RouteModule;
  const handler = routeModule[method];
  expect(handler, `${file}#${method}`).toBeTypeOf("function");
  return handler!(requestFor(route, method) as never, context as never);
}

describe("endpoint-wide executable authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
  });

  it("rejects an anonymous caller before every authenticated operation does work", async () => {
    const operations = await protectedOperations("authenticated");
    // Explicit reviewed inventory: additions must update the API matrix and
    // this executable boundary together rather than silently expanding scope.
    expect(operations).toHaveLength(88);

    for (const { entry, method } of operations) {
      mocks.requireAuth.mockClear();
      const response = await invoke(entry.file, entry.route, method);
      expect(response.status, `${method} ${entry.route}`).toBe(401);
      expect(mocks.requireAuth, `${method} ${entry.route}`).toHaveBeenCalledOnce();
    }
  }, 30_000);

  it("rejects an anonymous caller before every administrator operation does work", async () => {
    const operations = await protectedOperations("admin");
    expect(operations).toHaveLength(60);

    for (const { entry, method } of operations) {
      mocks.requireAdmin.mockClear();
      const response = await invoke(entry.file, entry.route, method);
      expect(response.status, `${method} ${entry.route}`).toBe(401);
      expect(mocks.requireAdmin, `${method} ${entry.route}`).toHaveBeenCalledOnce();
    }
  }, 30_000);

  it("rejects a learner before every administrator operation does work", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const operations = await protectedOperations("admin");

    for (const { entry, method } of operations) {
      mocks.requireAdmin.mockClear();
      const response = await invoke(entry.file, entry.route, method);
      expect(response.status, `${method} ${entry.route}`).toBe(403);
      expect(mocks.requireAdmin, `${method} ${entry.route}`).toHaveBeenCalledOnce();
    }
  }, 30_000);
});
