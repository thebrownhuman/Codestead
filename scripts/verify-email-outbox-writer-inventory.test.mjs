#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_WRITERS,
  LIMITS,
  analyzeAstSource,
  createBoundedReader,
  listRepositoryPaths,
  parseGitPathOutput,
  validateRepositoryPath,
  verifyRoutineCatalogModel,
  verifyWriterInventory,
} from "./verify-email-outbox-writer-inventory.mjs";

function fixtureRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "codestead-writer-inventory-"));
}

function write(root, relativePath, source) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source);
}

function exactRawPgWriter(functionName) {
  return `import type { PoolClient } from "pg";
   export async function ${functionName}(client: PoolClient) {
     await client.query("begin");
     const inserted = await client.query(
       \`insert into email_outbox (id) values ($1)
         on conflict (id) do nothing
         returning id, operation_id, idempotency_authority_sha256,
                   idempotency_original_payload_sha256,
                   delivery_hold_version\`,
       [1],
     );
     const release = inserted.rows[0];
     if (release) {
       await client.query(
         \`select * from public.release_email_outbox_delivery(
            $1::uuid, $2::uuid, $3::text, $4::text, $5::text
          )\`,
         [
           release.id,
           release.operation_id,
           release.idempotency_authority_sha256,
           release.idempotency_original_payload_sha256,
           release.delivery_hold_version,
         ],
       );
     }
     await client.query("commit");
   }`;
}
function exactFixture(root) {
  const files = new Map([
    ["src/lib/appeals/admin-service.ts", exactRawPgWriter("decideAppeal")],
    ["src/lib/assessment-corrections/worker.ts", exactRawPgWriter("persistOutcome")],
    ["src/lib/data-lifecycle/deletion.ts", exactRawPgWriter("deleteLearnerAccount")],
    ["src/lib/notifications/inactivity.ts", exactRawPgWriter("persistEmail")],
    [
      "src/lib/notifications/outbox.ts",
      `import { db as database } from "@/lib/db/client";
       import { sql as statement } from "drizzle-orm";
       type OutboxTransaction =
         Parameters<Parameters<typeof database.transaction>[0]>[0];
       function queuedEmailInsert(value: string) {
         return statement\`insert into public.email_outbox (id) values (\${value})
           on conflict (id) do nothing
           returning id, operation_id, idempotency_authority_sha256,
                     idempotency_original_payload_sha256,
                     delivery_hold_version\`;
       }
       async function persistQueuedEmail(
         tx: OutboxTransaction,
       ) {
         const inserted = await tx.execute(queuedEmailInsert("1"));
         const release = inserted.rows[0];
         if (!release) return;
         await tx.execute(statement\`
           select * from public.release_email_outbox_delivery(
             \${release.id},
             \${release.operation_id},
             \${release.idempotency_authority_sha256},
             \${release.idempotency_original_payload_sha256},
             \${release.delivery_hold_version}
           )
         \`);
       }
       export async function enqueueEmailInTransaction(
         tx: OutboxTransaction,
       ) {
         await persistQueuedEmail(tx);
       }
       export async function enqueueEmail() {
         await database.transaction((tx) => persistQueuedEmail(tx));
       }`,
    ],
    [
      "scripts/backup/enqueue-backup-status.mjs",
      `import { Pool as PgPool } from "pg";
       async function runWithinDeadline(action) { return action(); }
       export async function enqueueBackupStatus(input, dependencies = {}) {
         const createPool =
           dependencies.createPool ?? ((options) => new PgPool(options));
         const pool = createPool({});
         const client = await runWithinDeadline(() => pool.connect());
         return client.query(
           \`select * from public.enqueue_backup_status_mail_authority($1, $2)\`,
           [input.runKey, input.outcome],
         );
       }`,
    ],
  ]);
  for (const [relativePath, source] of files) write(root, relativePath, source);
  return [...files.keys()].sort();
}

