import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const inventoryModule = await import("./lib/mail-writer-inventory.mjs").catch(
  () => null,
);

function requireInventoryModule() {
  assert.ok(
    inventoryModule,
    "the mail writer inventory implementation must exist",
  );
  return inventoryModule;
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "codestead-mail-inventory-"));
  for (const [relativePath, source] of Object.entries(files)) {
    const path = join(root, ...relativePath.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source, "utf8");
  }
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const COMPLETE_SQL_WRITER = String.raw`
  INSERT INTO email_outbox (
    operation_id, user_id, delivery_scope_key, to_email, template,
    template_version, variables, idempotency_key
  )
  SELECT
    gen_random_uuid(), id, 'a:' || id, email, 'backup-status',
    '1', '{}'::jsonb, 'key'
  FROM administrator
  ON CONFLICT (idempotency_key) DO NOTHING
`;

test("scans every reviewed production root and executable source extension", () => {
  const inventory = requireInventoryModule();
  assert.deepEqual(inventory.PRODUCTION_ROOTS, [
    "src",
    "scripts",
    "infra",
    "services",
  ]);
  assert.deepEqual(inventory.PRODUCTION_EXTENSIONS, [
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".sh",
    ".bash",
    ".py",
    ".sql",
  ]);

  const repo = fixture({
    "src/a.ts": "",
    "src/a.tsx": "",
    "scripts/a.js": "",
    "scripts/a.mjs": "",
    "scripts/a.cjs": "",
    "scripts/a.sh": "",
    "scripts/a.bash": "",
    "scripts/a.py": "",
    "infra/ops/a.sql": "",
    "services/runner/a.ts": "",
    "src/__tests__/ignored.ts": COMPLETE_SQL_WRITER,
    "scripts/ignored.test.ts": COMPLETE_SQL_WRITER,
    "infra/tests/ignored.sql": COMPLETE_SQL_WRITER,
    "services/runner/fixtures/ignored.cjs": COMPLETE_SQL_WRITER,
    "drizzle/0063_ignored.sql": COMPLETE_SQL_WRITER,
    "docs/ignored.ts": COMPLETE_SQL_WRITER,
  });
  try {
    assert.deepEqual(inventory.scanProductionFiles(repo.root), [
      "infra/ops/a.sql",
      "scripts/a.bash",
      "scripts/a.cjs",
      "scripts/a.js",
      "scripts/a.mjs",
      "scripts/a.py",
      "scripts/a.sh",
      "services/runner/a.ts",
      "src/a.ts",
      "src/a.tsx",
    ]);
  } finally {
    repo.cleanup();
  }
});

test("rejects a raw SQL writer that omits an explicit operation ID", () => {
  const inventory = requireInventoryModule();
  const repo = fixture({
    "scripts/backup/common.sh": COMPLETE_SQL_WRITER.replace(
      "operation_id, ",
      "",
    ).replace("gen_random_uuid(), ", ""),
  });
  try {
    const report = inventory.auditMailWriterInventory(repo.root, {
      dispatchEnabledTemplates: [],
      reviewedDirectWriterPaths: ["scripts/backup/common.sh"],
      reviewedTemplateProducers: [],
      centralWriterPath: null,
    });
    assert.match(
      report.errors.join("\n"),
      /scripts\/backup\/common\.sh[\s\S]*missing operation_id/u,
    );
  } finally {
    repo.cleanup();
  }
});

test("rejects an ORM writer that omits an explicit operation ID", () => {
  const inventory = requireInventoryModule();
  const repo = fixture({
    "src/direct.ts": `
      db.insert(emailOutbox).values({
        userId: "learner",
        deliveryScopeKey: "a:learner",
        toEmail: "learner@example.invalid",
        template: "verify-email",
        templateVersion: "1",
        variables: {},
        idempotencyKey: "key",
      });
    `,
  });
  try {
    const report = inventory.auditMailWriterInventory(repo.root, {
      dispatchEnabledTemplates: [],
      reviewedDirectWriterPaths: ["src/direct.ts"],
      reviewedTemplateProducers: [],
      centralWriterPath: null,
    });
    assert.match(
      report.errors.join("\n"),
      /src\/direct\.ts[\s\S]*missing operationId/u,
    );
  } finally {
    repo.cleanup();
  }
});

test("fails closed for unreviewed writers and producerless dispatch templates", () => {
  const inventory = requireInventoryModule();
  const repo = fixture({
    "src/reviewed.ts": `
      enqueueEmail({
        template: "verify-email",
        to: "learner@example.invalid",
        userId: "learner",
        variables: {},
        idempotencySeed: "seed",
      });
    `,
    "src/unreviewed.ts": COMPLETE_SQL_WRITER.replace(
      "'backup-status'",
      "'reset-password'",
    ),
  });
  try {
    const report = inventory.auditMailWriterInventory(repo.root, {
      dispatchEnabledTemplates: ["verify-email", "reset-password"],
      reviewedDirectWriterPaths: [],
      reviewedTemplateProducers: [
        {
          template: "verify-email",
          path: "src/reviewed.ts",
          call: "enqueueEmail",
        },
      ],
      centralWriterPath: null,
    });
    const errors = report.errors.join("\n");
    assert.match(
      errors,
      /unreviewed direct email_outbox writer: src\/unreviewed\.ts/u,
    );
    assert.match(
      errors,
      /dispatch-enabled template has no reviewed production producer: reset-password/u,
    );
  } finally {
    repo.cleanup();
  }
});

