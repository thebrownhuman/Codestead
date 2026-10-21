import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { BLUEPRINT_RESPONSE_KEY } from "@/app/api/exams/_lib/contracts";

// Behavioral regression suite for review findings N02, N03 and N07. The real
// exam service runs; only persistence, content and publication readers are
// replaced. Every Drizzle chain resolves through `route`, keyed by the table it
// touches, so a test controls exactly what each read returns and records every
// write the service attempts.

type Operation = {
  readonly kind: "select" | "insert" | "update" | "delete" | "execute";
  table: string | null;
  values?: unknown;
  set?: unknown;
  locked?: boolean;
};

const state = vi.hoisted(() => ({
  operations: [] as Operation[],
  route: (() => []) as (operation: Operation) => unknown,
}));

const mocks = vi.hoisted(() => ({
  listPublishedExamCourses: vi.fn(),
  listPointerSelectedCourseSlugs: vi.fn(),
  createContentRepository: vi.fn(),
  buildEquivalentExamForm: vi.fn(),
  buildTargetedMasteryRecheckForm: vi.fn(),
  verifyEquivalentFormParity: vi.fn(),
  cancelInteractive: vi.fn(),
}));

vi.mock("@/lib/runner/interactive-control", () => ({ cancelInteractiveForExam: mocks.cancelInteractive }));

vi.mock("@/lib/db/client", async () => {
  const { getTableName, is, Table } = await import("drizzle-orm");
  function tableName(value: unknown): string | null {
    return is(value, Table) ? getTableName(value) : null;
  }
  
  function chain(operation: Operation): unknown {
    state.operations.push(operation);
    const builder: Record<string, unknown> = {};
    const passthrough = [
      "innerJoin", "leftJoin", "where", "orderBy", "limit", "onConflictDoNothing",
      "onConflictDoUpdate", "returning", "groupBy",
    ];
    for (const method of passthrough) builder[method] = () => builder;
    builder.from = (table: unknown) => {
      operation.table = tableName(table);
      return builder;
    };
    builder.for = () => {
      operation.locked = true;
      return builder;
    };
    builder.values = (values: unknown) => {
      operation.values = values;
      return builder;
    };
    builder.set = (set: unknown) => {
      operation.set = set;
      return builder;
    };
    builder.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
      try {
        return Promise.resolve(state.route(operation)).then(resolve, reject);
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
    };
    return builder;
  }
  
  const executor = {
    select: () => chain({ kind: "select", table: null }),
    insert: (table: unknown) => chain({ kind: "insert", table: tableName(table) }),
    update: (table: unknown) => chain({ kind: "update", table: tableName(table) }),
    delete: (table: unknown) => chain({ kind: "delete", table: tableName(table) }),
    execute: (statement: unknown) => chain({ kind: "execute", table: null, values: statement }),
  };
  
  
  return {
    pool: { query: vi.fn(), connect: vi.fn() },
    db: {
      ...executor,
      transaction: async (callback: (tx: typeof executor) => Promise<unknown>) => callback(executor),
    },
  };
});
vi.mock("@/lib/content", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/content")>(),
  createContentRepository: mocks.createContentRepository,
}));
vi.mock("@/lib/curriculum-publication/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/curriculum-publication/runtime")>(),
  listPublishedExamCourses: mocks.listPublishedExamCourses,
  listPointerSelectedCourseSlugs: mocks.listPointerSelectedCourseSlugs,
}));
vi.mock("@/app/api/exams/_lib/blueprint", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/app/api/exams/_lib/blueprint")>(),
  buildEquivalentExamForm: mocks.buildEquivalentExamForm,
  buildTargetedMasteryRecheckForm: mocks.buildTargetedMasteryRecheckForm,
  verifyEquivalentFormParity: mocks.verifyEquivalentFormParity,
}));

import {
  listExamCatalog,
  recordExamEvent,
  startExam,
  startMasteryRecheck,
  submitExamAppeal,
} from "@/app/api/exams/_lib/service";

