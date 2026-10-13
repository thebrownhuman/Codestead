import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { Suspense } from "react";

import { ActivationForm } from "@/components/auth/activation-form";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = publicPageMetadata({
  pathname: "/activate",
  title: "Activate your invitation",
  description: "Accept your approved Codestead invitation and create a secure learning account.",
});

export default function ActivatePage() {
  return <AuthShell eyebrow="Invitation accepted" title="Create your account" description="Choose your password, verify your email, then secure the account with an authenticator."><Suspense fallback={<p>Checking invitation…</p>}><ActivationForm /></Suspense></AuthShell>;
}
