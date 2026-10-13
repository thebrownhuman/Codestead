import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

// These discovery documents contain no session, nonce, or user data.
export const revalidate = 3600;

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/request-access`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/source`, changeFrequency: "monthly", priority: 0.3 },
  ];
}