const userId = "learner-n03";
const sessionId = "30000000-0000-4000-8000-000000000001";
const attemptId = "40000000-0000-4000-8000-000000000001";
const courseVersionId = "20000000-0000-4000-8000-000000000001";
const enrollmentId = "50000000-0000-4000-8000-000000000001";
const recheckId = "60000000-0000-4000-8000-000000000001";
const sourceAttemptId = "40000000-0000-4000-8000-000000000009";
const now = new Date("2026-10-01T12:00:00.000Z");
const device = { viewportWidth: 1280, viewportHeight: 800, userAgent: "Regression desktop" };
const moduleId = "pf.computing";

const examModule = {
  id: moduleId, title: "Computing", description: "Programs and computers.", skills: [],
};
const examCourse = { id: "programming-foundations", title: "Programming Foundations", status: "beta", modules: [examModule] };
const form = {
  schemaVersion: 1, formId: "form-1", moduleId, courseId: examCourse.id, items: [],
  durationMinutes: 10, contentVersion: "published:v1", policyVersion: "exam-policy-v1",
  integrityDisclosure: { version: "1" },
};
const graded = {
  schemaVersion: 1, gradingStatus: "graded", finalizedAt: now.toISOString(), outcome: "PASSED",
};

function writes(table: string) {
  return state.operations.filter((operation) =>
    operation.kind !== "select" && operation.kind !== "execute" && operation.table === table);
}

function anyWrites() {
  return state.operations.filter((operation) => operation.kind === "insert" || operation.kind === "update");
}

function filesystemRepository() {
  return {
    listCourses: async () => [examCourse],
    getSnapshot: async () => ({ catalog: { version: "fs-1", tracks: [] }, courses: [examCourse], manifestPaths: {} }),
    getIndex: async () => ({
      moduleById: new Map([[moduleId, examModule]]),
      moduleCourseById: new Map([[moduleId, examCourse]]),
    }),
    listAssessmentBanks: async () => [],
  };
}

beforeEach(() => {
  state.operations.length = 0;
  state.route = () => [];
  vi.clearAllMocks();
  mocks.cancelInteractive.mockImplementation(async (actor: string) => {
    expect(actor).toBe(userId);
    expect(anyWrites()).toEqual([]);
    const latest = state.operations.filter(operation => operation.kind === "execute").at(-1);
    const query = new PgDialect().sqlToQuery(latest!.values as SQL);
    expect(query.sql).toContain("pg_advisory_xact_lock");
    expect(query.params).toEqual([`user-authority:${userId}`]);
  });
  mocks.createContentRepository.mockReturnValue(filesystemRepository());
  mocks.listPublishedExamCourses.mockResolvedValue([]);
  mocks.listPointerSelectedCourseSlugs.mockResolvedValue(new Set());
  mocks.buildEquivalentExamForm.mockReturnValue(form);
});

