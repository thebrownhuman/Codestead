import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function productionFiles(directory: string, fileNamePattern: RegExp): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__"
        ? []
        : productionFiles(path, fileNamePattern);
    }
    return entry.isFile() && fileNamePattern.test(entry.name) ? [path] : [];
  });
}

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("production email stable-event writer inventory", () => {
  it("requires every direct outbox writer to supply event-v1 while leaving the authority digest database-owned", () => {
    const repositoryRoot = process.cwd();
    const writers = [
      ...productionFiles(resolve(repositoryRoot, "src"), /\.[cm]?tsx?$/u),
      ...productionFiles(
        resolve(repositoryRoot, "scripts"),
        /\.(?:[cm]?tsx?|sh)$/u,
      ),
    ]
      .map((path) => ({
        relativePath: relative(repositoryRoot, path).replaceAll("\\", "/"),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ source: fileSource }) =>
        /insert\s+into\s+email_outbox/iu.test(fileSource)
        || fileSource.includes(".insert(emailOutbox)")
      )
      .sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      );

    expect(writers.map(({ relativePath }) => relativePath)).toEqual([
      "scripts/backup/common.sh",
      "src/lib/admin-credentials/service.ts",
      "src/lib/appeals/admin-service.ts",
      "src/lib/assessment-corrections/worker.ts",
      "src/lib/data-lifecycle/deletion.ts",
      "src/lib/notifications/inactivity.ts",
      "src/lib/notifications/outbox.ts",
    ]);

    for (const writer of writers) {
      if (/insert\s+into\s+email_outbox/iu.test(writer.source)) {
        const statements = [
          ...writer.source.matchAll(
            /insert into email_outbox([\s\S]*?)on conflict/giu,
          ),
        ];
        expect(statements.length, writer.relativePath).toBeGreaterThan(0);
        for (const statement of statements) {
          expect(statement[1], writer.relativePath)
            .toContain("idempotency_authority_version");
          expect(statement[0], writer.relativePath)
            .toMatch(/['"]event-v1['"]/u);
        }
      } else {
        expect(writer.source, writer.relativePath)
          .toMatch(/idempotencyAuthorityVersion:\s*(?:"event-v1"|MAIL_IDEMPOTENCY_AUTHORITY_VERSION)/u);
        expect(writer.source, writer.relativePath)
          .not.toContain("idempotencyAuthoritySha256:");
      }
    }
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
    expect(learnerRoute).toContain("idempotencySeed: `${owned.id}:${body.data.action}:${body.data.requestId}`");
    expect(learnerRoute).toContain("idempotencySeed: `${deleted[0].id}:delete:${body.data.requestId}`");
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
    expect(adminService).toContain("eventId: `${input.requestId}:${input.stage}`");
  });
});
