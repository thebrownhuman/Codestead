import type { Metadata } from "next";

import { TimedExamClient } from "@/components/exams/timed-exam-client";

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
  return <TimedExamClient sessionId={sessionId} />;
}
