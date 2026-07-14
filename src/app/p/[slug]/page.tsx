import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicPortfolioView } from "@/components/milestones/public-portfolio-view";
import { loadPublicPortfolio, PublicPortfolioError } from "@/lib/portfolio/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false, noarchive: true } };

export default async function PublicPortfolioPage({ params }: { readonly params: Promise<{ slug: string }> }) {
  let portfolio: Awaited<ReturnType<typeof loadPublicPortfolio>>;
  try { portfolio = await loadPublicPortfolio((await params).slug); }
  catch (error) {
    if (error instanceof PublicPortfolioError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  return <PublicPortfolioView portfolio={portfolio} />;
}