function expectInventoryFailure(root, paths, pattern) {
  assert.throws(
    () => verifyWriterInventory({ repositoryRoot: root, paths }),
    pattern,
  );
}

test("accepts exactly five release-composed runtime sinks and one delegated edge", () => {
  const root = fixtureRoot();
  try {
    const paths = exactFixture(root);
    assert.equal(paths.length, EXPECTED_WRITERS.length);
    assert.deepEqual(verifyWriterInventory({ repositoryRoot: root, paths }), {
      delegatedEdges: 1,
      runtimeWriters: 5,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("requires every physical runtime writer to compose the 0069 release", () => {
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/appeals/admin-service.ts",
        `import type { PoolClient } from "pg";
         export async function decideAppeal(client: PoolClient) {
           await client.query("begin");
           await client.query(
             \`insert into email_outbox (id) values ($1)
               returning id, operation_id, idempotency_authority_sha256,
                         idempotency_original_payload_sha256,
                         delivery_hold_version\`,
             [1],
           );
           await client.query("commit");
         }`,
      ),
    /release-composition/u,
  );
});
test("rejects post-commit, recomputed, wrong-client, incomplete, and unbounded releases", () => {
  const exact = exactRawPgWriter("decideAppeal");
  assert.equal(analyzeAstSource("src/lib/appeals/admin-service.ts", exact).length, 1);

  const postCommit = exact.replace(
    "     if (release) {",
    '     await client.query("commit");\n     if (release) {',
  );
  const recomputedDigest = exact.replace(
    "           release.idempotency_authority_sha256,",
    "           sha256(release.idempotency_authority_sha256),",
  );
  const wrongClient = exact
    .replace("(client: PoolClient)", "(client: PoolClient, other: PoolClient)")
    .replace(
      "       await client.query(\n         `select * from",
      "       await other.query(\n         `select * from",
    );
  const incompleteReturning = exact.replace(
    "                   idempotency_original_payload_sha256,\n",
    "",
  );
  const noTransaction = exact.replace('     await client.query("begin");\n', "");

  for (const [caseName, source] of [
    ["post-commit", postCommit],
    ["recomputed digest", recomputedDigest],
    ["wrong client", wrongClient],
    ["incomplete RETURNING", incompleteReturning],
    ["missing transaction", noTransaction],
  ]) {
    assert.notEqual(source, exact, caseName);
    assert.throws(
      () => analyzeAstSource("src/lib/appeals/admin-service.ts", source),
      /release-composition/u,
      caseName,
    );
  }
});
test("a nondominating release-row guard cannot authorize delivery", () => {
  const exact = exactRawPgWriter("decideAppeal");
  const nondominating = exact
    .replace(
      "     if (release) {\n       await client.query(",
      "     if (false) {\n       if (!release) return;\n     }\n     await client.query(",
    )
    .replace(
      '       );\n     }\n     await client.query("commit");',
      '       );\n     await client.query("commit");',
    );
  assert.notEqual(nondominating, exact);
  assert.throws(
    () => analyzeAstSource("src/lib/appeals/admin-service.ts", nondominating),
    /release-composition/u,
  );
});

test("a conditional transaction control cannot bound an unconditional writer", () => {
  const exact = exactRawPgWriter("decideAppeal");
  const conditionalBegin = exact.replace(
    '     await client.query("begin");',
    '     if (false) {\n       await client.query("begin");\n     }',
  );
  assert.notEqual(conditionalBegin, exact);
  assert.throws(
    () => analyzeAstSource("src/lib/appeals/admin-service.ts", conditionalBegin),
    /release-composition/u,
  );
});
test("zero-argument application execute callbacks are not SQL executors", () => {
  assert.deepEqual(
    analyzeAstSource(
      "src/lib/ai/provider-operation-idempotency.ts",
      `export async function run(input: { execute(): Promise<void> }) {
         await input.execute();
       }`,
    ),
    [],
  );
});
test("a receiver merely named client cannot satisfy a physical writer", () => {
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/appeals/admin-service.ts",
        `export async function decideAppeal(client: any) {
           await client.query("insert into email_outbox (id) values (1)");
         }`,
      ),
    /untrusted-sql-receiver/u,
  );
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/appeals/admin-service.ts",
        `import type { PoolClient } from "not-pg";
         export async function decideAppeal(client: PoolClient) {
           await client.query("insert into email_outbox (id) values (1)");
         }`,
      ),
    /untrusted-sql-receiver/u,
  );
});

