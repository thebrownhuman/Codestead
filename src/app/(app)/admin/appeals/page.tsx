import { AdminAppealQueue } from "@/components/admin/admin-appeal-queue";

export default async function AdminAppealsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ appeal?: string }>;
}) {
  const { appeal } = await searchParams;
  return <AdminAppealQueue initialAppealId={appeal ?? null} />;
}
