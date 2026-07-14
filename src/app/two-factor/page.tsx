import { AuthShell } from "@/components/auth/auth-shell";
import { TwoFactorForm } from "@/components/auth/two-factor-form";

export default function TwoFactorPage() {
  return <AuthShell eyebrow="Second step" title="Confirm it is you" description="Every learner and administrator uses multi-factor authentication. Codes are verified on your server."><TwoFactorForm /></AuthShell>;
}
