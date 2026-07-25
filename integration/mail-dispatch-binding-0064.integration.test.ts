import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

const { Pool } = pg;
const ROW_PREFIX = "65000000-0000-4000-8000-";
const OPERATION_PREFIX = "65100000-0000-4000-8000-";
const SOURCE_PREFIX = "65200000-0000-4000-8000-";
const CLAIM_PREFIX = "65300000-0000-4000-8000-";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the 0064 integration gate`);
  return value;
}

function fixture(number: number) {
  const tail = String(number).padStart(12, "0");
  return {
    id: `${ROW_PREFIX}${tail}`,
    operationId: `${OPERATION_PREFIX}${tail}`,
    sourceId: `${SOURCE_PREFIX}${tail}`,
    claimToken: `${CLAIM_PREFIX}${tail}`,
    suffix: String(number),
  } as const;
}

function armSql(
  row: ReturnType<typeof fixture>,
  input: Readonly<{
    adapter: string;
    version: string | null;
    digest: string | null;
    leaseSeconds?: number;
    extraAssignments?: readonly string[];
  }>,
) {
  const extra = input.extraAssignments?.length
    ? `${input.extraAssignments.join(",\n       ")},\n       `
    : "";
  return `
    UPDATE public.email_outbox
       SET ${extra}provider_call_started = pg_catalog.statement_timestamp(),
           adapter = $2::text,
           dispatch_binding_version = $3::text,
           dispatch_binding_sha256 = $4::text,
           lease_expires_at = pg_catalog.statement_timestamp()
             + ($5::integer * interval '1 second'),
           updated_at = pg_catalog.statement_timestamp()
     WHERE id = $1::uuid
  `;
}

describe("0064 dispatch binding on production-pinned PostgreSQL 17", () => {
  const owner = new Pool({
    connectionString: requiredEnvironment("DATABASE_URL"),
    max: 2,
  });
  const worker = new Pool({
    connectionString: requiredEnvironment("DATABASE_WORKER_URL"),
    max: 4,
  });
  const ops = new Pool({
    connectionString: requiredEnvironment("DATABASE_OPS_URL"),
    max: 1,
  });
  const insertedIds = new Set<string>();

  async function insertAndClaim(row: ReturnType<typeof fixture>) {
    insertedIds.add(row.id);
    await owner.query(`
      INSERT INTO public.email_outbox (
        id, operation_id, user_id, delivery_scope_key, to_email, template,
        template_version, variables, idempotency_key, status,
        next_attempt_at, created_at, updated_at
      ) VALUES (
        $1::uuid,
        $2::uuid,
        NULL,
        's:' || $2::uuid::text,
        $3::text,
        'access-request-admin',
        '1',
        pg_catalog.jsonb_build_object(
          '_mailOperationId', $2::uuid::text,
          '_mailRecipient', $3::text,
          '_mailProducer', 'access-request-admin',
          '_mailSourceId', $4::uuid::text
        ),
        'dispatch-binding-pg17-' || $5::text,
        'pending',
        pg_catalog.statement_timestamp(),
        pg_catalog.statement_timestamp(),
        pg_catalog.statement_timestamp()
      );
      UPDATE public.email_outbox
         SET status = 'sending',
             attempt_count = 1,
             claim_token = $6::uuid,
             claim_owner = 'mail-dispatch-0064-pg17',
             claim_version = 1,
             lease_expires_at =
               pg_catalog.statement_timestamp() + interval '120 seconds',
             last_error_code = NULL,
             updated_at = pg_catalog.statement_timestamp()
       WHERE id = $1::uuid;
    `, [
      row.id,
      row.operationId,
      `dispatch-${row.suffix}@integration.invalid`,
      row.sourceId,
      row.suffix,
      row.claimToken,
    ]);
  }

  async function arm(
    row: ReturnType<typeof fixture>,
    input: Parameters<typeof armSql>[1],
  ) {
    return worker.query(armSql(row, input), [
      row.id,
      input.adapter,
      input.version,
      input.digest,
      input.leaseSeconds ?? 30,
    ]);
  }

  beforeAll(async () => {
    const identity = await owner.query<{
      version: string;
      effective_role: string;
      session_role: string;
    }>(`
      SELECT pg_catalog.current_setting('server_version_num') version,
             current_user::text effective_role,
             session_user::text session_role
    `);
    expect(Number(identity.rows[0]?.version)).toBeGreaterThanOrEqual(170_000);
    expect(Number(identity.rows[0]?.version)).toBeLessThan(180_000);
    expect(identity.rows[0]).toMatchObject({
      effective_role: "learncoding_owner",
      session_role: "learncoding_migrator",
    });
  });

  afterEach(async () => {
    if (insertedIds.size === 0) return;
    await owner.query(
      "DELETE FROM public.email_outbox WHERE id = ANY($1::uuid[])",
      [[...insertedIds]],
    );
    insertedIds.clear();
  });

  afterAll(async () => {
    await Promise.all([owner.end(), worker.end(), ops.end()]);
  });

  it("proves the exact post-migration catalog and direct ACL contract", async () => {
    const routine = await owner.query<{
      owner: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      grantee: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(`
      SELECT pg_catalog.pg_get_userbyid(proc.proowner) owner,
             proc.prosecdef,
             proc.proconfig,
             CASE WHEN acl.grantee = 0
               THEN 'PUBLIC'
               ELSE pg_catalog.pg_get_userbyid(acl.grantee)
             END grantee,
             acl.privilege_type,
             acl.is_grantable
        FROM pg_catalog.pg_proc proc
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          pg_catalog.coalesce(
            proc.proacl,
            pg_catalog.acldefault('f', proc.proowner)
          )
        ) acl
       WHERE proc.oid =
         'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.regprocedure
       ORDER BY grantee, privilege_type, is_grantable
    `);
    expect(routine.rows).toEqual([{
      owner: "learncoding_owner",
      prosecdef: false,
      proconfig: ["search_path=pg_catalog"],
      grantee: "learncoding_owner",
      privilege_type: "EXECUTE",
      is_grantable: false,
    }]);

    const columns = await owner.query<{
      name: string;
      type: string;
      not_null: boolean;
      generated: string;
      default_expression: string | null;
      grantee: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(`
      SELECT attribute.attname name,
             pg_catalog.format_type(
               attribute.atttypid,
               attribute.atttypmod
             ) type,
             attribute.attnotnull not_null,
             attribute.attgenerated generated,
             pg_catalog.pg_get_expr(
               default_value.adbin,
               default_value.adrelid
             ) default_expression,
             CASE WHEN acl.grantee = 0
               THEN 'PUBLIC'
               ELSE pg_catalog.pg_get_userbyid(acl.grantee)
             END grantee,
             acl.privilege_type,
             acl.is_grantable
        FROM pg_catalog.pg_attribute attribute
        LEFT JOIN pg_catalog.pg_attrdef default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          pg_catalog.coalesce(
            attribute.attacl,
            '{}'::pg_catalog.aclitem[]
          )
        ) acl
       WHERE attribute.attrelid =
         'public.email_outbox'::pg_catalog.regclass
         AND attribute.attname IN (
           'dispatch_binding_version',
           'dispatch_binding_sha256'
         )
       ORDER BY name, grantee, privilege_type, is_grantable
    `);
    expect(columns.rows).toEqual([
      {
        name: "dispatch_binding_sha256",
        type: "text",
        not_null: false,
        generated: "",
        default_expression: null,
        grantee: "learncoding_worker",
        privilege_type: "UPDATE",
        is_grantable: false,
      },
      {
        name: "dispatch_binding_version",
        type: "text",
        not_null: false,
        generated: "",
        default_expression: null,
        grantee: "learncoding_worker",
        privilege_type: "UPDATE",
        is_grantable: false,
      },
    ]);

    const trigger = await owner.query<{
      tgenabled: string;
      tgtype: number;
      tgqual: string | null;
      tgnargs: number;
      tgattr: string;
      function_name: string;
      constraint_validated: boolean;
    }>(`
      SELECT trigger.tgenabled,
             trigger.tgtype::integer,
             trigger.tgqual::text,
             trigger.tgnargs::integer,
             trigger.tgattr::text,
             function_data.proname::text function_name,
             constraint_data.convalidated constraint_validated
        FROM pg_catalog.pg_trigger trigger
        JOIN pg_catalog.pg_proc function_data
          ON function_data.oid = trigger.tgfoid
        JOIN pg_catalog.pg_constraint constraint_data
          ON constraint_data.conrelid = trigger.tgrelid
         AND constraint_data.conname =
           'email_outbox_dispatch_binding_valid'
       WHERE trigger.tgrelid =
         'public.email_outbox'::pg_catalog.regclass
         AND trigger.tgname = 'email_outbox_dispatch_binding_guard'
         AND NOT trigger.tgisinternal
    `);
    expect(trigger.rows).toEqual([{
      tgenabled: "O",
      tgtype: 23,
      tgqual: null,
      tgnargs: 0,
      tgattr: "",
      function_name: "enforce_email_outbox_dispatch_binding()",
      constraint_validated: true,
    }]);
  });

  it("accepts only exact one-shot Gmail/console arms and denies old-code shapes", async () => {
    const gmail = fixture(210);
    const consoleRow = fixture(211);
    await Promise.all([insertAndClaim(gmail), insertAndClaim(consoleRow)]);

    await expect(arm(gmail, {
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "a".repeat(64),
    })).resolves.toMatchObject({ rowCount: 1 });
    await expect(arm(consoleRow, {
      adapter: "console",
      version: "console-json-v1",
      digest: "b".repeat(64),
    })).resolves.toMatchObject({ rowCount: 1 });

    const invalidCases = [
      ["gmail", "gmail-raw-v1", null, 30],
      ["gmail", null, "a".repeat(64), 30],
      ["gmail", "console-json-v1", "a".repeat(64), 30],
      ["console", "gmail-raw-v1", "a".repeat(64), 30],
      ["gmail", "gmail-raw-v1", "A".repeat(64), 30],
      ["gmail", "gmail-raw-v1", "g".repeat(64), 30],
      ["gmail", "gmail-raw-v1", "a".repeat(63), 30],
      ["gmail", "gmail-raw-v1", "a".repeat(65), 30],
      ["gmail", "gmail-raw-v1", "a".repeat(64), 14],
      ["gmail", "gmail-raw-v1", "a".repeat(64), 301],
    ] as const;
    for (const [index, testCase] of invalidCases.entries()) {
      const row = fixture(220 + index);
      await insertAndClaim(row);
      await expect(arm(row, {
        adapter: testCase[0],
        version: testCase[1],
        digest: testCase[2],
        leaseSeconds: testCase[3],
      })).rejects.toMatchObject({ code: "23514" });
    }

    const prebinding = fixture(240);
    await insertAndClaim(prebinding);
    await expect(worker.query(`
      UPDATE public.email_outbox
         SET dispatch_binding_version = 'gmail-raw-v1',
             dispatch_binding_sha256 = $2::text
       WHERE id = $1::uuid
    `, [prebinding.id, "a".repeat(64)])).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("enforces direct worker identity, state immutability, and negative privileges", async () => {
    const ownerAttempt = fixture(250);
    const stateAttempt = fixture(251);
    await Promise.all([
      insertAndClaim(ownerAttempt),
      insertAndClaim(stateAttempt),
    ]);

    await expect(owner.query(
      armSql(ownerAttempt, {
        adapter: "gmail",
        version: "gmail-raw-v1",
        digest: "a".repeat(64),
      }),
      [ownerAttempt.id, "gmail", "gmail-raw-v1", "a".repeat(64), 30],
    )).rejects.toMatchObject({ code: "42501" });
    await expect(arm(stateAttempt, {
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "a".repeat(64),
      extraAssignments: ["attempt_count = attempt_count + 1"],
    })).rejects.toMatchObject({ code: "23514" });
    await expect(worker.query(
      "UPDATE public.email_outbox SET to_email = $2 WHERE id = $1::uuid",
      [stateAttempt.id, "forbidden@integration.invalid"],
    )).rejects.toMatchObject({ code: "42501" });
    await expect(worker.query(
      "DELETE FROM public.email_outbox WHERE id = $1::uuid",
      [stateAttempt.id],
    )).rejects.toMatchObject({ code: "42501" });
    await expect(worker.query(`
      INSERT INTO public.email_outbox (
        operation_id, user_id, delivery_scope_key, to_email, template,
        template_version, variables, idempotency_key,
        dispatch_binding_version, dispatch_binding_sha256
      ) VALUES (
        $1::uuid, NULL, 's:' || $1::uuid::text, $2::text,
        'access-request-admin', '1',
        pg_catalog.jsonb_build_object(
          '_mailOperationId', $1::uuid::text,
          '_mailRecipient', $2::text,
          '_mailProducer', 'access-request-admin',
          '_mailSourceId', $3::uuid::text
        ),
        'dispatch-binding-pg17-worker-insert',
        NULL, NULL
      )
    `, [
      `${OPERATION_PREFIX}000000000298`,
      "insert-binding@integration.invalid",
      `${SOURCE_PREFIX}000000000298`,
    ])).rejects.toMatchObject({ code: "42501" });
  });

  it("proves rollback, competing-arm CAS, and 0063 redaction preservation", async () => {
    const rollbackRow = fixture(260);
    const raceRow = fixture(261);
    const redactionRow = fixture(262);
    await Promise.all([
      insertAndClaim(rollbackRow),
      insertAndClaim(raceRow),
      insertAndClaim(redactionRow),
    ]);

    const rollbackClient = await worker.connect();
    try {
      await rollbackClient.query("BEGIN");
      await rollbackClient.query(
        armSql(rollbackRow, {
          adapter: "gmail",
          version: "gmail-raw-v1",
          digest: "c".repeat(64),
        }),
        [rollbackRow.id, "gmail", "gmail-raw-v1", "c".repeat(64), 30],
      );
      await rollbackClient.query("ROLLBACK");
    } finally {
      rollbackClient.release();
    }
    const rolledBack = await owner.query(
      `SELECT provider_call_started, dispatch_binding_version
         FROM public.email_outbox WHERE id = $1::uuid`,
      [rollbackRow.id],
    );
    expect(rolledBack.rows[0]).toEqual({
      provider_call_started: null,
      dispatch_binding_version: null,
    });

    const raceStatement =
      `${armSql(raceRow, {
        adapter: "gmail",
        version: "gmail-raw-v1",
        digest: "d".repeat(64),
      })}
       AND provider_call_started IS NULL
       AND adapter IS NULL
       AND dispatch_binding_version IS NULL
       AND dispatch_binding_sha256 IS NULL
       RETURNING id`;
    const raceResults = await Promise.all([
      worker.query(raceStatement, [
        raceRow.id, "gmail", "gmail-raw-v1", "d".repeat(64), 30,
      ]),
      worker.query(raceStatement, [
        raceRow.id, "gmail", "gmail-raw-v1", "d".repeat(64), 30,
      ]),
    ]);
    expect(raceResults.map(({ rowCount }) => rowCount).sort()).toEqual([0, 1]);

    await arm(redactionRow, {
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "e".repeat(64),
    });
    await worker.query(`
      UPDATE public.email_outbox
         SET status = 'quarantined',
             claim_token = NULL,
             claim_owner = NULL,
             lease_expires_at = NULL,
             quarantined_at =
               pg_catalog.statement_timestamp() - interval '31 days',
             last_error_code = 'GMAIL_RESULT_UNKNOWN',
             updated_at =
               pg_catalog.statement_timestamp() - interval '31 days'
       WHERE id = $1::uuid
    `, [redactionRow.id]);
    const redactionSummary = await ops.query<{
      disposition: string;
      eligible: string;
      transitioned: string;
    }>(`
      SELECT disposition, eligible::text, transitioned::text
        FROM public.redact_unresolved_email_outbox_authority(
          pg_catalog.statement_timestamp() - interval '30 days',
          1000
        )
    `);
    const eligibleSummary = redactionSummary.rows.find(
      ({ disposition }) => disposition === "eligible",
    );
    expect(eligibleSummary).toBeDefined();
    expect(Number(eligibleSummary?.eligible)).toBeGreaterThanOrEqual(1);
    expect(Number(eligibleSummary?.transitioned)).toBeGreaterThanOrEqual(1);
    expect(Number(eligibleSummary?.eligible)).toBeGreaterThanOrEqual(
      Number(eligibleSummary?.transitioned),
    );
    const preserved = await owner.query<{
      to_email: string;
      dispatch_binding_version: string;
      dispatch_binding_sha256: string;
    }>(`
      SELECT to_email, dispatch_binding_version, dispatch_binding_sha256
        FROM public.email_outbox WHERE id = $1::uuid
    `, [redactionRow.id]);
    expect(preserved.rows[0]).toEqual({
      to_email: `redacted+${redactionRow.id}@invalid.local`,
      dispatch_binding_version: "gmail-raw-v1",
      dispatch_binding_sha256: "e".repeat(64),
    });
  });
});
