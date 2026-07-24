import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function route(path: string) {
  return readFileSync(resolve(process.cwd(), "src/app/api", path), "utf8")
    .replace(/\s+/g, " ")
    .replace(/\s*\.\s*/g, ".");
}

describe("access-request system-mail producers", () => {
  it("persists a new request and its admin notice in one transaction", () => {
    const source = route("access-requests/route.ts");
    const transaction = source.indexOf("db.transaction(async (tx)");
    const requestInsert = source.indexOf(
      "tx.insert(accessRequest)",
      transaction,
    );
    const adminLookup = source.indexOf(".from(user)", requestInsert);
    const mailInsert = source.indexOf(
      "enqueueEmailInTransaction(tx",
      adminLookup,
    );

    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(requestInsert).toBeGreaterThan(transaction);
    expect(source).toContain(".returning({ id: accessRequest.id })");
    expect(adminLookup).toBeGreaterThan(requestInsert);
    expect(mailInsert).toBeGreaterThan(adminLookup);
    expect(source).toContain('template: "access-request-admin"');
    expect(source).toContain('systemProducer: "access-request-admin"');
    expect(source).toContain("sourceId: created.id");
    expect(source).not.toContain("BOOTSTRAP_ADMIN_EMAIL");
    expect(source).not.toContain("enqueueEmail({");
  });

  it("persists approval, invitation, and invitation mail in one transaction", () => {
    const source = route("admin/access-requests/[id]/approve/route.ts");
    const transaction = source.indexOf("db.transaction(async (tx)");
    const invitationInsert = source.indexOf(
      "tx.insert(invitation)",
      transaction,
    );
    const decisionUpdate = source.indexOf(
      "tx.update(accessRequest)",
      invitationInsert,
    );
    const mailInsert = source.indexOf(
      "enqueueEmailInTransaction(tx",
      decisionUpdate,
    );

    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(invitationInsert).toBeGreaterThan(transaction);
    expect(decisionUpdate).toBeGreaterThan(invitationInsert);
    expect(mailInsert).toBeGreaterThan(decisionUpdate);
    expect(source).toContain('systemProducer: "access-request-approved"');
    expect(source).toContain("sourceId: invitationId");
    expect(source).not.toContain("enqueueEmail({");
  });

  it("persists rejection and rejection mail in one transaction", () => {
    const source = route("admin/access-requests/[id]/reject/route.ts");
    const transaction = source.indexOf("db.transaction(async (tx)");
    const decisionUpdate = source.indexOf(
      "tx.update(accessRequest)",
      transaction,
    );
    const mailInsert = source.indexOf(
      "enqueueEmailInTransaction(tx",
      decisionUpdate,
    );

    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(decisionUpdate).toBeGreaterThan(transaction);
    expect(mailInsert).toBeGreaterThan(decisionUpdate);
    expect(source).toContain('systemProducer: "access-request-rejected"');
    expect(source).toContain("sourceId: pending.id");
    expect(source).not.toContain("enqueueEmail({");
  });
});