test("attributes dynamic producers only through a reviewed call and literal mapping", () => {
  const inventory = requireInventoryModule();
  const repo = fixture({
    "src/dynamic.ts": `
      const copy = {
        daily: { template: "daily-study-reminder" },
      };
      enqueueEmailInTransaction(tx, {
        template: copy.daily.template,
        to: "learner@example.invalid",
        userId: "learner",
        variables: {},
        idempotencySeed: "seed",
      });
    `,
  });
  try {
    const report = inventory.auditMailWriterInventory(repo.root, {
      dispatchEnabledTemplates: ["daily-study-reminder"],
      reviewedDirectWriterPaths: [],
      reviewedTemplateProducers: [
        {
          template: "daily-study-reminder",
          path: "src/dynamic.ts",
          call: "enqueueEmailInTransaction",
        },
      ],
      centralWriterPath: null,
    });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.producers, [
      {
        template: "daily-study-reminder",
        path: "src/dynamic.ts",
        call: "enqueueEmailInTransaction",
      },
    ]);
  } finally {
    repo.cleanup();
  }
});

test("does not inventory comments, test fixtures, or migration fixtures as writers", () => {
  const inventory = requireInventoryModule();
  const repo = fixture({
    "src/comment.ts": `
      // INSERT INTO email_outbox (operation_id, user_id) VALUES (gen_random_uuid(), 'x')
      const harmless = "email_outbox is a durable queue";
    `,
    "src/comment.py":
      "# INSERT INTO email_outbox (operation_id) VALUES ('x')\n",
    "infra/tests/fixture.sql": COMPLETE_SQL_WRITER,
    "drizzle/0063_fixture.sql": COMPLETE_SQL_WRITER,
  });
  try {
    const report = inventory.auditMailWriterInventory(repo.root, {
      dispatchEnabledTemplates: [],
      reviewedDirectWriterPaths: [],
      reviewedTemplateProducers: [],
      centralWriterPath: null,
    });
    assert.deepEqual(report.directWriters, []);
    assert.deepEqual(report.errors, []);
  } finally {
    repo.cleanup();
  }
});

test("extracts the exact template allowlist from provider-boundary policy source", () => {
  const inventory = requireInventoryModule();
  const source = String.raw`
    // outbox.template = 'ghost-template'
    const unrelated = "outbox.template = 'unrelated-template'";
    function accountMailAuthorityPredicate(outbox) {
      return \`
        \${outbox}.template = 'verify-email'
        or \${outbox}.template in (
          'reset-password', 'weekly-summary'
        )
      \`;
    }
    function systemMailAuthorityPredicate(outbox) {
      return \`\${outbox}.template = 'invitation'\`;
    }
    function deletionNoticeCapabilityPredicate(outbox) {
      return \`\${outbox}.template = 'account-deleted'\`;
    }
  `;
  assert.deepEqual(inventory.extractDispatchEnabledTemplates(source), [
    "account-deleted",
    "invitation",
    "reset-password",
    "verify-email",
    "weekly-summary",
  ]);
});

test("extracts the canonical production template registry through its AST", () => {
  const inventory = requireInventoryModule();
  const source = String.raw`
    // const PRODUCTION_EMAIL_TEMPLATE_DEFINITIONS = ["ghost-template"];
    const unrelated = "PRODUCTION_EMAIL_TEMPLATE_DEFINITIONS";
    const PRODUCTION_EMAIL_TEMPLATE_DEFINITIONS = Object.freeze([
      "verify-email",
      "reset-password",
      "backup-status",
    ] as const);
  `;
  assert.deepEqual(inventory.extractProductionEmailTemplates(source), [
    "backup-status",
    "reset-password",
    "verify-email",
  ]);
});

test("default inventory routes backup status through the authority routine and attributes every template", () => {
  const inventory = requireInventoryModule();
  assert.equal(
    inventory.REVIEWED_DIRECT_WRITER_PATHS.includes("scripts/backup/common.sh"),
    false,
  );
  assert.deepEqual(
    inventory.REVIEWED_TEMPLATE_PRODUCERS.find(
      ({ template }) => template === "backup-status",
    ),
    {
      template: "backup-status",
      path: "scripts/backup/enqueue-backup-status.mjs",
      call: "authority-sql",
    },
  );
  const templates = new Set(
    inventory.REVIEWED_TEMPLATE_PRODUCERS.map(({ template }) => template),
  );
  for (const template of inventory.REVIEWED_DISPATCH_ENABLED_TEMPLATES) {
    assert.ok(
      templates.has(template),
      `${template} must have a reviewed producer`,
    );
  }
});
