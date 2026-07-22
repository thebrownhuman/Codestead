import type { Metadata } from "next";

import { TimedExamClient } from "@/components/exams/timed-exam-client";
import { DraftCacheNamespaceProvider } from "@/lib/drafts/browser-cache-context";
import { createBrowserDurabilityNamespace } from "@/lib/drafts/cache-namespace";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";

export const metadata: Metadata = {
  title: "Timed exam",
  description: "Independent, server-timed module exam.",
};

export default async function ExamSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const exam = <TimedExamClient sessionId={sessionId} />;

  if (isApplicationAuthRequired()) return exam;

  // Local demo/E2E mode has no authenticated session from which the app shell
  // can derive a private recovery namespace. Scope a synthetic namespace to
  // this exam page only so formal-exam recovery remains testable without
  // enabling authenticated draft synchronization across the demo shell.
  return (
    <DraftCacheNamespaceProvider
      namespace={createBrowserDurabilityNamespace("local-demo-user", "local-demo-exam-session")}
    >
      {exam}
    </DraftCacheNamespaceProvider>
  );
}
