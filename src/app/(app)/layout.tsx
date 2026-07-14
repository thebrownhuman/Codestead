import { redirect } from "next/navigation";

import { AppShell } from "@/components/shell/app-shell";
import { createDraftCacheNamespace } from "@/lib/drafts/cache-namespace";
import { requireAuth } from "@/lib/http/authz";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";

export default async function LearnerLayout({ children }: { children: React.ReactNode }) {
  if (isApplicationAuthRequired()) {
    const authz = await requireAuth({ allowPending: true });
    if (!authz.session) {
      const denial = (await authz.response.json().catch(() => ({}))) as { code?: string };
      if (denial.code === "MFA_CHALLENGE_REQUIRED") redirect("/two-factor");
      if (authz.response.status === 401) redirect("/login");
      redirect("/login?error=account-inactive");
    }
    if (authz.account.status === "pending") redirect("/onboarding");
    const draftCacheNamespace = createDraftCacheNamespace(
      authz.session.user.id,
      authz.session.session.id,
    );
    return <AppShell admin={authz.account.role === "admin"} draftCacheNamespace={draftCacheNamespace} viewer={{ name: authz.session.user.name, role: authz.account.role === "admin" ? "Administrator" : "Learner", image: authz.session.user.image }}>{children}</AppShell>;
  }
  return <AppShell admin viewer={{ name: "Aarav Rao", role: "Demo learner" }}>{children}</AppShell>;
}
