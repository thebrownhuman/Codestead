import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { isGoogleOAuthConfigured } from "@/lib/security/oauth-provider-config";
import { signedInDestination } from "@/lib/security/signed-in-destination";

export const metadata: Metadata = publicPageMetadata({
  pathname: "/login",
  title: "Sign in",
  description: "Sign in to Codestead on your approved device and resume your roadmap.",
});

export default async function LoginPage() {
  // Signing in again on the device that already holds the live session would
  // hit the one-device rule; send the learner straight back in instead.
  const destination = await signedInDestination();
  if (destination) redirect(destination);
  return <AuthShell eyebrow="Welcome back" title="Continue your learning" description="Sign in on your approved device. Your roadmap will resume exactly where you stopped."><LoginForm googleEnabled={isGoogleOAuthConfigured()} /></AuthShell>;
}
