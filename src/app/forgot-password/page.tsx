import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { ForgotPasswordForm } from "@/components/auth/password-recovery-forms";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = publicPageMetadata({
  pathname: "/forgot-password",
  title: "Forgot your password",
  description: "Request a password reset for your approved Codestead account without disclosing account status.",
});

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      eyebrow="Account recovery"
      title="Reset your password"
      description="Enter the approved account email. For privacy, the result never confirms whether an account exists."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
