import { readFileSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { describe, expect, it, vi } from "vitest";

import { SITE_URL } from "@/lib/site";
import * as robotsRoute from "../robots";
import * as sitemapRoute from "../sitemap";

vi.mock("@/lib/security/signed-in-destination", () => ({ signedInDestination: vi.fn() }));
vi.mock("@/lib/portfolio/service", () => ({ loadPublicPortfolio: vi.fn(), PublicPortfolioError: class extends Error {} }));

const publicPages = [
  ["/", () => import("../page")],
  ["/request-access", () => import("../request-access/page")],
  ["/source", () => import("../source/page")],
  ["/login", () => import("../login/page")],
  ["/activate", () => import("../activate/page")],
  ["/forgot-password", () => import("../forgot-password/page")],
  ["/reset-password", () => import("../reset-password/page")],
  ["/lost-device", () => import("../lost-device/page")],
  ["/two-factor", () => import("../two-factor/page")],
  ["/onboarding", () => import("../onboarding/page")],
  ["/p/published-learner", () => import("../p/[slug]/page")],
] as const;

async function pageMetadata(load: () => Promise<unknown>): Promise<Metadata> {
  const page = await load() as {
    metadata?: Metadata;
    generateMetadata?: (props: { params: Promise<{ slug: string }> }) => Promise<Metadata>;
  };
  return page.generateMetadata ? page.generateMetadata({ params: Promise.resolve({ slug: "published-learner" }) }) : page.metadata ?? {};
}

describe("public SEO", () => {
  it.each(publicPages)("exports complete route-specific metadata for %s", async (route, load) => {
    const metadata = await pageMetadata(load);
    expect(metadata.title).toBeTruthy();
    expect(metadata.description).toEqual(expect.any(String));
    expect(metadata.alternates?.canonical).toBe(new URL(route, SITE_URL).href);
    expect(metadata.openGraph).toMatchObject({
      title: expect.any(String), description: metadata.description,
      url: new URL(route, SITE_URL).href,
    });
  });

  it("uses unique titles and descriptions across the public pages", async () => {
    const metadata = await Promise.all(publicPages.map(([, load]) => pageMetadata(load)));
    expect(new Set(metadata.map((item) => JSON.stringify(item.title))).size).toBe(publicPages.length);
    expect(new Set(metadata.map((item) => item.description)).size).toBe(publicPages.length);
  });

  it("lists exactly public marketing pages and no learner or user-specific URLs", () => {
    const routes = sitemapRoute.default().map((item) => new URL(item.url).pathname);
    expect(routes.sort()).toEqual(["/", "/request-access", "/source"]);
    for (const forbidden of ["/courses", "/p/", "/verify/", "/dashboard", "/admin", "/api", "/learn", "/login"]) {
      expect(routes.some((route) => route.startsWith(forbidden))).toBe(false);
    }
  });

  it("blocks private base paths as well as their descendants", () => {
    const rules = robotsRoute.default().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    const disallowed = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    for (const route of ["/admin", "/api", "/dashboard", "/courses", "/learn", "/settings", "/verify", "/p/"]) {
      expect(disallowed).toContain(route);
    }
    expect(rule.allow).toEqual(expect.arrayContaining(["/", "/request-access", "/source"]));
  });

  it("revalidates only non-personal discovery documents hourly", () => {
    expect((robotsRoute as { revalidate?: number }).revalidate).toBe(3600);
    expect((sitemapRoute as { revalidate?: number }).revalidate).toBe(3600);
  });

  it("keeps public user data dynamic and prevents indexing recovery URLs", async () => {
    const portfolio = await import("../p/[slug]/page");
    expect(portfolio.dynamic).toBe("force-dynamic");
    const metadata = await pageMetadata(() => Promise.resolve(portfolio));
    expect(metadata.robots).toMatchObject({ index: false, follow: false, noarchive: true });
    const reset = await pageMetadata(() => import("../reset-password/page"));
    expect(reset.robots).toMatchObject({ index: false, follow: false });
    expect(String(reset.alternates?.canonical)).not.toContain("token");
  });

  it("retains request-time CSP rendering and the authenticated layout gate", () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), "src/app", file), "utf8");
    expect(read("layout.tsx")).toContain('(await headers()).get("x-nonce")');
    expect(read("(app)/layout.tsx")).toContain("await requireAuth({ allowPending: true })");
    expect(read("(app)/layout.tsx")).not.toMatch(/force-static|generateStaticParams/);
    for (const file of ["page.tsx", "login/page.tsx"]) expect(read(file)).toContain("await signedInDestination()");
  });
});
