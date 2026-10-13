import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { AccessRequestForm } from "@/components/auth/access-request-form";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = publicPageMetadata({
  pathname: "/request-access",
  title: "Request access",
  description: "Request a learning seat in the Codestead private pilot. Every request is reviewed by an administrator.",
  indexable: true,
});

export default function RequestAccessPage() {
  return <AuthShell eyebrow="Private pilot" title="Request a learning seat" description="The administrator reviews every request. Approved learners receive a single-use invitation by email."><AccessRequestForm /></AuthShell>;
}
