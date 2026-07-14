import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import { user } from "@/lib/db/schema";
import {
  DraftIdempotencyMismatchError,
  DraftScopeUnavailableError,
  DraftVersionConflictError,
  PostgresLearnerDraftRepository,
} from "@/lib/drafts/repository";

const FIRST_USER = "draft-sync-learner-one";
const SECOND_USER = "draft-sync-learner-two";
const key = { kind: "code" as const, courseId: "python", skillId: "python.variables", language: "python" };

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Learner draft integration requires the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const names = result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await truncateApplicationTables();
  await db.insert(user).values([
    {
      id: FIRST_USER,
      publicId: "d1000000-0000-4000-8000-000000000001",
      name: "Draft Learner One",
      email: "draft-one@integration.invalid",
      role: "learner",
      status: "active",
    },
    {
      id: SECOND_USER,
      publicId: "d1000000-0000-4000-8000-000000000002",
      name: "Draft Learner Two",
      email: "draft-two@integration.invalid",
      role: "learner",
      status: "active",
    },
  ]);
  await pool.query(
    `insert into course (id,slug,title,summary,domain)
       values ('d0100000-0000-4000-8000-000000000001','python','Python','Published draft test course.','programming');
     insert into course_version (id,course_id,version,stage,scope_statement,content_hash,published_at)
       values ('d0100000-0000-4000-8000-000000000002','d0100000-0000-4000-8000-000000000001','1.0.0','beta','Disposable published scope.','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',now());
     insert into course_module (id,course_version_id,slug,title,objective,position,estimated_minutes)
       values ('d0100000-0000-4000-8000-000000000003','d0100000-0000-4000-8000-000000000002','variables','Variables','Use variables.',1,10);
     insert into concept (id,slug,title,domain,description)
       values ('d0100000-0000-4000-8000-000000000004','python.variables','Python variables','programming','Published variable concept.');
     insert into lesson (id,module_id,slug,title,objective,estimated_minutes,difficulty,position,content_status)
       values ('d0100000-0000-4000-8000-000000000005','d0100000-0000-4000-8000-000000000003','variables','Variables','Use variables.',10,'beginner',1,'beta');
     insert into lesson_concept (lesson_id,concept_id,coverage,weight)
       values ('d0100000-0000-4000-8000-000000000005','d0100000-0000-4000-8000-000000000004','primary',1);
     insert into enrollment (user_id,course_version_id,status,source,started_at)
       values ('draft-sync-learner-one','d0100000-0000-4000-8000-000000000002','active','test',now()),
              ('draft-sync-learner-two','d0100000-0000-4000-8000-000000000002','active','test',now());
     insert into course (id,slug,title,summary,domain)
       values ('d0100000-0000-4000-8000-000000000011','dsa','DSA','Published DSA draft test course.','computer-science');
     insert into course_version (id,course_id,version,stage,scope_statement,content_hash,published_at)
       values ('d0100000-0000-4000-8000-000000000012','d0100000-0000-4000-8000-000000000011','1.0.0','beta','Disposable DSA scope.','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',now());
     insert into course_module (id,course_version_id,slug,title,objective,position,estimated_minutes)
       values ('d0100000-0000-4000-8000-000000000013','d0100000-0000-4000-8000-000000000012','arrays','Arrays','Implement arrays.',1,10);
     insert into concept (id,slug,title,domain,description)
       values ('d0100000-0000-4000-8000-000000000014','dsa.arrays','DSA arrays','computer-science','Published DSA array concept.');
     insert into lesson (id,module_id,slug,title,objective,estimated_minutes,difficulty,position,content_status)
       values ('d0100000-0000-4000-8000-000000000015','d0100000-0000-4000-8000-000000000013','arrays','Arrays','Implement arrays.',10,'beginner',1,'beta');
     insert into lesson_concept (lesson_id,concept_id,coverage,weight)
       values ('d0100000-0000-4000-8000-000000000015','d0100000-0000-4000-8000-000000000014','primary',1);
     insert into enrollment (user_id,course_version_id,implementation_language,status,source,started_at)
       values ('draft-sync-learner-one','d0100000-0000-4000-8000-000000000012','C++','active','test',now())`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("authoritative learner draft PostgreSQL contract", () => {
  it("persists code and lesson drafts independently for the session-derived owner", async () => {
    const repository = new PostgresLearnerDraftRepository();
    const code = await repository.save({
      userId: FIRST_USER,
      ...key,
      content: "answer = 42\n",
      expectedRowVersion: 0,
      requestId: "d2000000-0000-4000-8000-000000000001",
    });
    const lesson = await repository.save({
      userId: FIRST_USER,
      kind: "lesson",
      courseId: "python",
      skillId: "python.variables",
      language: null,
      content: "My own explanation of variables.",
      expectedRowVersion: 0,
      requestId: "d2000000-0000-4000-8000-000000000002",
    });
    const otherLearner = await repository.save({
      userId: SECOND_USER,
      ...key,
      content: "private = 'second learner'\n",
      expectedRowVersion: 0,
      requestId: "d2000000-0000-4000-8000-000000000003",
    });

    expect(code.draft).toMatchObject({ rowVersion: 1, content: "answer = 42\n" });
    expect(lesson.draft).toMatchObject({ kind: "lesson", language: null, rowVersion: 1 });
    expect(otherLearner.draft.id).not.toBe(code.draft.id);
    await expect(repository.load(FIRST_USER, key)).resolves.toMatchObject({ content: "answer = 42\n" });
    await expect(repository.load(SECOND_USER, key)).resolves.toMatchObject({ content: "private = 'second learner'\n" });
  });

  it("persists the exact platform playground scratchpad without enrollment and keeps owners isolated", async () => {
    await pool.query(`delete from enrollment where user_id in ($1, $2)`, [FIRST_USER, SECOND_USER]);
    const repository = new PostgresLearnerDraftRepository();
    const playground = {
      kind: "code" as const,
      courseId: "python",
      skillId: "free-playground",
      language: "python",
    };
    await repository.save({
      userId: FIRST_USER,
      ...playground,
      content: "owner = 'first'\n",
      expectedRowVersion: 0,
      requestId: "d2000000-0000-4000-8000-000000000021",
    });
    await repository.save({
      userId: SECOND_USER,
      ...playground,
      content: "owner = 'second'\n",
      expectedRowVersion: 0,
      requestId: "d2000000-0000-4000-8000-000000000022",
    });

    await expect(repository.load(FIRST_USER, playground)).resolves.toMatchObject({ content: "owner = 'first'\n" });
    await expect(repository.load(SECOND_USER, playground)).resolves.toMatchObject({ content: "owner = 'second'\n" });
    await expect(repository.load(FIRST_USER, { ...playground, language: "cpp" }))
      .rejects.toBeInstanceOf(DraftScopeUnavailableError);
  });

  it("authorizes only the active C, C++, Java, or Python DSA runner alias", async () => {
    const repository = new PostgresLearnerDraftRepository();
    const common = { kind: "code" as const, courseId: "dsa", skillId: "dsa.arrays" };
    const cases = [
      { stored: "C++", runner: "cpp", content: "std::vector<int> values;\n", request: "d2000000-0000-4000-8000-000000000011" },
      { stored: "C", runner: "c", content: "int values[8];\n", request: "d2000000-0000-4000-8000-000000000012" },
      { stored: "Java", runner: "java", content: "int[] values = new int[8];\n", request: "d2000000-0000-4000-8000-000000000013" },
      { stored: "Python", runner: "python", content: "values: list[int] = []\n", request: "d2000000-0000-4000-8000-000000000014" },
    ] as const;

    for (const item of cases) {
      await pool.query(
        `update enrollment e
            set implementation_language = $2, updated_at = now()
           from course_version cv, course co
          where e.user_id = $1 and e.course_version_id = cv.id
            and cv.course_id = co.id and co.slug = 'dsa'`,
        [FIRST_USER, item.stored],
      );
      await repository.save({
        userId: FIRST_USER,
        ...common,
        language: item.runner,
        content: item.content,
        expectedRowVersion: 0,
        requestId: item.request,
      });
      await expect(repository.load(FIRST_USER, { ...common, language: item.runner }))
        .resolves.toMatchObject({ content: item.content, language: item.runner });
    }

    for (const oldLanguage of ["cpp", "c", "java"] as const) {
      await expect(repository.load(FIRST_USER, { ...common, language: oldLanguage }))
        .rejects.toBeInstanceOf(DraftScopeUnavailableError);
    }
  });

  it("uses the DSA profile language only for an enrolled legacy row with no language", async () => {
    const repository = new PostgresLearnerDraftRepository();
    const common = { kind: "code" as const, courseId: "dsa", skillId: "dsa.arrays" };
    await pool.query(
      `update enrollment e
          set implementation_language = null, updated_at = now()
         from course_version cv, course co
        where e.user_id = $1 and e.course_version_id = cv.id
          and cv.course_id = co.id and co.slug = 'dsa'`,
      [FIRST_USER],
    );
    await pool.query(
      `insert into learner_profile (user_id, selected_tracks, dsa_language)
       values ($1, '["dsa"]'::jsonb, 'C++')`,
      [FIRST_USER],
    );

    await expect(repository.save({
      userId: FIRST_USER,
      ...common,
      language: "cpp",
      content: "std::vector<int> fallback;\n",
      expectedRowVersion: 0,
      requestId: "d2000000-0000-4000-8000-000000000015",
    })).resolves.toMatchObject({ draft: { language: "cpp" } });
    await expect(repository.load(FIRST_USER, { ...common, language: "python" }))
      .rejects.toBeInstanceOf(DraftScopeUnavailableError);
  });

  it("replays an accepted old request after newer work without duplicating or overwriting", async () => {
    const repository = new PostgresLearnerDraftRepository();
    const firstInput = {
      userId: FIRST_USER,
      ...key,
      content: "version = 1\n",
      expectedRowVersion: 0,
      requestId: "d3000000-0000-4000-8000-000000000001",
    } as const;
    const first = await repository.save(firstInput);
    const second = await repository.save({
      ...firstInput,
      content: "version = 2\n",
      expectedRowVersion: 1,
      requestId: "d3000000-0000-4000-8000-000000000002",
    });
    const replay = await repository.save(firstInput);

    expect(first).toMatchObject({ replayed: false, committedRowVersion: 1 });
    expect(second).toMatchObject({ replayed: false, committedRowVersion: 2 });
    expect(replay).toMatchObject({
      replayed: true,
      committedRowVersion: 1,
      draft: { rowVersion: 2, content: "version = 2\n" },
    });
    const counts = await pool.query<{ drafts: string; receipts: string }>(`
      select
        (select count(*) from learner_draft)::text as drafts,
        (select count(*) from learner_draft_mutation)::text as receipts
    `);
    expect(counts.rows[0]).toEqual({ drafts: "1", receipts: "2" });
  });

  it("rejects request-id reuse with different input and preserves current work", async () => {
    const repository = new PostgresLearnerDraftRepository();
    const requestId = "d4000000-0000-4000-8000-000000000001";
    await repository.save({
      userId: FIRST_USER,
      ...key,
      content: "safe = 1\n",
      expectedRowVersion: 0,
      requestId,
    });
    await expect(repository.save({
      userId: FIRST_USER,
      ...key,
      content: "overwrite = true\n",
      expectedRowVersion: 1,
      requestId,
    })).rejects.toBeInstanceOf(DraftIdempotencyMismatchError);
    await expect(repository.load(FIRST_USER, key)).resolves.toMatchObject({
      content: "safe = 1\n",
      rowVersion: 1,
    });
  });

  it("allows exactly one concurrent optimistic update and reports the winner to the loser", async () => {
    const repository = new PostgresLearnerDraftRepository();
    await repository.save({
      userId: FIRST_USER,
      ...key,
      content: "base = 1\n",
      expectedRowVersion: 0,
      requestId: "d5000000-0000-4000-8000-000000000001",
    });
    const results = await Promise.allSettled([
      repository.save({
        userId: FIRST_USER,
        ...key,
        content: "winner = 'a'\n",
        expectedRowVersion: 1,
        requestId: "d5000000-0000-4000-8000-000000000002",
      }),
      repository.save({
        userId: FIRST_USER,
        ...key,
        content: "winner = 'b'\n",
        expectedRowVersion: 1,
        requestId: "d5000000-0000-4000-8000-000000000003",
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = rejected[0]?.status === "rejected" ? rejected[0].reason : null;
    expect(error).toBeInstanceOf(DraftVersionConflictError);
    expect((error as DraftVersionConflictError).current).toMatchObject({ rowVersion: 2 });
    const current = await repository.load(FIRST_USER, key);
    expect(current?.rowVersion).toBe(2);
    expect(["winner = 'a'\n", "winner = 'b'\n"]).toContain(current?.content);
  });

  it("database quota trigger serializes concurrent inserts at the account record limit", async () => {
    await pool.query(
      `insert into learner_draft (user_id,kind,course_id,skill_id,language,content)
       select $1,'code','python','quota.' || n::text,'python','x'
         from generate_series(1,511) n`,
      [FIRST_USER],
    );
    const results = await Promise.allSettled([
      pool.query(
        `insert into learner_draft (user_id,kind,course_id,skill_id,language,content)
         values ($1,'code','python','quota.concurrent.a','python','a')`,
        [FIRST_USER],
      ),
      pool.query(
        `insert into learner_draft (user_id,kind,course_id,skill_id,language,content)
         values ($1,'code','python','quota.concurrent.b','python','b')`,
        [FIRST_USER],
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({ code: "23514" });
    expect((await pool.query<{ count: string }>(
      `select count(*)::text as count from learner_draft where user_id = $1`,
      [FIRST_USER],
    )).rows[0]?.count).toBe("512");
  });

  it("cascades drafts and idempotency receipts with account deletion", async () => {
    const repository = new PostgresLearnerDraftRepository();
    await repository.save({
      userId: FIRST_USER,
      ...key,
      content: "delete_me = true\n",
      expectedRowVersion: 0,
      requestId: "d6000000-0000-4000-8000-000000000001",
    });
    await pool.query(`delete from "user" where id = $1`, [FIRST_USER]);
    const counts = await pool.query<{ drafts: string; receipts: string }>(`
      select
        (select count(*) from learner_draft)::text as drafts,
        (select count(*) from learner_draft_mutation)::text as receipts
    `);
    expect(counts.rows[0]).toEqual({ drafts: "0", receipts: "0" });
  });

  it("enforces byte, kind, version, hash, ownership, and uniqueness constraints in PostgreSQL", async () => {
    const constraints = await pool.query<{ conname: string }>(`
      select conname
      from pg_constraint
      where conrelid in ('learner_draft'::regclass, 'learner_draft_mutation'::regclass)
    `);
    expect(constraints.rows.map((row) => row.conname)).toEqual(expect.arrayContaining([
      "learner_draft_content_size",
      "learner_draft_kind_check",
      "learner_draft_kind_language_check",
      "learner_draft_row_version_positive",
      "learner_draft_mutation_hash_shape",
      "learner_draft_mutation_version_transition",
      "learner_draft_user_id_user_id_fk",
      "learner_draft_mutation_draft_id_learner_draft_id_fk",
    ]));
    await expect(pool.query(
      `insert into learner_draft (user_id, kind, course_id, skill_id, language, content)
       values ($1, 'code', 'python', 'oversized', 'python', $2)`,
      [FIRST_USER, "😀".repeat(40_000)],
    )).rejects.toMatchObject({ code: "23514" });
  });
});
