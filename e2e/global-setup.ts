import type { FullConfig } from "@playwright/test";

// `next dev` compiles each route on its first request. Requesting every route the
// specs use before any test starts keeps those compiles out of test timeouts.
const WARM_ROUTES = [
  "/",
  "/admin/certificates",
  "/admin/curriculum",
  "/admin/requests",
  "/career",
  "/community",
  "/courses",
  "/courses/git-tooling/skills/git.branches.merge",
  "/courses/python",
  "/courses/python/skills/python.toolchain.repl",
  "/exams",
  "/forgot-password",
  "/learn",
  "/login",
  "/lost-device",
  "/playground",
  "/projects",
  "/request-access",
  "/requests",
  "/reset-password",
  "/review",
  "/roadmap",
  "/settings",
  "/tutor",
] as const;

const ROUTE_LIMIT_MS = 120_000;

// A plain request makes `next dev` compile the route's server and client entries,
// so warming needs no browser; every Playwright project, whichever browser it
// installed, can run it.
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Playwright baseURL is required to warm routes.");
  for (const route of WARM_ROUTES) {
    const response = await fetch(new URL(route, baseURL), {
      redirect: "manual",
      signal: AbortSignal.timeout(ROUTE_LIMIT_MS),
    });
    await response.arrayBuffer();
  }
}
