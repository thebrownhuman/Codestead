import { enqueueEmail } from "@/lib/notifications/outbox";

import type { LearnerStorageQuota } from "./admin-quota";

export async function emailStorageQuotaChanged(
  quota: LearnerStorageQuota,
  idempotencySeed: string,
) {
  await enqueueEmail({
    to: quota.learnerEmail,
    userId: quota.learnerUserId,
    template: "storage-quota-changed",
    variables: {
      name: quota.learnerName,
      quota: `${(quota.quotaBytes / 1024 ** 3).toFixed(2)} GiB`,
      url: `${process.env.APP_URL ?? "http://localhost:3000"}/projects`,
    },
    idempotencySeed,
  });
}
