import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const DIRECT_OUTBOX_INSERT =
  /insert\s+into\s+(?:(?:"public"|public)\s*\.\s*)?(?:"email_outbox"|email_outbox\b)/iu;
const PRODUCTION_SOURCE_FILE = /\.[cm]?[jt]sx?$/u;

function productionFiles(directory: string, fileNamePattern: RegExp): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__"
        ? []
        : productionFiles(path, fileNamePattern);
    }
    return entry.isFile()
      && !entry.name.includes(".test.")
      && fileNamePattern.test(entry.name)
      ? [path]
      : [];
  });
}

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("production email stable-event writer inventory", () => {
  it("requires every direct outbox writer to supply event-v1-native while leaving both digests database-owned", () => {
    const repositoryRoot = process.cwd();
    const writers = [
      ...productionFiles(resolve(repositoryRoot, "src"), PRODUCTION_SOURCE_FILE),
      ...productionFiles(
        resolve(repositoryRoot, "scripts"),
        /\.(?:[cm]?[jt]sx?|sh)$/u,
      ),
    ]
      .map((path) => ({
        relativePath: relative(repositoryRoot, path).replaceAll("\\", "/"),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ source: fileSource }) =>
        DIRECT_OUTBOX_INSERT.test(fileSource)
        || fileSource.includes(".insert(emailOutbox)")
      )
      .sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      );

    expect(writers.map(({ relativePath }) => relativePath)).toEqual([
      "src/lib/admin-credentials/service.ts",
      "src/lib/appeals/admin-service.ts",
      "src/lib/assessment-corrections/worker.ts",
      "src/lib/data-lifecycle/deletion.ts",
      "src/lib/notifications/inactivity.ts",
      "src/lib/notifications/outbox.ts",
    ]);

    for (const writer of writers) {
      if (DIRECT_OUTBOX_INSERT.test(writer.source)) {
        const statements = [
          ...writer.source.matchAll(
            /insert into\s+(?:(?:"public"|public)\s*\.\s*)?(?:"email_outbox"|email_outbox\b)([\s\S]*?)on conflict/giu,
          ),
        ];
        expect(statements.length, writer.relativePath).toBeGreaterThan(0);
        for (const statement of statements) {
          expect(statement[1], writer.relativePath)
            .toContain("idempotency_authority_version");
          if (writer.relativePath === "src/lib/notifications/outbox.ts") {
            expect(statement[0], writer.relativePath).toContain(
              "${row.idempotencyAuthorityVersion}",
            );
            expect(writer.source, writer.relativePath).toMatch(
              /idempotencyAuthorityVersion:\s*MAIL_IDEMPOTENCY_AUTHORITY_VERSION/u,
            );
          } else {
            expect(statement[0], writer.relativePath)
              .toMatch(/['"]event-v1-native['"]/u);
          }
        }
      } else {
        expect(writer.source, writer.relativePath)
          .toMatch(/idempotencyAuthorityVersion:\s*(?:"event-v1-native"|MAIL_IDEMPOTENCY_AUTHORITY_VERSION)/u);
        expect(writer.source, writer.relativePath)
          .not.toContain("idempotencyAuthoritySha256:");
        expect(writer.source, writer.relativePath)
          .not.toContain("idempotencyOriginalPayloadSha256:");
      }
    }
  });

  it("keeps every latest-schema integration fixture on event-v1-native with a 64-hex event identity", () => {
    const fixtures = [
      {
        path: "integration/retention-ops-session.integration.test.ts",
        statements: 2,
        rows: 2,
        keys: [
          "c45ece643fc7971d22c4d34daca51b48127b160a4c7e630f99a11b308cade070",
          "61a368ed9b4997ce82b5a85e059afa6658c9dd9cb5b6a1a85eb46820dddb4f84",
        ],
      },
      {
        path: "integration/mentor-evidence.integration.test.ts",
        statements: 1,
        rows: 2,
        keys: [
          "9a955329a8dc2d275b5f70db905671a72580d182ac755d4546fd6582abde1d81",
          "bf3e26ef3157fa8bb551f16079174440a617fce2a2d3f8f4468b9deec7469977",
        ],
      },
      {
        path: "integration/tutor-memory.integration.test.ts",
        statements: 1,
        rows: 3,
        keys: [
          "b04c397be415650a1bf513e37c4dfa64bd98b80dbaa2c538851b55ccab80ba66",
          "c52cdc5a21700cf40ffd1934f8da7a564b216a2c6e1563b144df5803410e048c",
          "53a3d96d2de01a41a5e87bd1ecba4ece9c78c29bd6595d343707516dd10329d1",
        ],
      },
    ] as const;

    for (const fixture of fixtures) {
      const fixtureSource = source(fixture.path);
      expect(
        fixtureSource.match(
          /insert\s+into\s+(?:public\.)?email_outbox\s*\(/giu,
        ),
        fixture.path,
      ).toHaveLength(fixture.statements);
      expect(
        fixtureSource.match(/\bidempotency_authority_version\b/gu),
        fixture.path,
      ).toHaveLength(fixture.statements);
      expect(fixtureSource.match(/'event-v1-native'/gu), fixture.path)
        .toHaveLength(fixture.rows);
      for (const key of fixture.keys) {
        expect(fixtureSource, fixture.path).toContain(`'${key}'`);
      }
    }

    const dispatchBinding = source(
      "integration/mail-dispatch-binding-0064.integration.test.ts",
    );
    expect(dispatchBinding).toContain(
      'idempotencyKey: createHash("sha256")',
    );
    expect(dispatchBinding).toContain(
      '.update(`dispatch-binding-pg17:${number}`, "utf8")',
    );
    expect(dispatchBinding).toContain("row.idempotencyKey");
    expect(dispatchBinding).toMatch(
      /idempotency_key,\s+idempotency_authority_version,\s+status/u,
    );
    expect(dispatchBinding).toMatch(/\$6::text,\s+'event-v1-native',\s+'pending'/u);
  });

  it("registers a real Drizzle rollback proof for sanitized replay conflicts", () => {
    const integration = source("integration/postgres.integration.test.ts");
    const start = integration.indexOf(
      'it("rolls back a preceding Drizzle write on a sanitized durable replay conflict"',
    );
    expect(start).toBeGreaterThan(-1);
    const end = integration.indexOf("\n  });", start);
    expect(end).toBeGreaterThan(start);
    const regression = integration.slice(start, end);

    expect(regression).toContain("await enqueueEmail(original)");
    expect(regression).toContain("await db.transaction(async (tx) => {");
    expect(regression).toContain("await tx.insert(auditEvent).values({");
    expect(regression).toContain("await enqueueEmailInTransaction(tx, {");
    expect(regression).toContain(
      "expect(observed).toBeInstanceOf(EmailOutboxReplayConflictError)",
    );
    expect(regression).toContain(
      ".where(eq(auditEvent.eventHash, sentinelHash))",
    );
    expect(regression).toContain("expect(persistedSentinel).toEqual([])");
    expect(regression).toContain(
      ".where(eq(emailOutbox.idempotencyKey, idempotencyKey))",
    );
    expect(regression).toContain(
      "expect(persistedOutbox).toEqual([{ variables: original.variables }])",
    );
  });

  it("keeps backup status behind its database authority routine", () => {
    const reporter = source("scripts/backup/enqueue-backup-status.mjs");
    const shell = source("scripts/backup/common.sh");
    expect(reporter).toContain(
      "from public.enqueue_backup_status_mail_authority($1::text, $2::text)",
    );
    expect(reporter).not.toMatch(/insert\s+into\s+email_outbox/iu);
    expect(shell).not.toMatch(/insert\s+into\s+email_outbox/iu);
  });

  it("never includes a mutable recipient or wall clock in a producer-event identity", () => {
    const repositoryRoot = process.cwd();
    const files = [
      ...productionFiles(resolve(repositoryRoot, "src"), /\.[cm]?tsx?$/u),
      ...productionFiles(resolve(repositoryRoot, "scripts"), /\.sh$/u),
    ];
    for (const path of files) {
      const relativePath = relative(repositoryRoot, path).replaceAll("\\", "/");
      const fileSource = readFileSync(path, "utf8");
      for (const expression of fileSource.matchAll(
        /(?:idempotencyKey|idempotencySeed|mailKey)\s*[:=][\s\S]{0,500}?(?:digest\("hex"\)|[,;}\n])/gu,
      )) {
        expect(expression[0], relativePath)
          .not.toMatch(/\b(?:email|recipient|toEmail|Date\.now)\b/iu);
      }
    }
  });

  it("uses the signed verification token digest as source identity, never the bearer URL", () => {
    const auth = source("src/lib/auth.ts");
    expect(auth).toMatch(
      /sendVerificationEmail:\s*async\s*\(\{\s*user:\s*authUser,\s*url,\s*token\s*\}\)/u,
    );
    const callback = auth.match(
      /sendVerificationEmail:[\s\S]*?\n\s*\},\n\s*\},/u,
    )?.[0] ?? "";
    expect(callback).toContain("verificationEmailSourceEventId(token)");
    expect(callback).not.toMatch(/idempotencySeed:\s*url/u);
  });

  it("requires stable request UUIDs for repeatable learner and administrator credential commands", () => {
    const learnerRoute = source("src/app/api/credentials/[id]/route.ts");
    expect(learnerRoute).toMatch(
      /action:\s*z\.enum\(\["prefer",\s*"disable",\s*"enable",\s*"test"\]\),\s*requestId:\s*z\.uuid\(\)/u,
    );
    expect(learnerRoute).toMatch(
      /action:\s*z\.literal\("replace"\),[\s\S]*?requestId:\s*z\.uuid\(\)/u,
    );
    expect(learnerRoute).toMatch(
      /const deleteSchema = z\.object\(\{ requestId: z\.uuid\(\) \}\)\.strict\(\)/u,
    );
    expect(learnerRoute).toContain(
      "idempotencySeed: `${owned.id}:${body.data.action}:${body.data.requestId}`",
    );
    expect(learnerRoute).toContain(
      "idempotencySeed: `${deleted[0].id}:delete:${body.data.requestId}`",
    );
    expect(learnerRoute).not.toContain("Date.now()");

    const settingsView = source("src/components/product/settings-view.tsx");
    expect(settingsView.match(/crypto\.randomUUID\(\)/gu)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);

    const adminRoute = source("src/app/api/admin/credentials/[id]/route.ts");
    expect(adminRoute).toMatch(
      /action:\s*z\.enum\(\["enable",\s*"disable"\]\),\s*requestId:\s*z\.uuid\(\)/u,
    );
    expect(adminRoute).toMatch(
      /const deleteSchema = z\.object\(\{ \.\.\.commonFields, requestId: z\.uuid\(\) \}\)\.strict\(\)/u,
    );
    const adminService = source("src/lib/admin-credentials/service.ts");
    expect(adminService).toContain("requestId: string;");
    expect(adminService).toContain(
      "eventId: `${target.id}:${input.action}:${input.requestId}:${input.stage}`",
    );
  });
});
