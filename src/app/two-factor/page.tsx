import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { AuthShell } from "@/components/auth/auth-shell";
import { TwoFactorForm } from "@/components/auth/two-factor-form";

export const metadata: Metadata = publicPageMetadata({
  pathname: "/two-factor",
  title: "Confirm your authenticator",
  description: "Complete Codestead multi-factor verification to continue on your approved device.",
});

export default function TwoFactorPage() {
  return <AuthShell eyebrow="Second step" title="Confirm it is you" description="Every learner and administrator uses multi-factor authentication. Codes are verified on your server."><TwoFactorForm /></AuthShell>;
}