test("only an exact imported pg pool connect chain establishes a client", () => {
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/appeals/admin-service.ts",
        `import { pool as databasePool } from "@/lib/db/client";
     export async function decideAppeal() {
       const client = await databasePool.connect();
       await client.query("insert into email_outbox (id) values (1)");
     }`,
      ),
    /release-composition/u,
  );

  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/appeals/admin-service.ts",
        `const databasePool = { connect: async () => ({ query() {} }) };
         export async function decideAppeal() {
           const client = await databasePool.connect();
           await client.query("insert into email_outbox (id) values (1)");
         }`,
      ),
    /untrusted-sql-receiver/u,
  );
});

function optionalClientFactoryWriter({
  clientModule = "pg",
  dependencyProperty = "acquireClient",
  dependencyType = "() => Promise<PoolClient>",
  fallbackExpression = "appPool.connect()",
} = {}) {
  return `
    import type { PoolClient } from "${clientModule}";
    import { pool as appPool } from "@/lib/db/client";
    type Dependencies = Readonly<{
      ${dependencyProperty}?: ${dependencyType};
    }>;
    const fakePool = {
      connect: async () => ({ query: async () => undefined }),
    };
    const acquireAccountDeletionClient = () => ${fallbackExpression};
    export async function deleteLearnerAccount(
      dependencies: Dependencies,
    ) {
      const acquireClient =
        dependencies.${dependencyProperty} ?? acquireAccountDeletionClient;
      const client = await acquireClient();
      await client.query(
        "insert into email_outbox (id) values (1)",
      );
    }
  `;
}

test("an exact typed optional pg-client factory establishes a client", () => {
  assert.throws(
    () => analyzeAstSource("src/lib/data-lifecycle/deletion.ts", optionalClientFactoryWriter()),
    /release-composition/u,
  );
});

test("optional pg-client factories reject every untrusted trust edge", () => {
  for (const [caseName, source] of [
    [
      "named property lookalike",
      optionalClientFactoryWriter({
        dependencyProperty: "acquireDatabaseClient",
      }),
    ],
    [
      "non-pg client type",
      optionalClientFactoryWriter({ clientModule: "not-pg" }),
    ],
    [
      "wrong injected factory result",
      optionalClientFactoryWriter({
        dependencyType: "() => Promise<unknown>",
      }),
    ],
    [
      "untrusted fallback",
      optionalClientFactoryWriter({
        fallbackExpression: "fakePool.connect()",
      }),
    ],
    [
      "one unsafe fallback branch",
      optionalClientFactoryWriter({
        fallbackExpression:
          "process.env.UNSAFE ? appPool.connect() : fakePool.connect()",
      }),
    ],
  ]) {
    assert.throws(
      () =>
        analyzeAstSource(
          "src/lib/data-lifecycle/deletion.ts",
          source,
        ),
      /untrusted-sql-receiver/u,
      caseName,
    );
  }
});

test("split-token array/join SQL is recovered, while unresolved target dataflow fails", () => {
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/appeals/admin-service.ts",
        `import type { PoolClient } from "pg";
     const statement = ["in", "sert into ", "email_", "outbox", " (id) values (1)"].join("");
     export async function decideAppeal(client: PoolClient) {
       await client.query(statement);
     }`,
      ),
    /release-composition/u,
  );

  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/appeals/admin-service.ts",
        `import type { PoolClient } from "pg";
         export async function decideAppeal(client: PoolClient, supplied: string) {
           const target = supplied + ["email_", "outbox"].join("");
           const parts = ["in", "sert into ", target, " (id) values (1)"];
           await client.query(parts.join(""));
         }`,
      ),
    /dynamic-or-split-executor/u,
  );
});

