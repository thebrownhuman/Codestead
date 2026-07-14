import { ForgotPasswordForm } from "@/components/auth/password-recovery-forms";
import { AuthShell } from "@/components/auth/auth-shell";

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
