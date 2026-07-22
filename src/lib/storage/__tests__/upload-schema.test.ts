import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { uploadReceipt } from "@/lib/db/schema";

describe("durable upload receipt schema", () => {
  it("binds one canonical owner UUID request to one immutable stored object", () => {
    expect(getTableName(uploadReceipt)).toBe("upload_receipt");
    const config = getTableConfig(uploadReceipt);
    expect(config.primaryKeys.map((key) => key.columns.map((column) => column.name)))
      .toContainEqual(["owner_user_id", "idempotency_key"]);
    expect(config.indexes.some((index) => index.config.name === "upload_receipt_object_unique" && index.config.unique))
      .toBe(true);
    expect(config.foreignKeys.map((key) => key.reference().foreignTable)).toEqual(expect.arrayContaining([
      expect.objectContaining({ [Symbol.for("drizzle:Name")]: "user" }),
      expect.objectContaining({ [Symbol.for("drizzle:Name")]: "stored_object" }),
    ]));
  });

  it("requires a versioned request hash at the database boundary", () => {
    const checks = getTableConfig(uploadReceipt).checks.map((check) => check.name);
    expect(checks).toContain("upload_receipt_request_hash_check");
  });
});
