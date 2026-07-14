import { AdminAssessmentCorrections } from "@/components/admin/admin-assessment-corrections";

export default async function AdminAssessmentCorrectionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ appeal?: string }>;
}) {
  const { appeal } = await searchParams;
  return <AdminAssessmentCorrections initialAppealId={appeal ?? ""} />;
}
