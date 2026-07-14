import type { Metadata } from "next";

import { ExamCatalog } from "@/components/exams/exam-catalog";

export const metadata: Metadata = {
  title: "Formal exams",
  description: "Timed, evidence-safe module exams with server-authoritative deadlines.",
};

export default function ExamsPage() {
  return <ExamCatalog />;
}