describe("B.2: client integrity events require an open owned session", () => {
  const event = {
    userId, sessionId, clientEventId: "81000000-0000-4000-8000-000000000001",
    type: "window_blur" as const, metadata: { target: "window" }, now,
  };

  function eventRoute(status: string, duplicate = false) {
    return (operation: Operation) => {
      if (operation.kind === "select" && operation.table === "exam_session") {
        return [{ session: { id: sessionId, status }, attempt: { id: attemptId } }];
      }
      if (operation.kind === "insert" && operation.table === "exam_event") {
        return duplicate ? [] : [{ id: "event-row" }];
      }
      return [];
    };
  }

  it.each(["scheduled", "submitted", "expired", "graded", "under_review", "invalidated"])(
    "rejects a %s session before writing an integrity event", async (status) => {
      state.route = eventRoute(status);
      await expect(recordExamEvent(event)).rejects.toMatchObject({ code: "EXAM_NOT_ACTIVE", status: 409 });
      expect(anyWrites()).toEqual([]);
    },
  );

  it.each(["active", "paused_by_system"])("accepts and deduplicates events for a %s session", async (status) => {
    state.route = eventRoute(status);
    await expect(recordExamEvent(event)).resolves.toEqual({ accepted: true, duplicate: false });
    expect(writes("exam_event")[0]?.values).toMatchObject({
      examSessionId: sessionId, clientEventId: event.clientEventId, type: event.type, occurredAt: now,
    });
    state.route = eventRoute(status, true);
    await expect(recordExamEvent(event)).resolves.toEqual({ accepted: true, duplicate: true });
  });

  it("checks the session under lock so finalization cannot race the event write", async () => {
    const base = eventRoute("active");
    state.route = (operation) => operation.kind === "select" && operation.table === "exam_session" && operation.locked
      ? [{ session: { id: sessionId, status: "submitted" }, attempt: { id: attemptId } }]
      : base(operation);
    await expect(recordExamEvent(event)).rejects.toMatchObject({ code: "EXAM_NOT_ACTIVE" });
    expect(anyWrites()).toEqual([]);
    expect(state.operations.some((operation) => operation.table === "exam_session" && operation.locked)).toBe(true);
  });

  it("rejects an unknown or unowned session without writing", async () => {
    await expect(recordExamEvent(event)).rejects.toMatchObject({ code: "EXAM_NOT_FOUND", status: 404 });
    expect(anyWrites()).toEqual([]);
  });
});

describe("N02: an appeal cannot strand an unfinished finalization", () => {
  function appealRoute(options: { result: boolean; status: string }) {
    return (operation: Operation) => {
      if (operation.kind !== "select") return [{ id: "70000000-0000-4000-8000-000000000001" }];
      switch (operation.table) {
        case "exam_session":
          return [{ session: { id: sessionId, status: options.status }, attempt: { id: attemptId } }];
        case "response":
          return [{
            itemKey: BLUEPRINT_RESPONSE_KEY,
            revision: 1,
            savedAt: now,
            answer: options.result ? { snapshot: form, result: graded } : { snapshot: form },
          }];
        default:
          return [];
      }
    };
  }

  const appeal = {
    userId,
    sessionId,
    clientRequestId: "80000000-0000-4000-8000-000000000001",
    category: "scoring" as const,
    reason: "The scoring for my second answer looks inconsistent with the rubric.",
    now,
  };

  it.each(["submitted", "expired"])(
    "rejects a %s session without a durable result and changes no state",
    async (status) => {
      state.route = appealRoute({ result: false, status });
      await expect(submitExamAppeal(appeal)).rejects.toMatchObject({ code: "APPEAL_TOO_EARLY", status: 409 });
      expect(anyWrites()).toEqual([]);
    },
  );

  it("re-checks the durable result under the session lock before any write", async () => {
    let lockedReads = 0;
    const base = appealRoute({ result: true, status: "submitted" });
    state.route = (operation) => {
      if (operation.kind === "select" && operation.table === "exam_session" && operation.locked) lockedReads += 1;
      // The result disappears from the transaction's view (for example a
      // concurrent correction rewrote it): the pre-lock read must not decide.
      if (lockedReads > 0 && operation.kind === "select" && operation.table === "response") {
        return [{ answer: { snapshot: form } }];
      }
      if (lockedReads > 0 && operation.kind === "select" && operation.table === "assessment_attempt_effective_result") {
        return [];
      }
      return base(operation);
    };
    await expect(submitExamAppeal(appeal)).rejects.toMatchObject({ code: "APPEAL_TOO_EARLY" });
    expect(anyWrites()).toEqual([]);
  });

  it("still accepts an appeal once a result is durable and moves the session to review", async () => {
    state.route = appealRoute({ result: true, status: "completed" });
    await expect(submitExamAppeal(appeal)).resolves.toMatchObject({ accepted: true, duplicate: false });
    expect(writes("appeal")).toHaveLength(1);
    expect(writes("exam_session")[0]?.set).toMatchObject({ status: "under_review" });
  });

  it("keeps a finalized PENDING_REVIEW result appealable", async () => {
    const base = appealRoute({ result: true, status: "under_review" });
    state.route = (operation) => operation.kind === "select" && operation.table === "response"
      ? [{ itemKey: BLUEPRINT_RESPONSE_KEY, revision: 1, savedAt: now, answer: {
          snapshot: form, result: { ...graded, gradingStatus: "pending-review", outcome: "PENDING_REVIEW" },
        } }]
      : base(operation);
    await expect(submitExamAppeal(appeal)).resolves.toMatchObject({ accepted: true });
  });

  it("replays a duplicate request without a second appeal", async () => {
    const base = appealRoute({ result: true, status: "under_review" });
    state.route = (operation) => operation.kind === "select" && operation.table === "appeal"
      ? [{ id: "appeal-1", attemptId, category: appeal.category, reason: appeal.reason }]
      : base(operation);
    await expect(submitExamAppeal(appeal)).resolves.toEqual({
      accepted: true, duplicate: true, appealId: "appeal-1",
    });
    expect(anyWrites()).toEqual([]);
  });

  it("still rejects active and scheduled sessions", async () => {
    state.route = appealRoute({ result: false, status: "active" });
    await expect(submitExamAppeal(appeal)).rejects.toMatchObject({ code: "APPEAL_TOO_EARLY" });
    expect(anyWrites()).toEqual([]);
  });
});

