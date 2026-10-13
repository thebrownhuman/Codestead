import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LandingPage } from "@/components/landing/landing-page";
import { signedInDestination } from "@/lib/security/signed-in-destination";

export const metadata: Metadata = publicPageMetadata({
  pathname: "/",
  title: "Codestead — private, adaptive coding studio",
  description: "Build skills that stay with a private, adaptive learning studio for coding, DSA, web, and AI.",
  indexable: true,
  absoluteTitle: true,
});

export default async function HomePage() {
  // A remembered device resumes where the learner left off instead of
  // looking signed out on the marketing page.
  const destination = await signedInDestination();
  if (destination) redirect(destination);
  return <LandingPage nonce={(await headers()).get("x-nonce") ?? undefined} />;
}
