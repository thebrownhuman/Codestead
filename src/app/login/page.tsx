import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";

export default function LoginPage() {
  return <AuthShell eyebrow="Welcome back" title="Continue your learning" description="Sign in on your approved device. Your roadmap will resume exactly where you stopped."><LoginForm /></AuthShell>;
}
