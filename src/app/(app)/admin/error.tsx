"use client";

import { ErrorState } from "@/components/admin/status-pill";

export default function AdminError({ reset }: { readonly reset: () => void }) {
  return <ErrorState message="The protected administrator route could not be rendered." onRetry={reset} />;
}