test("dynamic tagged SQL follows split-token target dataflow", () => {
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/notifications/outbox.ts",
        `import { db } from "@/lib/db/client";
         import { sql } from "drizzle-orm";
         export async function enqueueEmail(supplied: string) {
           const target = supplied + ["email_", "outbox"].join("");
           await db.execute(sql\`in\${"sert"} into \${target} (id) values (1)\`);
         }`,
      ),
    /dynamic-or-split-sql-tag/u,
  );
});

test("a tagged writer requires the exact tag and every execution receiver", () => {
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/notifications/outbox.ts",
        `import { sql } from "drizzle-orm";
         function queuedEmailInsert() {
           return sql\`insert into public.email_outbox (id) values (1)\`;
         }
         export async function enqueueEmail(fake: any) {
           await fake.execute(queuedEmailInsert());
         }`,
      ),
    /untrusted-sql-receiver/u,
  );
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/notifications/outbox.ts",
        `import { db } from "@/lib/db/client";
         const fakeTag = (parts: TemplateStringsArray) => parts;
         export async function enqueueEmail() {
           await db.execute(
             fakeTag\`insert into public.email_outbox (id) values (1)\`,
           );
         }`,
      ),
    /unresolved-sql-tag/u,
  );
});

test("inert, unexecuted, unreachable, and statically dead sinks never count", () => {
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/appeals/admin-service.ts",
        `const decoy = ["insert into ", "email_", "outbox"].join("");
         export async function decideAppeal() { return "safe"; }`,
      ),
    /inert-composed-write/u,
  );
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/notifications/outbox.ts",
        `import { sql } from "drizzle-orm";
         function queuedEmailInsert() {
           return sql\`insert into public.email_outbox (id) values (1)\`;
         }`,
      ),
    /unexecuted-sql-tag/u,
  );
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/appeals/admin-service.ts",
        `import type { PoolClient } from "pg";
         async function hidden(client: PoolClient) {
           await client.query("insert into email_outbox (id) values (1)");
         }
         export function decideAppeal() { return "safe"; }`,
      ),
    /dead-writer/u,
  );
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/appeals/admin-service.ts",
        `import type { PoolClient } from "pg";
         export async function decideAppeal(client: PoolClient) {
           if (false) {
             await client.query("insert into email_outbox (id) values (1)");
           }
         }`,
      ),
    /dead-writer/u,
  );
});

test("Drizzle schema aliases remain structural and receiver-bound", () => {
  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/admin-credentials/service.ts",
        `import * as schema from "@/lib/db/schema";
     import type { AuditTransaction as Tx } from "@/lib/security/audit-writer";
     const { emailOutbox: first } = schema;
     const second = first;
     export async function appendCredentialNotice(tx: Tx) {
       await tx.insert(second).values({});
     }`,
      ),
    /release-composition/u,
  );

  assert.throws(
    () =>
      analyzeAstSource(
        "src/lib/admin-credentials/service.ts",
        `import { emailOutbox } from "@/lib/db/schema";
         export async function appendCredentialNotice(tx: any) {
           await tx.insert(emailOutbox).values({});
         }`,
      ),
    /untrusted-drizzle-receiver/u,
  );
});

