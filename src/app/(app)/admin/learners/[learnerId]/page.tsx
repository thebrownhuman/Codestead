import type { Metadata } from "next";

import { LearnerDetail } from "@/components/admin/learner-detail";

export const metadata: Metadata = {
  title: "Learner mentor view · Codestead",
};

export default async function AdminLearnerPage({
  params,
}: {
  readonly params: Promise<{ learnerId: string }>;
}) {
  const { learnerId } = await params;
  return <LearnerDetail learnerId={learnerId} />;
}
