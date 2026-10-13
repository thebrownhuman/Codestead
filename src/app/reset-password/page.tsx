import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { ResetPasswordForm } from "@/components/auth/password-recovery-forms";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = publicPageMetadata({
  pathname: "/reset-password",
  title: "Choose a new password",
  description: "Set a new Codestead password using your single-use recovery link and revoke previous sessions.",
});

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const params = await searchParams;
  return (
    <AuthShell
      eyebrow="Account recovery"
      title="Choose a new password"
      description="Use at least 12 characters. A successful reset revokes every existing session."
    >
      <ResetPasswordForm token={params.token} invalid={params.error === "INVALID_TOKEN"} />
    </AuthShell>
  );
}
