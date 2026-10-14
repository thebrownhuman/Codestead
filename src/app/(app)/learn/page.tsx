import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthoritativeDashboard } from "@/components/dashboard/authoritative-dashboard";
import { LearnerDashboard } from "@/components/dashboard/learner-dashboard";
import { requireAuth } from "@/lib/http/authz";
import { ensureLearnerRoadmapInitialized, loadAuthoritativeDashboard } from "@/lib/dashboard/learner";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";
import sqlBasics from "../../../../content/sql-practice/basics.json";
import { sqlPracticeLessonSchema } from "@/lib/content/sql-practice";

export const metadata: Metadata = { title: "Learning home" };

export default async function LearnPage({ searchParams }: {
  searchParams: Promise<{ practice?: string | string[] }>;
}) {
  const authz = isApplicationAuthRequired() ? await requireAuth() : null;
  if (authz && !authz.session) redirect("/login");
  if ((await searchParams).practice === "sql") {
    const { SqlPracticeLesson } = await import("@/components/lesson/sql-practice-lesson");
    return <SqlPracticeLesson lesson={sqlPracticeLessonSchema.parse(sqlBasics)} />;
  }
  // A document navigation is intentional: SQL alone receives the WASM CSP.
  const sqlPractice = <p><a href="/learn?practice=sql">Try SQL practice (beta)</a></p>;
  if (!authz?.session) return <>{sqlPractice}<LearnerDashboard /></>;
  const initial = await loadAuthoritativeDashboard(authz.session.user.id, authz.session.user.name);
  const data = await ensureLearnerRoadmapInitialized(authz.session.user.id, authz.session.user.name, initial);
  return <>{sqlPractice}<AuthoritativeDashboard data={data} /></>;
}
