import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

export const revalidate = 3600;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/request-access", "/source"],
      disallow: [
        "/api/",
        "/admin/",
        "/dashboard/",
        "/p/",
        "/health/",
        "/learn/",
        "/career/",
        "/certificates/",
        "/community/",
        "/courses/",
        "/exams/",
        "/playground/",
        "/portfolio/",
        "/projects/",
        "/requests/",
        "/review/",
        "/roadmap/",
        "/settings/",
        "/tutor/",
        "/onboarding/",
        "/two-factor/",
        "/activate/",
        "/verify/",
        "/reset-password/",
        "/forgot-password/",
        "/lost-device/",
      ].flatMap((pathname) => pathname === "/p/" ? [pathname] : [pathname.slice(0, -1), pathname]),
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
