import { and, asc, eq, lt, lte } from "drizzle-orm";

import { db, pool } from "../src/lib/db/client";
import { emailOutbox } from "../src/lib/db/schema";
import { sendEmail } from "../src/lib/notifications/mailer";
import { scheduleInactivityReminders } from "../src/lib/notifications/inactivity";
import type { EmailTemplate } from "../src/lib/notifications/outbox";
import { materializeDeliveryVariables } from "../src/lib/notifications/delivery-variables";
import { scheduleSmartReminders } from "../src/lib/notifications/smart-reminders";
import { createWorkerHealthReporter } from "./lib/worker-health";

let healthReporter: ReturnType<typeof createWorkerHealthReporter> | undefined;

async function processBatch(limit = 10) {
  const now = new Date();
  // Recover rows claimed by a worker that died before completing delivery.
  // Delivery is intentionally at-least-once; provider message IDs should be
  // retained by a future adapter if stronger de-duplication becomes available.
  await db
    .update(emailOutbox)
    .set({ status: "pending", nextAttemptAt: now, lastErrorCode: "WORKER_LEASE_EXPIRED" })
    .where(
      and(
        eq(emailOutbox.status, "sending"),
        lt(emailOutbox.updatedAt, new Date(now.getTime() - 10 * 60_000)),
      ),
    );
  const candidates = await db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.status, "pending"), lte(emailOutbox.nextAttemptAt, now)))
    .orderBy(asc(emailOutbox.createdAt))
    .limit(limit);
  let sent = 0;
  for (const candidate of candidates) {
    const [claimed] = await db
      .update(emailOutbox)
      .set({ status: "sending", attemptCount: candidate.attemptCount + 1 })
      .where(and(eq(emailOutbox.id, candidate.id), eq(emailOutbox.status, "pending")))
      .returning({ id: emailOutbox.id });
    if (!claimed) continue;
    try {
      const variables = await materializeDeliveryVariables({
        template: candidate.template as EmailTemplate,
        variables: candidate.variables,
        now,
      });
      if (!variables) {
        await db
          .update(emailOutbox)
          .set({
            status: "suppressed",
            lastErrorCode: "DELIVERY_PROOF_UNAVAILABLE",
          })
          .where(eq(emailOutbox.id, candidate.id));
        continue;
      }
      await sendEmail({
        to: candidate.toEmail,
        template: candidate.template as EmailTemplate,
        variables,
      });
      await db
        .update(emailOutbox)
        .set({ status: "sent", sentAt: new Date(), lastErrorCode: null })
        .where(eq(emailOutbox.id, candidate.id));
      sent += 1;
    } catch (error) {
      const attempts = candidate.attemptCount + 1;
      const retry = attempts < 8;
      await db
        .update(emailOutbox)
        .set({
          status: retry ? "pending" : "failed",
          nextAttemptAt: new Date(Date.now() + Math.min(6 * 60 * 60_000, 30_000 * 2 ** attempts)),
          lastErrorCode: error instanceof Error ? error.name.slice(0, 80) : "UNKNOWN",
        })
        .where(eq(emailOutbox.id, candidate.id));
    }
  }
  return { claimed: candidates.length, sent };
}

async function main() {
  const pollSeconds = Number.parseInt(process.env.OUTBOX_POLL_SECONDS ?? "10", 10);
  if (!Number.isInteger(pollSeconds) || pollSeconds < 1 || pollSeconds > 3_600) {
    throw new Error("OUTBOX_POLL_SECONDS must be an integer from 1 to 3600.");
  }
  const inactivityScheduleSeconds = Number.parseInt(
    process.env.INACTIVITY_SCHEDULE_SECONDS ?? "60",
    10,
  );
  if (!Number.isInteger(inactivityScheduleSeconds) || inactivityScheduleSeconds < 10 || inactivityScheduleSeconds > 3_600) {
    throw new Error("INACTIVITY_SCHEDULE_SECONDS must be an integer from 10 to 3600.");
  }
  const once = process.argv.includes("--once");
  healthReporter = createWorkerHealthReporter({ worker: "mail-worker" });
  let lastInactivityScheduleAt = 0;
  let lastSmartReminderScheduleAt = 0;
  do {
    const scheduleAt = Date.now();
    if (scheduleAt - lastInactivityScheduleAt >= inactivityScheduleSeconds * 1_000) {
      const schedule = await scheduleInactivityReminders(new Date(scheduleAt));
      lastInactivityScheduleAt = scheduleAt;
      console.info(JSON.stringify({ event: "inactivity.schedule", ...schedule }));
    }
    if (scheduleAt - lastSmartReminderScheduleAt >= inactivityScheduleSeconds * 1_000) {
      const schedule = await scheduleSmartReminders(new Date(scheduleAt));
      lastSmartReminderScheduleAt = scheduleAt;
      console.info(JSON.stringify({ event: "smart_reminder.schedule", ...schedule }));
    }
    const result = await processBatch();
    console.info(JSON.stringify({ event: "email.outbox_batch", ...result }));
    healthReporter.success();
    if (once) break;
    await new Promise((resolve) =>
      setTimeout(resolve, result.claimed ? 1_000 : pollSeconds * 1_000),
    );
  } while (true);
}

main()
  .catch((error) => {
    healthReporter?.retry(error);
    healthReporter?.terminalFailure(error);
    console.error(JSON.stringify({ event: "email.worker_failed", code: error instanceof Error ? error.name : "UNKNOWN" }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