describe("N07: a pointer-selected but exam-ineligible publication cannot fall back to disk", () => {
  it("omits the course from the exam catalog", async () => {
    mocks.listPointerSelectedCourseSlugs.mockResolvedValue(new Set([examCourse.id]));
    const catalog = await listExamCatalog(userId, now);
    expect(catalog.map((entry) => entry.courseId)).not.toContain(examCourse.id);
  });

  it("refuses admission before building a form or writing anything", async () => {
    mocks.listPointerSelectedCourseSlugs.mockResolvedValue(new Set([examCourse.id]));
    await expect(startExam(userId, {
      moduleId, integrityDisclosureAccepted: true, readinessAcknowledged: true, device,
    }, now)).rejects.toMatchObject({ code: "MODULE_NOT_EXAM_READY", status: 404 });
    expect(mocks.buildEquivalentExamForm).not.toHaveBeenCalled();
    expect(anyWrites()).toEqual([]);
  });

  it("keeps filesystem courses that no publication pointer selects", async () => {
    const catalog = await listExamCatalog(userId, now);
    expect(catalog.map((entry) => entry.moduleId)).toEqual([moduleId]);
  });
});

describe("N03: formal attempts bind the learner's enrollment for the assessed version", () => {
  function publishedAdmissionRoute(enrollments: readonly unknown[]) {
    return (operation: Operation) => {
      if (operation.kind === "select" && operation.table === "enrollment") return enrollments;
      if (operation.kind === "insert") return [{ id: `${operation.table}-id` }];
      return [];
    };
  }

  beforeEach(() => {
    vi.stubEnv("CODE_RUNNER_PROVIDER", "piston");
    vi.stubEnv("PISTON_URL", "http://piston:2000");
    vi.stubEnv("PISTON_IMAGE", `codestead-piston@sha256:${"a".repeat(64)}`);
    mocks.listPublishedExamCourses.mockResolvedValue([{
      courseVersionId, course: examCourse, assessmentBanks: [],
    }]);
    mocks.listPointerSelectedCourseSlugs.mockResolvedValue(new Set([examCourse.id]));
  });
  afterEach(() => vi.unstubAllEnvs());

  async function admit() {
    // getExamSession after admission reads the created session; the empty
    // fixture makes it report not-found, after every admission write.
    await expect(startExam(userId, {
      moduleId, integrityDisclosureAccepted: true, readinessAcknowledged: true, device,
    }, now)).rejects.toMatchObject({ code: "EXAM_NOT_FOUND" });
    return writes("attempt")[0];
  }

  it("binds the owned active enrollment for the published course version", async () => {
    state.route = publishedAdmissionRoute([{ id: enrollmentId }]);
    const inserted = await admit();
    expect(inserted?.values).toMatchObject({ userId, kind: "exam", enrollmentId });
    const enrollmentRead = state.operations.find((operation) =>
      operation.kind === "select" && operation.table === "enrollment");
    expect(enrollmentRead?.locked).toBe(true);
    expect(mocks.cancelInteractive).toHaveBeenCalledOnce();
  });

  it("does not create an exam if interactive cleanup cannot be confirmed", async () => {
    state.route = publishedAdmissionRoute([{ id: enrollmentId }]);
    mocks.cancelInteractive.mockRejectedValueOnce(new Error("CANCELLATION_UNCONFIRMED"));
    await expect(startExam(userId, { moduleId, integrityDisclosureAccepted: true, readinessAcknowledged: true, device }, now))
      .rejects.toMatchObject({ status: 503, code: "INTERACTIVE_CANCELLATION_REQUIRED" });
    expect(anyWrites()).toEqual([]);
  });

  it("leaves the attempt unbound when the learner has no enrollment for that version", async () => {
    state.route = publishedAdmissionRoute([]);
    const inserted = await admit();
    expect(inserted?.values).toMatchObject({ userId, kind: "exam", enrollmentId: null });
  });

  it("does not bind any enrollment for an unpublished filesystem admission", async () => {
    mocks.listPublishedExamCourses.mockResolvedValue([]);
    mocks.listPointerSelectedCourseSlugs.mockResolvedValue(new Set());
    state.route = publishedAdmissionRoute([{ id: enrollmentId }]);
    const inserted = await admit();
    expect(inserted?.values).toMatchObject({ enrollmentId: null });
    expect(state.operations.some((operation) => operation.table === "enrollment")).toBe(false);
  });

  it("binds the same enrollment on a mastery recheck attempt", async () => {
    const schedule = {
      id: recheckId, userId, moduleId, status: "available", dueAt: new Date(now.getTime() - 1),
      recheckAttemptId: null, sourceAttemptId, contentVersion: form.contentVersion,
      policyVersion: form.policyVersion, targetClusterIds: ["c1"], targetCodingItemIds: [],
    };
    mocks.buildTargetedMasteryRecheckForm.mockReturnValue(form);
    mocks.verifyEquivalentFormParity.mockReturnValue({
      equivalent: true, sourceBlueprintHash: "a", candidateBlueprintHash: "b", issues: [],
    });
    state.route = (operation) => {
      if (operation.kind === "insert") return [{ id: `${operation.table}-id` }];
      if (operation.kind !== "select") return [];
      switch (operation.table) {
        case "exam_mastery_recheck":
          return [schedule];
        case "attempt":
          return [{
            id: sourceAttemptId, kind: "exam", passed: true,
            policyVersion: form.policyVersion, contentVersion: form.contentVersion,
          }];
        case "response":
          return [{ answer: { snapshot: form, result: {
            ...graded, masteryRecheck: { required: true, clusterIds: ["c1"], codingItemIds: [] },
          } } }];
        case "enrollment":
          return [{ id: enrollmentId }];
        default:
          return [];
      }
    };
    await expect(startMasteryRecheck(userId, recheckId, {
      moduleId, integrityDisclosureAccepted: true, readinessAcknowledged: true, device,
    }, now)).rejects.toMatchObject({ code: "EXAM_NOT_FOUND" });
    expect(writes("attempt")[0]?.values).toMatchObject({ kind: "mastery_check", enrollmentId });
    expect(mocks.cancelInteractive).toHaveBeenCalledOnce();
  });
});
