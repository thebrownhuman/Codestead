import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { recordProviderCredentialOutcome } from "@/lib/ai/provider-credential-outcome";
import { pool } from "@/lib/db/client";

const USER = "provider-outcome-learner";
const CREDENTIAL = "71000000-0000-4000-8000-000000000001";
const ORIGINAL = new Date("2026-07-12T08:00:00.000Z");
const OUTCOME_AT = new Date("2026-07-12T09:00:00.000Z");

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Provider outcome integration tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const tables = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`);
  const names = tables.rows.map((row) => `"${row.table_name.replaceAll('"', '""')}"`).join(",");
  if (names) await pool.query(`truncate table ${names} restart identity cascade`);
}

async function row() {
  return (await pool.query<{
    status: string;
    key_version: number;
    updated_at: Date;
    last_used_at: Date | null;
    failure_code: string | null;
    ciphertext: string;
  }>(
    `select status,key_version,updated_at,last_used_at,failure_code,ciphertext
       from provider_credential where id = $1`,
    [CREDENTIAL],
  )).rows[0]!;
}

const snapshot = () => ({
  id: CREDENTIAL,
  userId: USER,
  keyVersion: 1,
  updatedAtToken: "2026-07-12T08:00:00.000000Z",
});

beforeEach(async () => {
  await truncateApplicationTables();
  await pool.query(
    `insert into "user" (id,public_id,name,email,role,status,email_verified,two_factor_enabled,created_at,updated_at)
     values ($1,'70000000-0000-4000-8000-000000000001','Asha','asha-provider-outcome@integration.invalid',
             'learner','active',true,true,$2,$2)`,
    [USER, ORIGINAL],
  );
  await pool.query(
    `insert into provider_credential
      (id,user_id,provider,label,ciphertext,wrapped_data_key,wrap_iv,data_iv,auth_tag,key_version,last_four,
       status,is_preferred,created_at,updated_at)
     values ($1,$2,'nvidia_nim','Primary','cipher-v1','wrapped','wrap-iv','data-iv','tag',1,'1234',
             'active',true,$3,$3)`,
    [CREDENTIAL, USER, ORIGINAL],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL provider credential outcome CAS", () => {
  it("records success without writing an active status transition", async () => {
    await expect(recordProviderCredentialOutcome({
      snapshot: snapshot(),
      outcome: { kind: "success" },
      now: OUTCOME_AT,
    })).resolves.toEqual({ applied: true });
    expect(await row()).toMatchObject({
      status: "active",
      key_version: 1,
      updated_at: OUTCOME_AT,
      last_used_at: OUTCOME_AT,
      failure_code: null,
    });
  });

  it("does not re-enable or update a credential disabled after request selection", async () => {
    await pool.query(
      `update provider_credential set status = 'disabled',disabled_at = $2 where id = $1`,
      [CREDENTIAL, OUTCOME_AT],
    );
    await expect(recordProviderCredentialOutcome({
      snapshot: snapshot(),
      outcome: { kind: "success" },
      now: new Date("2026-07-12T10:00:00.000Z"),
    })).resolves.toEqual({ applied: false });
    expect(await row()).toMatchObject({ status: "disabled", last_used_at: null, key_version: 1 });
  });

  it("does not overwrite a concurrently replaced key even when status and timestamp otherwise match", async () => {
    await pool.query(
      `update provider_credential
          set key_version = 2,ciphertext = 'cipher-v2',failure_code = 'replacement-wins'
        where id = $1`,
      [CREDENTIAL],
    );
    await expect(recordProviderCredentialOutcome({
      snapshot: snapshot(),
      outcome: { kind: "failure", code: "AUTHENTICATION" },
      now: OUTCOME_AT,
    })).resolves.toEqual({ applied: false });
    expect(await row()).toMatchObject({
      status: "active",
      key_version: 2,
      ciphertext: "cipher-v2",
      failure_code: "replacement-wins",
    });
  });

  it("does not overwrite a concurrent active-row administration update protected by updated_at", async () => {
    const concurrentAt = new Date("2026-07-12T08:30:00.000Z");
    await pool.query(
      `update provider_credential set failure_code = 'admin-test-wins',updated_at = $2 where id = $1`,
      [CREDENTIAL, concurrentAt],
    );
    await expect(recordProviderCredentialOutcome({
      snapshot: snapshot(),
      outcome: { kind: "failure", code: "RATE_LIMIT" },
      now: OUTCOME_AT,
    })).resolves.toEqual({ applied: false });
    expect(await row()).toMatchObject({
      status: "active",
      key_version: 1,
      updated_at: concurrentAt,
      failure_code: "admin-test-wins",
    });
  });

  it("applies an authentication failure only to the unchanged active snapshot", async () => {
    await expect(recordProviderCredentialOutcome({
      snapshot: snapshot(),
      outcome: { kind: "failure", code: "AUTHENTICATION" },
      now: OUTCOME_AT,
    })).resolves.toEqual({ applied: true });
    expect(await row()).toMatchObject({
      status: "invalid",
      key_version: 1,
      updated_at: OUTCOME_AT,
      failure_code: "AUTHENTICATION",
      last_used_at: null,
    });
  });
});