test("known operational text types are fully inspected for split-token writers", () => {
  for (const [relativePath, source] of [
    ["infra/ops/direct.cmd", "set SQL=in^sert into email_outbox"],
    ["infra/ops/direct.bat", "set SQL=insert into email_outbox values (1)"],
    ["drizzle/9999_bypass.sql", "in/**/sert into public.email_outbox values (1)"],
    ["scripts/direct.rb", "sql = ['in','sert into ','email_','outbox'].join"],
    ["scripts/direct.php", "$sql = 'in'.'sert into '.'email_'.'outbox';"],
    ["infra/ops/direct.yml", "run: psql -c \"insert into email_outbox values (1)\""],
    [
      "docs/unsafe.sha256",
      "in/**/sert into public.email_outbox values (1)",
    ],
  ]) {
    const root = fixtureRoot();
    try {
      const paths = exactFixture(root);
      write(root, relativePath, source);
      expectInventoryFailure(
        root,
        [...paths, relativePath].sort(),
        /prohibited-direct-text-writer/u,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("known non-writer text types are read, unknown types fail closed", () => {
  const root = fixtureRoot();
  try {
    const paths = exactFixture(root);
    const known = [
      ["infra/ops/safe.cmd", "@echo safe"],
      ["infra/ops/safe.bat", "@echo safe"],
      ["scripts/safe.rb", "puts 'safe'"],
      ["scripts/safe.php", "<?php echo 'safe';"],
      ["infra/ops/safe.yml", "run: echo safe"],
      ["docs/safe.sha256", `${"a".repeat(64)}  reviewed-plan.md`],
    ];
    for (const [relativePath, source] of known) {
      write(root, relativePath, source);
      paths.push(relativePath);
    }
    assert.deepEqual(
      verifyWriterInventory({ repositoryRoot: root, paths: paths.sort() }),
      { delegatedEdges: 1, runtimeWriters: 5 },
    );
    write(root, "assets/opaque.wat", "safe");
    expectInventoryFailure(
      root,
      [...paths, "assets/opaque.wat"].sort(),
      /unknown-file-type:assets\/opaque\.wat/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("known binary files are inspected for ASCII writer and routine tokens", () => {
  const root = fixtureRoot();
  try {
    const paths = exactFixture(root);
    write(
      root,
      "assets/opaque.png",
      Buffer.from([0, 1, ...Buffer.from("insert into email_outbox"), 0xff]),
    );
    expectInventoryFailure(
      root,
      [...paths, "assets/opaque.png"].sort(),
      /prohibited-binary-writer-token/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the exact 0069 backup successor remains a reviewed routine wrapper", () => {
  const root = fixtureRoot();
  try {
    const relativePath = "drizzle/0069_mail_outbox_guarded_delivery_authority.sql";
    write(
      root,
      relativePath,
      `create or replace function public.enqueue_backup_status_mail_authority(
         p_run_key text,
         p_outcome text
       ) returns void language plpgsql as $function$
       begin
         perform *
           from public.enqueue_backup_status_mail_authority_unreleased_0067(
             p_run_key,
             p_outcome
           );
         perform *
           from public.release_email_outbox_delivery(
             candidate.id,
             candidate.operation_id,
             candidate.idempotency_authority_sha256,
             candidate.idempotency_original_payload_sha256,
             candidate.delivery_hold_version
           );
       end
       $function$;`,
    );
    assert.throws(
      () => verifyWriterInventory({ repositoryRoot: root, paths: [relativePath] }),
      /manifest:/u,
    );
    write(
      root,
      relativePath,
      `create or replace function public.enqueue_backup_status_mail_authority()
       returns void language sql as $function$
       select * from public.enqueue_backup_status_mail_authority_unreleased_0067('', '');
       select * from public.release_email_outbox_delivery(null, null, null, null, null);
       insert into public.email_outbox (id) values (null);
       $function$;`,
    );
    expectInventoryFailure(
      root,
      [relativePath],
      /reviewed-sql-wrapper-direct-writer/u,
    );
    write(
      root,
      relativePath,
      `create or replace function public.enqueue_backup_status_mail_authority()
       returns void language sql as $function$
       select * from public.enqueue_backup_status_mail_authority_unreleased_0067('', '');
       $function$;`,
    );
    expectInventoryFailure(root, [relativePath], /reviewed-sql-wrapper-shape/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("only the two exact reviewed SQL paths may carry one physical writer", () => {
  const root = fixtureRoot();
  try {
    const paths = exactFixture(root);
    write(
      root,
      "drizzle/0065_backup_status_mail_authority.sql",
      "insert into public.email_outbox (id) values (1);",
    );
    paths.push("drizzle/0065_backup_status_mail_authority.sql");
    assert.deepEqual(
      verifyWriterInventory({ repositoryRoot: root, paths: paths.sort() }),
      { delegatedEdges: 1, runtimeWriters: 5 },
    );
    write(
      root,
      "drizzle/0065_backup_status_mail_authority.sql",
      "insert into public.email_outbox values (1); insert into public.email_outbox values (2);",
    );
    expectInventoryFailure(
      root,
      paths,
      /reviewed-sql-writer-count/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the routine model rejects helper, dynamic, dead, trigger, and digest bypasses", () => {
  const reviewed = {
    bodySha256: "body",
    definitionSha256: "definition",
    identityArguments: "p_run_key text, p_outcome text",
    signature: "public.enqueue_backup_status_mail_authority(text,text)",
  };
  const writer = {
    bodySha256: "body",
    calls: [],
    definitionSha256: "definition",
    directWrites: 1,
    dynamic: false,
    extensionOwned: false,
    identityArguments: "p_run_key text, p_outcome text",
    kind: "f",
    language: "plpgsql",
    signature: reviewed.signature,
  };
  assert.deepEqual(
    verifyRoutineCatalogModel({ reviewed, routines: [writer] }),
    { directWriters: 1, reachableWriters: 1, triggerWriters: 0 },
  );
  const helper = {
    ...writer,
    bodySha256: "helper",
    definitionSha256: "helper",
    identityArguments: "",
    signature: "public.helper()",
  };
  for (const mutation of [
    { routines: [writer, helper] },
    {
      routines: [
        writer,
        { ...helper, directWrites: 0, calls: [reviewed.signature] },
      ],
    },
    {
      routines: [
        writer,
        { ...helper, directWrites: 0, dynamic: true },
      ],
    },
    {
      routines: [
        writer,
        { ...helper, directWrites: 1, calls: [], signature: "public.dead()" },
      ],
    },
    {
      routines: [writer],
      triggers: [{ functionSignature: reviewed.signature }],
    },
    {
      routines: [{ ...writer, bodySha256: "tampered" }],
    },
  ]) {
    assert.throws(
      () => verifyRoutineCatalogModel({ reviewed, ...mutation }),
      /catalog-model/u,
    );
  }
});

test("lexical traversal is rejected before filesystem access", () => {
  for (const candidate of [
    "../outside.ts",
    "src/../outside.ts",
    "/absolute.ts",
    "C:/absolute.ts",
    "src\\outside.ts",
    "src//outside.ts",
    "src/\nfile.ts",
  ]) {
    assert.throws(() => validateRepositoryPath(candidate), /unsafe-path/u);
  }
});

test("lstat and realpath containment reject a symlinked component", (t) => {
  const root = fixtureRoot();
  const outside = fixtureRoot();
  try {
    write(outside, "escape.ts", "export const escaped = true;");
    mkdirSync(path.join(root, "src"), { recursive: true });
    try {
      symlinkSync(outside, path.join(root, "src", "linked"), "junction");
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("symlink creation is unavailable on this Windows runner");
        return;
      }
      throw error;
    }
    const read = createBoundedReader(root);
    assert.throws(
      () => read("src/linked/escape.ts"),
      /symlink-or-reparse-path|path-escape/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("bounded reads reject oversized files", () => {
  const root = fixtureRoot();
  try {
    write(root, "scripts/direct.py", "x".repeat(65));
    const read = createBoundedReader(root, {
      limits: { ...LIMITS, fileBytes: 64, totalBytes: 128 },
    });
    assert.throws(
      () => read("scripts/direct.py"),
      /file-size-limit:scripts\/direct\.py/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("bounded reads reject aggregate overflow across individually valid files", () => {
  const root = fixtureRoot();
  try {
    write(root, "scripts/first.py", "a".repeat(40));
    write(root, "scripts/second.py", "b".repeat(40));
    const read = createBoundedReader(root, {
      limits: { ...LIMITS, fileBytes: 64, totalBytes: 64 },
    });

    assert.equal(read("scripts/first.py").toString("utf8"), "a".repeat(40));
    assert.throws(
      () => read("scripts/second.py"),
      /total-size-limit:scripts\/second\.py/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("writer inventory keeps reviewed per-file and aggregate byte ceilings", () => {
  assert.equal(LIMITS.fileBytes, 2 * 1024 * 1024);
  assert.equal(LIMITS.totalBytes, 80 * 1024 * 1024);
});

test("git discovery has time, byte, count, termination, and duplicate guards", () => {
  const pathOutput = Buffer.from("a.ts\0b.ts\0", "utf8");
  assert.deepEqual(parseGitPathOutput(pathOutput), ["a.ts", "b.ts"]);
  assert.throws(
    () => parseGitPathOutput(Buffer.from("a.ts", "utf8")),
    /not-nul-terminated/u,
  );
  assert.throws(
    () => parseGitPathOutput(pathOutput, { discoveryBytes: 2, paths: 10 }),
    /git-output-limit/u,
  );
  assert.throws(
    () => parseGitPathOutput(pathOutput, { discoveryBytes: 100, paths: 1 }),
    /path-count-limit/u,
  );
  assert.throws(
    () => parseGitPathOutput(Buffer.from("a.ts\0a.ts\0", "utf8")),
    /duplicate-path/u,
  );
  let options;
  assert.deepEqual(
    listRepositoryPaths("C:\\repo", {
      spawn(command, args, received) {
        assert.equal(command, "git");
        assert.deepEqual(args.slice(-5), [
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
        ]);
        options = received;
        return { status: 0, stdout: Buffer.from("a.ts\0") };
      },
    }),
    ["a.ts"],
  );
  assert.equal(options.timeout, LIMITS.discoveryMilliseconds);
  assert.equal(options.maxBuffer, LIMITS.discoveryBytes);
  assert.throws(
    () =>
      listRepositoryPaths(".", {
        spawn: () => ({
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          status: null,
          stdout: Buffer.alloc(0),
        }),
      }),
    /git-discovery:ETIMEDOUT/u,
  );
});

test("an extra trusted writer or a missing manifest writer is rejected", () => {
  const root = fixtureRoot();
  try {
    const paths = exactFixture(root);
    const extra = "src/lib/extra.ts";
    write(root, extra, exactRawPgWriter("extraWriter"));
    expectInventoryFailure(
      root,
      [...paths, extra].sort(),
      /src\/lib\/extra\.ts:sql-executor:pg-client:extraWriter:expected=0:observed=1/u,
    );
    rmSync(path.join(root, "src", "lib", "extra.ts"));
    expectInventoryFailure(
      root,
      paths.filter((candidate) => candidate !== "src/lib/appeals/admin-service.ts"),
      /src\/lib\/appeals\/admin-service\.ts:sql-executor:pg-client:decideAppeal:expected=1:observed=0/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the shipped CLI reports only the static writer proof it executes", () => {
  const environment = Object.fromEntries(
    [
      "ComSpec",
      "LANG",
      "Path",
      "PATH",
      "PATHEXT",
      "SystemRoot",
      "SYSTEMROOT",
      "TEMP",
      "TMP",
      "TMPDIR",
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("./verify-email-outbox-writer-inventory.mjs", import.meta.url),
      ),
    ],
    {
      cwd: os.tmpdir(),
      encoding: "utf8",
      env: environment,
      timeout: 20_000,
      windowsHide: true,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    "email_outbox_writer_inventory=runtime:5:delegated:1:static-pass\n",
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /catalog/iu);
});
