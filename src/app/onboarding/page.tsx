import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";

export const metadata: Metadata = publicPageMetadata({
  pathname: "/onboarding",
  title: "Set up your learning profile",
  description: "Complete your approved Codestead account setup, learning preferences, and security requirements.",
});

export default function OnboardingPage() {
  return <OnboardingWizard />;
}
