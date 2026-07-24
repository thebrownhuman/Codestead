// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import type { AccountEmailTemplate } from "../outbox";

type AccountStatus =
  | "pending"
  | "active"
  | "suspended"
  | "deletion_pending"
  | "deleted";

type MatrixTemplate = AccountEmailTemplate | "invitation" | "access-rejected";

const ACCOUNT_STATUSES = [
  "pending",
  "active",
  "suspended",
  "deletion_pending",
  "deleted",
] as const satisfies readonly AccountStatus[];

const ALLOWED_STATUSES = {
  "verify-email": ["pending"],
  "reset-password": ["pending", "active"],
  invitation: [],
  "lost-device-proof": ["active"],
  "access-rejected": [],
  "learning-request-updated": ["active"],
  "new-device": ["active"],
  "session-revocation-requested": ["active"],
  "session-revocation-updated": ["active"],
  "session-revoked": ["active"],
  "credential-changed": ["active"],
  "credential-revealed": ["active"],
  "fallback-grant-changed": ["active"],
  "learning-plan-changed": ["active"],
  "storage-quota-changed": ["active"],
  "inactivity-reminder": ["active"],
  "inactivity-reminder-followup": ["active"],
  "inactivity-admin-notice": ["active"],
  "daily-study-reminder": ["active"],
  "revision-reminder": ["active"],
  "goal-reminder": ["active"],
  "challenge-reminder": ["active"],
  "exam-result": ["active"],
  "mastery-awarded": ["active"],
  "appeal-updated": ["active"],
  "assessment-corrected": ["active"],
  "weekly-summary": ["active"],
  "backup-status": ["active"],
} as const satisfies Record<MatrixTemplate, readonly AccountStatus[]>;

function extractProviderBoundaryCase() {
  const source = readFileSync(
    join(process.cwd(), "src/lib/notifications/postgres-outbox-store.ts"),
    "utf8",
  );
  const functionStart = source.indexOf("async function providerBoundaryDecision");
  const selectStart = source.indexOf("select case", functionStart);
  const caseStart = selectStart + "select ".length;
  const caseEnd = source.indexOf("end as decision", caseStart) + "end".length;
  if (functionStart < 0 || selectStart < 0 || caseEnd < "end".length) {
    throw new Error("Provider-boundary CASE expression was not found.");
  }

  // SQLite executes the same CASE/EXISTS/IN expressions used by PostgreSQL.
  // Only PostgreSQL's explicit text-cast spelling needs normalization.
  return source.slice(caseStart, caseEnd).replaceAll("::text", "");
}

const database = new DatabaseSync(":memory:");
database.exec(`
  attach database ':memory:' as public;
  create table public."user" (
    id text primary key,
    email text not null,
    status text not null
  );
  create table public.email_outbox (
    id text primary key,
    user_id text,
    to_email text not null,
    template text not null,
    template_version text not null,
    variables text not null
  );
  create table public.account_deletion_tombstone (
    id text primary key,
    user_id text not null,
    primary_deletion_completed_at text,
    report text not null
  );
`);

const insertUser = database.prepare(`
  insert into public."user" (id, email, status) values (?, ?, ?)
`);
const insertOutbox = database.prepare(`
  insert into public.email_outbox (
    id, user_id, to_email, template, template_version, variables
  ) values (?, ?, ?, ?, ?, ?)
`);
const decide = database.prepare(`
  select ${extractProviderBoundaryCase()} as decision
  from public.email_outbox outbox
  where outbox.id = ?
`);

function decisionFor(input: {
  status: AccountStatus;
  template: string;
  version?: string;
}) {
  database.exec(`
    delete from public.account_deletion_tombstone;
    delete from public.email_outbox;
    delete from public."user";
  `);
  insertUser.run("learner-1", "learner@example.test", input.status);
  insertOutbox.run(
    "mail-1",
    "learner-1",
    "learner@example.test",
    input.template,
    input.version ?? "1",
    "{}",
  );
  const row = decide.get("mail-1") as { decision: string } | undefined;
  return row?.decision ?? null;
}

afterAll(() => database.close());

describe("PostgresOutboxStore account template/status matrix", () => {
  it("executes the complete version-1 account truth table", () => {
    const mismatches: string[] = [];
    for (const [template, allowedStatuses] of Object.entries(ALLOWED_STATUSES)) {
      for (const status of ACCOUNT_STATUSES) {
        const expected = allowedStatuses.includes(
          status as never,
        );
        const actual = decisionFor({ status, template }) === "allowed";
        if (actual !== expected) {
          mismatches.push(`${template}/${status}: expected ${expected}, received ${actual}`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("fails closed for an unregistered account template in every status", () => {
    const unexpectedlyAllowed = ACCOUNT_STATUSES.filter(
      (status) => decisionFor({ status, template: "forged-template" }) === "allowed",
    );

    expect(unexpectedlyAllowed).toEqual([]);
  });

  it("fails closed for unsupported versions of otherwise authorized account mail", () => {
    const unexpectedlyAllowed: string[] = [];
    for (const [template, allowedStatuses] of Object.entries(ALLOWED_STATUSES)) {
      for (const status of allowedStatuses) {
        if (decisionFor({ status, template, version: "2" }) === "allowed") {
          unexpectedlyAllowed.push(`${template}/${status}`);
        }
      }
    }

    expect(unexpectedlyAllowed).toEqual([]);
  });
});
