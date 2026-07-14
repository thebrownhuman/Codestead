import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { examEvent, examSession } from "@/lib/db/schema";

export type ClosedBookCapability =
  | "ai_tutor"
  | "general_code_runner"
  | "practice_game"
  | "learner_files"
  | "project_workspace"
  | "learning_workspace";

export type ExamCapabilityDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: "EXAM_CLOSED_BOOK" | "EXAM_STATE_UNAVAILABLE";
      readonly status: 423 | 503;
      readonly message: string;
    };

/**
 * The browser is not an exam security boundary. Every non-exam capability
 * that could provide help must ask the server-authoritative exam state before
 * doing work. Status is intentionally enough; the learner does not receive an
 * exam identifier or hidden timing metadata from this gate.
 */
export async function gateClosedBookCapability(
  userId: string,
  capability: ClosedBookCapability,
): Promise<ExamCapabilityDecision> {
  try {
    const [active] = await db
      .select({ id: examSession.id, status: examSession.status })
      .from(examSession)
      .where(and(
        eq(examSession.userId, userId),
        inArray(examSession.status, ["active", "paused_by_system"]),
      ))
      .limit(1);
    if (!active) return { allowed: true };
    // Coalesce repeated retries to one integrity event per capability/minute.
    // This preserves useful evidence without making the evidence table an
    // authenticated write-amplification target before route rate limits run.
    const minuteBucket = Math.floor(Date.now() / 60_000);
    await db
      .insert(examEvent)
      .values({
        examSessionId: active.id,
        clientEventId: `blocked-capability:${capability}:${minuteBucket}`,
        type: "blocked_capability_attempt",
        metadata: { capability },
      })
      .onConflictDoNothing({
        target: [examEvent.examSessionId, examEvent.clientEventId],
      });
    return {
      allowed: false,
      code: "EXAM_CLOSED_BOOK",
      status: 423,
      message: "This capability is locked while your closed-book exam is active. Return to the exam workspace.",
    };
  } catch {
    // Failing open would turn a database outage into an exam-help bypass.
    return {
      allowed: false,
      code: "EXAM_STATE_UNAVAILABLE",
      status: 503,
      message: "Exam state could not be verified, so this capability is temporarily locked.",
    };
  }
}
