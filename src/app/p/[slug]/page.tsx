import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { notFound } from "next/navigation";

import { PublicPortfolioView } from "@/components/milestones/public-portfolio-view";
import { loadPublicPortfolio, PublicPortfolioError } from "@/lib/portfolio/service";

export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { readonly params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicPageMetadata({
    pathname: `/p/${encodeURIComponent(slug)}`,
    title: "Public learning portfolio",
    description: "View the learning milestones and project evidence a Codestead learner has chosen to publish.",
    noarchive: true,
  });
}

export default async function PublicPortfolioPage({ params }: { readonly params: Promise<{ slug: string }> }) {
  let portfolio: Awaited<ReturnType<typeof loadPublicPortfolio>>;
  try { portfolio = await loadPublicPortfolio((await params).slug); }
  catch (error) {
    if (error instanceof PublicPortfolioError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  return <PublicPortfolioView portfolio={portfolio} />;
}
