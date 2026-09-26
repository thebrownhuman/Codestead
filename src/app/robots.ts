import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/request-access"],
      disallow: [
        "/api/",
        "/admin/",
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
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
