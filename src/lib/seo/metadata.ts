import type { Metadata } from "next";

import { SITE_URL } from "@/lib/site";

/** Canonicals deliberately omit query strings, including recovery tokens. */
export function publicPageMetadata({
  pathname, title, description, indexable = false, absoluteTitle = false, noarchive = false,
}: {
  pathname: string;
  title: string;
  description: string;
  indexable?: boolean;
  absoluteTitle?: boolean;
  noarchive?: boolean;
}): Metadata {
  const canonical = new URL(pathname, SITE_URL).href;
  const socialTitle = absoluteTitle ? title : `${title} | Codestead`;
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website", siteName: "Codestead", url: canonical,
      title: socialTitle, description,
    },
    twitter: { card: "summary", title: socialTitle, description },
    robots: { index: indexable, follow: indexable, ...(noarchive ? { noarchive: true } : {}) },
  };
}
