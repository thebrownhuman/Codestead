import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditMailWriterInventory } from "./lib/mail-writer-inventory.mjs";

test("shell glob syntax cannot hide a later production SQL writer", () => {
  const root = mkdtempSync(join(tmpdir(), "codestead-mail-shell-"));
  const path = join(root, "scripts", "backup", "common.sh");
  mkdirSync(join(root, "scripts", "backup"), { recursive: true });
  writeFileSync(path, String.raw`
    archived_path='/srv/backups/*'
    cat <<'SQL'
    INSERT INTO email_outbox (
      operation_id, user_id, delivery_scope_key, to_email, template,
      template_version, variables, idempotency_key
    )
    SELECT
      gen_random_uuid(), id, 'a:' || id, email, 'backup-status',
      '1', '{}'::jsonb, 'key'
    FROM administrator
    ON CONFLICT (idempotency_key) DO NOTHING
    SQL
    [[ "$candidate" != */ ]]
  `, "utf8");
  try {
    const report = auditMailWriterInventory(root, {
      dispatchEnabledTemplates: [],
      reviewedDirectWriterPaths: ["scripts/backup/common.sh"],
      reviewedTemplateProducers: [],
      centralWriterPath: null,
    });
    assert.equal(report.directWriters.length, 1);
    assert.deepEqual(report.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
