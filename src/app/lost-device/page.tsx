import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { AuthShell } from "@/components/auth/auth-shell";
import { LostDeviceRecoveryForm } from "@/components/auth/lost-device-recovery-form";

export const metadata: Metadata = publicPageMetadata({
  pathname: "/lost-device",
  title: "Recover a lost device",
  description: "Request administrator-assisted Codestead device recovery after confirming your approved mailbox.",
});

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
