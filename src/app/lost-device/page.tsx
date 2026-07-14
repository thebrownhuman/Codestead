import { AuthShell } from "@/components/auth/auth-shell";
import { LostDeviceRecoveryForm } from "@/components/auth/lost-device-recovery-form";

export default function LostDevicePage() {
  return (
    <AuthShell
      eyebrow="Device recovery"
      title="Request help with a lost device"
      description="Confirm the approved mailbox, then wait for a separate administrator identity check. No step here signs you in or resets your password or authenticator."
    >
      <LostDeviceRecoveryForm />
    </AuthShell>
  );
}
