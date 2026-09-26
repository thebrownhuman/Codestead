import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { isGoogleOAuthConfigured } from "@/lib/security/oauth-provider-config";

export default function LoginPage() {
  return <AuthShell eyebrow="Welcome back" title="Continue your learning" description="Sign in on your approved device. Your roadmap will resume exactly where you stopped."><LoginForm googleEnabled={isGoogleOAuthConfigured()} /></AuthShell>;
}
