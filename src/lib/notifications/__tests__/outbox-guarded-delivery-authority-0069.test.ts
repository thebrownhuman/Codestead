import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vitest";

import { emailOutbox, mailDeliveryReleaseReceipt } from "@/lib/db/schema";

const migrationPath = resolve(
  process.cwd(),
  "drizzle",
  "0069_mail_outbox_guarded_delivery_authority.sql",
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").toLowerCase()
  : "";
const compactMigration = migration.replace(/\s+/gu, " ");
const schema = readFileSync(
  resolve(process.cwd(), "src/lib/db/schema.ts"),
  "utf8",
);
const outboxSchemaStart = schema.indexOf("export const emailOutbox =");
const receiptSchemaStart = schema.indexOf(
  "export const mailDeliveryReleaseReceipt",
);
const receiptSchemaEnd = schema.indexOf(
  "export const inactivityEpisode =",
  receiptSchemaStart,
);
const outboxSchema = schema.slice(outboxSchemaStart, receiptSchemaStart);
const receiptSchema = schema.slice(receiptSchemaStart, receiptSchemaEnd);

type SnapshotTable = {
  columns: Record<
    string,
    {
      name: string;
      type: string;
      primaryKey: boolean;
      notNull: boolean;
      default?: string;
    }
  >;
  indexes: Record<string, unknown>;
  foreignKeys: Record<
    string,
    {
      name: string;
      tableFrom: string;
      tableTo: string;
      columnsFrom: string[];
      columnsTo: string[];
      onDelete: string;
      onUpdate: string;
    }
  >;
  uniqueConstraints: Record<
    string,
    {
      name: string;
      nullsNotDistinct: boolean;
      columns: string[];
    }
  >;
  checkConstraints: Record<
    string,
    {
      name: string;
      value: string;
    }
  >;
};
type Snapshot = {
  id: string;
  prevId: string;
  version: string;
  dialect: string;
  tables: Record<string, SnapshotTable>;
};
const metaDirectory = resolve(process.cwd(), "drizzle", "meta");
const readSnapshot = (name: string) =>
  JSON.parse(
    readFileSync(resolve(metaDirectory, `${name}_snapshot.json`), "utf8"),
  ) as Snapshot;
const snapshot0067 = readSnapshot("0067");
const snapshot0068 = readSnapshot("0068");
const snapshot0069 = readSnapshot("0069");
const journal = JSON.parse(
  readFileSync(resolve(metaDirectory, "_journal.json"), "utf8"),
) as {
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};
const withoutSnapshotIdentity = (snapshot: Snapshot) =>
  Object.fromEntries(
    Object.entries(snapshot).filter(
      ([key]) => key !== "id" && key !== "prevId",
    ),
  );
const addedKeys = (
  predecessor: Record<string, unknown>,
  successor: Record<string, unknown>,
) =>
  Object.keys(successor)
    .filter((key) => !(key in predecessor))
    .sort();

function functionBody(name: string) {
  const start = migration.search(
    new RegExp(
      `create(?: or replace)? function\\s+"?public"?\\."?${name}"?\\s*\\(`,
      "u",
    ),
  );
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf("$function$;", start);
  expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
  return migration.slice(start, end);
}

function dollarBlock(name: string) {
  const marker = `$${name}$`;
  const start = migration.indexOf(`do ${marker}`);
  expect(start, `${name} block must exist`).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf(`${marker};`, start + marker.length);
  expect(end, `${name} block must be bounded`).toBeGreaterThan(start);
  return migration.slice(start, end);
}

function schemaCheckSql(source: string, name: string) {
  const nameMarker = `"${name}"`;
  const start = source.indexOf(nameMarker);
  expect(
    start,
    `${name} must exist in its scoped schema`,
  ).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(nameMarker, start + nameMarker.length)).toBe(-1);
  const sqlStart = source.indexOf("sql`", start + nameMarker.length);
  expect(sqlStart, `${name} must own one SQL template`).toBeGreaterThan(start);
  const sqlEnd = source.indexOf("`", sqlStart + 4);
  expect(sqlEnd, `${name} SQL template must be bounded`).toBeGreaterThan(
    sqlStart,
  );
  return source
    .slice(sqlStart, sqlEnd + 1)
    .replace(/\s+/gu, " ")
    .trim();
}

describe("0069 guarded delivery release authority", () => {
  it("registers the exact 0067-to-0069 snapshot lineage and journal tail", () => {
    expect(snapshot0067.id).toBe("2a926997-45e8-45f3-9455-45d0ece8e54d");
    expect(snapshot0068).toMatchObject({
      id: "c42a819d-8944-49e6-913e-ab30d59e1755",
      prevId: snapshot0067.id,
      version: "7",
      dialect: "postgresql",
    });
    expect(snapshot0069).toMatchObject({
      id: "44745a18-9cab-4fe2-97ed-f25eef12af95",
      prevId: snapshot0068.id,
      version: "7",
      dialect: "postgresql",
    });
    expect(snapshot0068.id).not.toBe(snapshot0067.id);
    expect(snapshot0069.id).not.toBe(snapshot0068.id);
    expect(journal.entries).toHaveLength(70);
    expect(journal.entries.map(({ idx }) => idx)).toEqual(
      Array.from({ length: 70 }, (_, idx) => idx),
    );
    expect(journal.entries.slice(-2)).toEqual([
      {
        idx: 68,
        version: "7",
        when: 1785005772253,
        tag: "0068_mail_outbox_quarantine_redaction_authority_v2",
        breakpoints: true,
      },
      {
        idx: 69,
        version: "7",
        when: 1785009372253,
        tag: "0069_mail_outbox_guarded_delivery_authority",
        breakpoints: true,
      },
    ]);
  });

  it("freezes the exact schema-neutral 0068 and structural 0069 snapshot delta", () => {
    expect(withoutSnapshotIdentity(snapshot0068)).toEqual(
      withoutSnapshotIdentity(snapshot0067),
    );
    expect(addedKeys(snapshot0068.tables, snapshot0069.tables)).toEqual([
      "public.mail_delivery_release_receipt",
    ]);
    expect(addedKeys(snapshot0069.tables, snapshot0068.tables)).toEqual([]);

    const outbox0068 = snapshot0068.tables["public.email_outbox"];
    const outbox0069 = snapshot0069.tables["public.email_outbox"];
    expect(outbox0068).toBeDefined();
    expect(outbox0069).toBeDefined();
    expect(addedKeys(outbox0068.columns, outbox0069.columns)).toEqual([
      "delivery_release_insert_system_identifier",
      "delivery_release_insert_xid",
      "provider_request_body_length",
      "provider_request_body_sha256",
    ]);
    expect(addedKeys(outbox0068.indexes, outbox0069.indexes)).toEqual([]);
    expect(addedKeys(outbox0068.foreignKeys, outbox0069.foreignKeys)).toEqual(
      [],
    );
    expect(
      addedKeys(outbox0068.uniqueConstraints, outbox0069.uniqueConstraints),
    ).toEqual(["email_outbox_delivery_release_parent_unique"]);
    expect(
      addedKeys(outbox0068.checkConstraints, outbox0069.checkConstraints),
    ).toEqual([
      "email_outbox_attempt_count_nonnegative",
      "email_outbox_delivery_release_insert_identity_valid",
      "email_outbox_provider_request_body_valid",
    ]);
    expect(
      Object.fromEntries(
        [
          "delivery_release_insert_xid",
          "delivery_release_insert_system_identifier",
          "provider_request_body_sha256",
          "provider_request_body_length",
        ].map((name) => [name, outbox0069.columns[name]]),
      ),
    ).toEqual({
      delivery_release_insert_xid: {
        name: "delivery_release_insert_xid",
        type: "xid8",
        primaryKey: false,
        notNull: false,
      },
      delivery_release_insert_system_identifier: {
        name: "delivery_release_insert_system_identifier",
        type: "bigint",
        primaryKey: false,
        notNull: false,
      },
      provider_request_body_sha256: {
        name: "provider_request_body_sha256",
        type: "text",
        primaryKey: false,
        notNull: false,
      },
      provider_request_body_length: {
        name: "provider_request_body_length",
        type: "bigint",
        primaryKey: false,
        notNull: false,
      },
    });

    const receipt = snapshot0069.tables["public.mail_delivery_release_receipt"];
    expect(receipt).toBeDefined();
    expect(Object.keys(receipt.columns)).toEqual([
      "outbox_id",
      "operation_id",
      "idempotency_authority_version",
      "idempotency_authority_sha256",
      "idempotency_original_payload_sha256",
      "release_version",
      "release_receipt_sha256",
      "released_at",
    ]);
    expect(Object.keys(receipt.indexes)).toEqual([
      "mail_delivery_release_receipt_authority_fk_idx",
    ]);
    expect(Object.keys(receipt.foreignKeys).sort()).toEqual([
      "mail_delivery_release_receipt_idempotency_authority_fk",
      "mail_delivery_release_receipt_outbox_fk",
    ]);
    expect(Object.keys(receipt.uniqueConstraints).sort()).toEqual([
      "mail_delivery_release_receipt_digest_unique",
      "mail_delivery_release_receipt_operation_unique",
    ]);
    expect(Object.keys(receipt.checkConstraints).sort()).toEqual([
      "mail_delivery_release_receipt_authority_version_valid",
      "mail_delivery_release_receipt_digest_exact",
      "mail_delivery_release_receipt_digest_valid",
      "mail_delivery_release_receipt_release_version_valid",
    ]);
  });

  it("adds a forward-only successor without rewriting 0067 or 0068", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(compactMigration).toContain(
      "lock table only public.email_outbox in access exclusive mode nowait",
    );
    expect(migration).toContain("set local search_path = pg_catalog, pg_temp");
    expect(migration).toContain("do $preflight$");
    expect(migration).toContain("public.enforce_email_outbox_delivery_hold()");
    expect(migration).toContain("public.email_outbox_idempotency_authority");
    expect(migration).toContain("delivery_hold_version");
    expect(migration).toContain("'task7-v1'");
  });

  it("pins PostgreSQL 17 and 18 default statistics targets as null", () => {
    expect(migration).toContain("attribute.attstattarget is null");
    expect(migration).not.toContain("attribute.attstattarget = -1");
    expect(compactMigration).toContain(
      "constraint_row.connoinherit = (constraint_row.contype in ('p', 'u'))",
    );
    for (const definition of [
      "check ((authority_epoch <> ''00000000-0000-0000-0000-000000000000''::uuid))",
      "check ((outcome = any (array[''success''::text, ''failure''::text])))",
      "check ((singleton is true))",
    ]) {
      expect(migration).toContain(definition);
    }
    expect(migration.match(/from rows from \(/gu)).toHaveLength(2);
    expect(migration).not.toMatch(
      /from pg_catalog[.]unnest\(\s*index_row[.]indkey::pg_catalog[.]int2\[\],\s*index_row[.]indclass/gu,
    );
    for (const definitionHash of [
      "8504298d876a6fe1256f13441fe84681d0f8f47fe29cac2d42763c068e98ee7d",
      "150ec4c692f4f6c6247fce236d2ec7ea1b65f4b1f2864e201345867b814e9f60",
      "b766a3512540a3d511a8126d87e9cbcd40847a87ea82ce27bdb2838290d97ec3",
      "a29a285813afa8d466198900f29680f46be35ec4c511fbcf656c78fcb9b21844",
      "ca95ebd3100dca787652477a7d0a3b63282a616777b44069557f503a7952a0f2",
      "295db3f75181663dd4491b4a84d53617179965e2a0a156995b721e53ab9c5fb1",
      "6d944b1dd9ef5cfaa4371d204569f27134bf2431dd61a078b0722a3a782da6b6",
      "9516f96ef9133bdf61f6db352422d521cf4616c6bd5b365888f1c614670ed409",
      "8e50e51aae34e3657a6a2d9d90fc546025512f2678b083e824a5cc0f8457ee5f",
    ]) {
      expect(migration).toContain(definitionHash);
    }
    expect(compactMigration).toContain(
      "case when successor_relation is null then 'ac406b4dff127c10f791267c1464faddbe93e8ce88faa0a52c215881ac1b7480' else '2cc0bf920b31af64566f1eb0352bd63f078bcccab3d064748ba5af226805c81b' end",
    );
  });
  it("fails before mutation on altered successor hold or trigger bindings", () => {
    const preflight = dollarBlock("preflight");
    const compactPreflight = preflight.replace(/\s+/gu, " ");
    expect(compactPreflight).toContain("into successor_triggers from (values");
    expect(preflight).toContain(
      "7636ab37cc17692c0c31d160dc5d7f0421d6660c0da2dfb6a2d8cae4501ea4e1",
    );
    for (const marker of [
      "claim_email_outbox_idempotency_authority",
      "persist_email_outbox_idempotency_authority",
      "email_outbox_idempotency_claim",
      "00_email_outbox_idempotency_persist",
      "9b0b6468cb0aad890bd78ecfa68bdab9f476d5f93a9841d515e0cea019926499",
      "43e5df19b455c36648574e1d7c33c10cb959fc3bddd83e6ed67035031f246cbd",
    ]) {
      expect(preflight).toContain(marker);
    }
  });
  it("attests every inherited mail-authority routine before and after cutover", () => {
    const preflight = dollarBlock("preflight");
    const terminal = dollarBlock("verify_terminal_catalog");
    for (const definitionHash of [
      "b3ba15cae78eaf8e3535b28c0764e9715683e15ab85b0814089e3e54715f4676",
      "afaab6796f97aa0294ff5a761679895f9ccfb78fea21e0be362979c5c4e5ab11",
      "a26ccda1f7f4d623c7ea2b1611ff9f5c424cee386f79a7a8ffbf2a58c51ce2e9",
      "2ae733ebe79975ce70fa9427ccb92295ecf8acad75797e8541bbb15bd9318790",
      "2efbc33e8ee9dd33402f11682697f4e522cd9e7e3c70c8bf820f533b37aec1ac",
      "8331736656001b0bb0fa5d303667353846ea4ff39c3f5aeba71979141f2dc612",
      "29ee2d3b4bf45322c9c68a3bc612084a460bfca3e54e7c2c044081d195fbe2b7",
      "c5e22b06c168cb1aa4099f3b3c66cc959b4a0b116313d2bce8fa3a3d9d77197b",
      "4890f478c8d14811e7f6829a3a4977e0da3924c8e8c84b8ca89b64496ac40f53",
      "35691db9ef3153adf2e19ebae539341797f7b4fd2a27aec1db215b9533636ed8",
      "365bd47aab3ce58ca2b894c7eb77ed12cb759fc3683599ef5ae987e4414f1d3c",
      "02d83d883c8f4c0b4fc22c460353834d27a67becdd96d81cee8b74609521f334",
    ]) {
      expect(preflight).toContain(definitionHash);
      expect(terminal).toContain(definitionHash);
    }
    for (const contract of [preflight, terminal]) {
      expect(contract).toContain("pg_catalog.pg_get_functiondef");
      expect(contract).toContain("expected_digest_helpers");
      expect(contract).toContain("email_outbox_original_payload_sha256");
      expect(contract).toContain("email_outbox_event_sha256");
      expect(contract).toContain("pg_catalog.aclexplode");
      expect(contract).toContain("expected_inherited_routines");
      expect(contract).toContain("actual_inherited_routines");
    }
  });
  it("rejects inherited outbox authority and reads only reviewed parents", () => {
    const preflight = dollarBlock("preflight");
    for (const marker of [
      "relation.relispartition",
      "pg_catalog.pg_inherits",
      "pg_catalog.pg_partitioned_table",
      "pg_catalog.pg_policy",
      "pg_catalog.pg_rewrite",
    ]) {
      expect(preflight).toContain(marker);
    }
    expect(preflight.replace(/\s+/gu, " ")).toContain(
      "case when successor_relation is null then 33 else 37 end",
    );
    expect(preflight).toContain(
      "c75e00f22207c36e83e3afd99a6553e1be9b50bef41e2caf91f93443a2082d9c",
    );
    expect(preflight).toContain("attribute.attname = 'status'");
    expect(preflight.replace(/\s+/gu, " ")).toContain(
      "outbox.status is null or outbox.status not in",
    );
    expect(migration).not.toMatch(/\bfrom public\.email_outbox\b/u);
    expect(migration).not.toMatch(/\bjoin public\.email_outbox\b/u);
    expect(migration).not.toMatch(/\bupdate public\.email_outbox\b/u);
    expect(migration).not.toMatch(
      /\bfrom public\.email_outbox_idempotency_authority\b/u,
    );
    expect(compactMigration).toContain(
      "update only public.email_outbox as outbox",
    );
  });

  it("creates the reserved owner-owned append-only receipt relation", () => {
    expect(migration).toContain(
      "create table public.mail_delivery_release_receipt",
    );

    for (const column of [
      "outbox_id",
      "operation_id",
      "idempotency_authority_version",
      "idempotency_authority_sha256",
      "idempotency_original_payload_sha256",
      "release_version",
      "release_receipt_sha256",
      "released_at",
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain(
      "alter table public.mail_delivery_release_receipt",
    );
    expect(migration).toContain("owner to learncoding_owner");
    expect(migration).toContain("primary key (outbox_id)");
    expect(migration).toContain("unique (operation_id)");
    expect(migration).toContain("unique (release_receipt_sha256)");
    expect(migration).toMatch(
      /idempotency_authority_sha256\s+pg_catalog\.text\s+not null/u,
    );
    expect(migration).toMatch(
      /idempotency_original_payload_sha256\s+pg_catalog\.text\s+not null/u,
    );
    expect(compactMigration).toMatch(
      /idempotency_authority_version in\s*\(\s*'event-v1-native',\s*'event-v1-source-map'\s*\)/u,
    );
    expect(compactMigration).toMatch(
      /foreign key\s*\(\s*idempotency_authority_sha256,\s*idempotency_original_payload_sha256\s*\)/u,
    );
    expect(migration).toContain(
      "references public.email_outbox_idempotency_authority",
    );
    expect(migration).toContain("on update restrict");
    expect(migration).toContain("on delete restrict");
    expect(migration).toContain("deferrable initially deferred");
    expect(compactMigration).toMatch(
      /constraint email_outbox_delivery_release_parent_unique unique\s*\(\s*id,\s*operation_id\s*\)/u,
    );
    expect(compactMigration).toMatch(
      /constraint mail_delivery_release_receipt_outbox_fk foreign key\s*\(\s*outbox_id,\s*operation_id\s*\)\s*references public\.email_outbox\s*\(\s*id,\s*operation_id\s*\)\s*on update restrict\s*on delete cascade\s*not deferrable/u,
    );
    expect(migration).toContain("release_version = 'task7-v1'");
    expect(migration).toMatch(
      /release_receipt_sha256\s+~\s+'\^\[0-9a-f\]\{64\}\$'/u,
    );
    expect(migration).toMatch(
      /release_receipt_sha256\s*=\s*public\.mail_delivery_release_receipt_sha256\([\s\S]+outbox_id[\s\S]+operation_id[\s\S]+idempotency_authority_version[\s\S]+idempotency_authority_sha256[\s\S]+idempotency_original_payload_sha256[\s\S]+release_version/u,
    );
    expect(receiptSchema).toContain(
      ".default(sql`pg_catalog.statement_timestamp()`)",
    );
    expect(receiptSchema).toMatch(
      /idempotencyAuthoritySha256\}\s*~\s*'\^\[0-9a-f\]\{64\}\$'/u,
    );
    expect(receiptSchema).toMatch(
      /idempotencyOriginalPayloadSha256\}\s*~\s*'\^\[0-9a-f\]\{64\}\$'/u,
    );
    expect(receiptSchema).toMatch(
      /index\("mail_delivery_release_receipt_authority_fk_idx"\)\.on\(\s*table\.idempotencyAuthoritySha256,\s*table\.idempotencyOriginalPayloadSha256/u,
    );
  });

  it("exposes only reviewed explicit issuance and never auto-issues or backfills", () => {
    const issuer = functionBody("release_email_outbox_delivery");
    const compactIssuer = issuer.replace(/\s+/gu, " ");
    expect(compactMigration).toMatch(
      /alter function public\.release_email_outbox_delivery\(\s*pg_catalog\.uuid,\s*pg_catalog\.uuid,\s*pg_catalog\.text,\s*pg_catalog\.text,\s*pg_catalog\.text\s*\)/u,
    );
    expect(issuer).toContain("security definer");
    expect(issuer).toContain("set search_path = pg_catalog, pg_temp");
    expect(issuer).toContain("session_user not in (");
    expect(issuer).toContain("'learncoding_app'");
    expect(issuer).toContain("'learncoding_worker'");
    expect(issuer).toContain("'learncoding_owner'");
    expect(compactIssuer).toContain(
      "candidate.delivery_release_insert_xid is distinct from pg_catalog.pg_current_xact_id()",
    );
    expect(issuer).toContain("for update");
    expect(issuer).toContain("'event-v1-native'");
    expect(issuer).toContain("'event-v1-source-map'");
    expect(issuer).toContain("delivery_hold_version");
    expect(issuer).toContain("task7-v1");
    expect(issuer).toContain("release_receipt_sha256");
    expect(issuer).toContain("on conflict");
    expect(issuer).not.toContain("on conflict do update");
    expect(issuer).toContain("set delivery_release_insert_xid = null");
    for (const pristine of [
      "status is distinct from 'pending'",
      "attempt_count is distinct from 0",
      "claim_version is distinct from 0",
      "claim_token is not null",
      "claim_owner is not null",
      "lease_expires_at is not null",
      "provider_call_started is not null",
      "adapter is not null",
      "dispatch_binding_version is not null",
      "dispatch_binding_sha256 is not null",
      "provider_correlation_version is not null",
      "provider_evidence_version is not null",
      "provider_evidence_sha256 is not null",
      "provider_message_id is not null",
      "sent_at is not null",
      "quarantined_at is not null",
      "last_error_code is not null",
      "provider_request_body_sha256 is not null",
      "provider_request_body_length is not null",
    ]) {
      expect(issuer).toContain(pristine);
    }
    expect(migration).not.toMatch(
      /create trigger[\s\S]{0,200}release_email_outbox_delivery/u,
    );
    expect(migration).not.toMatch(
      /^\s*insert into public\.mail_delivery_release_receipt\s*\([^;]*\)\s*select\b[^;]*\bfrom public\.email_outbox\b/mu,
    );
  });

  it("binds first issuance to the inserting transaction and source cluster", () => {
    const markerGuard = functionBody(
      "enforce_email_outbox_delivery_release_insert_xid",
    );
    const compactMarkerGuard = markerGuard.replace(/\s+/gu, " ");
    const identityGuard = functionBody(
      "enforce_email_outbox_delivery_release_identity",
    );

    expect(migration).toContain(
      "add column delivery_release_insert_xid pg_catalog.xid8",
    );
    expect(migration).toContain(
      "add column delivery_release_insert_system_identifier pg_catalog.int8",
    );
    expect(migration).toContain(
      "email_outbox_delivery_release_insert_identity_valid",
    );
    expect(migration).toContain(
      "enforce_email_outbox_delivery_release_insert_xid",
    );
    expect(migration).toContain(
      "new.delivery_release_insert_xid := pg_catalog.pg_current_xact_id()",
    );
    expect(markerGuard).toContain("pg_catalog.pg_control_system()");
    expect(compactMarkerGuard).toContain(
      "new.delivery_release_insert_system_identifier := current_system_identifier",
    );
    expect(migration).toContain("before insert on public.email_outbox");
    expect(compactMigration).toContain(
      "before update of delivery_release_insert_xid, delivery_release_insert_system_identifier, created_at",
    );
    expect(migration).toContain(
      "enable always trigger email_outbox_delivery_release_insert_xid",
    );
    expect(migration).toContain(
      "enable always trigger email_outbox_delivery_release_insert_xid_immutable",
    );
    expect(migration).toContain("delivery_release_insert_xid is null");
    expect(migration).toContain("mail_delivery_release_receipt");
    expect(markerGuard).toContain("tg_op = 'insert'");
    expect(markerGuard).toContain("pg_catalog.pg_current_xact_id()");
    expect(markerGuard).toContain(
      "current_user is not distinct from 'learncoding_owner'",
    );
    expect(markerGuard).toContain("new.delivery_release_insert_xid is null");
    expect(compactMarkerGuard).not.toContain(
      "where release.outbox_id = new.id or release.operation_id = new.operation_id",
    );
    expect(identityGuard).toContain("mail_delivery_release_receipt");
    expect(identityGuard).toContain("identity has a durable release receipt");
    expect(compactMigration).toContain(
      "create trigger zz_email_outbox_delivery_release_identity before insert on public.email_outbox",
    );
    expect(markerGuard).toContain(
      "new.created_at is distinct from old.created_at",
    );
    expect(migration).not.toMatch(
      /delivery_release_insert_xid[\s\S]{0,120}(::text|::pg_catalog\.xid(?![a-z0-9_]))/u,
    );
    expect(schema).toContain("customType");
    expect(schema).toMatch(
      /deliveryReleaseInsertXid:\s*xid8\("delivery_release_insert_xid"\)/u,
    );
    expect(schema).toMatch(
      /deliveryReleaseInsertSystemIdentifier:\s*bigint\(\s*"delivery_release_insert_system_identifier",\s*\{\s*mode:\s*"bigint"\s*\}/u,
    );
  });

  it("enforces exact receipt at commit and permits only parent cascade deletion", () => {
    const commitGuard = functionBody(
      "enforce_email_outbox_delivery_release_commit_exact",
    );
    const deleteGuard = functionBody(
      "enforce_mail_delivery_release_receipt_delete_exact",
    );
    const parentDeleteGuard = functionBody(
      "enforce_email_outbox_delivery_release_delete_exact",
    );
    expect(compactMigration).toContain(
      "create constraint trigger email_outbox_delivery_release_commit_exact after insert on public.email_outbox deferrable initially deferred",
    );
    expect(compactMigration).toContain(
      "create constraint trigger mail_delivery_release_receipt_delete_exact after delete on public.mail_delivery_release_receipt deferrable initially deferred",
    );
    expect(commitGuard).toContain("from only public.email_outbox");
    expect(commitGuard).toContain(
      "from only public.mail_delivery_release_receipt",
    );
    expect(commitGuard).toContain("email_outbox_original_payload_sha256");
    expect(commitGuard).toContain("pg_catalog.isfinite(new.next_attempt_at)");
    expect(commitGuard).toContain(
      "new.created_at is distinct from pg_catalog.transaction_timestamp()",
    );
    expect(commitGuard).toContain(
      "new.updated_at is distinct from pg_catalog.transaction_timestamp()",
    );
    expect(commitGuard.replace(/\s+/gu, " ")).toContain(
      "new.next_attempt_at <= pg_catalog.transaction_timestamp() + interval '5 minutes'",
    );
    expect(commitGuard).toContain("delivery_release_insert_xid is not null");
    expect(commitGuard).toContain(
      "delivery_release_insert_system_identifier is not null",
    );
    expect(deleteGuard).toContain("from only public.email_outbox");
    expect(deleteGuard).toContain("parent still exists");
    expect(compactMigration).toContain(
      "create constraint trigger email_outbox_delivery_release_delete_exact after delete on public.email_outbox deferrable initially deferred",
    );
    expect(parentDeleteGuard).toContain(
      "email outbox deletion would orphan a durable release receipt",
    );
    expect(parentDeleteGuard).toContain(
      "from only public.mail_delivery_release_receipt",
    );
  });

  it("revalidates the final inserted payload and database-owned schedule", () => {
    const finalGuard = functionBody(
      "enforce_email_outbox_delivery_release_insert_final",
    );
    const compactFinalGuard = finalGuard.replace(/\s+/gu, " ");
    expect(compactMigration).toContain(
      "create trigger zz_email_outbox_delivery_release_insert_final after insert on public.email_outbox",
    );
    expect(compactFinalGuard).toContain(
      "candidate.idempotency_original_payload_sha256 is distinct from public.email_outbox_original_payload_sha256(",
    );
    expect(finalGuard).toContain("pg_catalog.pg_control_system()");
    expect(finalGuard).toContain("pg_catalog.pg_current_xact_id()");
    expect(finalGuard).toContain("pg_catalog.transaction_timestamp()");
    expect(finalGuard).toContain("public.email_outbox_idempotency_authority");
    expect(migration).toContain(
      "enable always trigger zz_email_outbox_delivery_release_insert_final",
    );
  });

  it("centralizes a deterministic owner-owned digest executable by owner and worker", () => {
    const hash = functionBody("mail_delivery_release_receipt_sha256");
    expect(compactMigration).toMatch(
      /alter function public\.mail_delivery_release_receipt_sha256\(\s*pg_catalog\.uuid,\s*pg_catalog\.uuid,\s*pg_catalog\.text,\s*pg_catalog\.text,\s*pg_catalog\.text,\s*pg_catalog\.text\s*\)\s+owner to learncoding_owner\s*;/u,
    );
    expect(hash).toContain("immutable");
    expect(hash).toContain("strict");
    expect(hash).toContain("security definer");
    expect(hash).toContain("set search_path = pg_catalog, pg_temp");
    expect(hash).toContain("mail-delivery-release-v1");
    expect(hash).toContain("pg_catalog.sha256");
    expect(hash).toContain("pg_catalog.convert_to");
    expect(hash).toContain("pg_catalog.encode");
    expect(migration).toMatch(
      /grant execute on function\s+public\.mail_delivery_release_receipt_sha256\(\s*pg_catalog\.uuid,\s*pg_catalog\.uuid,\s*pg_catalog\.text,\s*pg_catalog\.text,\s*pg_catalog\.text,\s*pg_catalog\.text\s*\)\s+to\s+learncoding_owner\s*;/u,
    );
    expect(migration).toMatch(
      /grant execute on function\s+public\.mail_delivery_release_receipt_sha256\(\s*pg_catalog\.uuid,\s*pg_catalog\.uuid,\s*pg_catalog\.text,\s*pg_catalog\.text,\s*pg_catalog\.text,\s*pg_catalog\.text\s*\)\s+to\s+learncoding_worker\s*;/u,
    );
    expect(migration).not.toMatch(
      /grant execute on function\s+public\.mail_delivery_release_receipt_sha256\([^;]*\)\s+to\s+(learncoding_app|public)\s*;/u,
    );
  });

  it("adds a paired immutable exact request-body binding", () => {
    const requestGuard = functionBody(
      "enforce_email_outbox_provider_request_body_immutable",
    );
    const compactRequestGuard = requestGuard.replace(/\s+/gu, " ");
    expect(migration).toContain(
      "add column provider_request_body_sha256 pg_catalog.text",
    );
    expect(migration).toContain(
      "add column provider_request_body_length pg_catalog.int8",
    );
    expect(migration).toContain(
      "constraint email_outbox_provider_request_body_valid",
    );
    expect(migration).toMatch(
      /provider_request_body_sha256 is null[\s\S]+provider_request_body_length is null/u,
    );
    expect(migration).toMatch(
      /provider_request_body_sha256 ~ '\^\[0-9a-f\]\{64\}\$'[\s\S]+provider_request_body_length >= 0/u,
    );
    expect(migration).toContain(
      "provider_request_body_length <= 9007199254740991",
    );
    expect(migration).toContain(
      "enforce_email_outbox_provider_request_body_immutable",
    );
    expect(compactMigration).toContain(
      "before insert or update of provider_call_started, provider_request_body_sha256, provider_request_body_length",
    );
    expect(migration).toContain(
      "enable always trigger email_outbox_provider_request_body_immutable",
    );
    expect(requestGuard).toContain("tg_op = 'insert'");
    expect(compactRequestGuard).toMatch(
      /old\.provider_request_body_sha256 is not null\s+or old\.provider_request_body_length is not null\s+then\s+raise exception/u,
    );
    expect(compactRequestGuard).toContain(
      "and old.provider_call_started is not distinct from new.provider_call_started then return new",
    );
    expect(requestGuard).toContain("new.provider_request_body_sha256");
    expect(requestGuard).toContain("new.provider_request_body_length");
    expect(requestGuard).toContain(
      "guard_now pg_catalog.timestamptz := pg_catalog.clock_timestamp()",
    );
    expect(compactRequestGuard).not.toContain(
      "lease_expires_at > pg_catalog.statement_timestamp()",
    );
    expect(compactRequestGuard).not.toContain(
      "lease_expires_at < pg_catalog.statement_timestamp()",
    );
    expect(requestGuard).toContain("security definer");
    expect(requestGuard).toContain(
      "current_user is distinct from 'learncoding_owner'",
    );
    expect(requestGuard).toContain(
      "session_user is distinct from 'learncoding_worker'",
    );
    expect(requestGuard).toContain("raise exception");
    expect(migration).toContain("not valid");
    expect(migration).toContain(
      "validate constraint email_outbox_provider_request_body_valid",
    );
    expect(schema).toMatch(
      /providerRequestBodySha256:\s*text\("provider_request_body_sha256"\)/u,
    );
    expect(schema).toMatch(
      /providerRequestBodyLength:\s*bigint\("provider_request_body_length",\s*\{\s*mode:\s*"number",?\s*\}\)/u,
    );
    expect(schema).toMatch(
      /\$\{table\.providerRequestBodySha256\}\s+IS NOT NULL\s+AND\s+\$\{table\.providerRequestBodyLength\}\s+IS NOT NULL/u,
    );
  });

  it("replaces the hold trigger with an exact receipt-gated successor", () => {
    const hold = functionBody("enforce_email_outbox_delivery_hold");
    expect(hold).toContain("mail_delivery_release_receipt");
    expect(hold).toContain("new.delivery_hold_version");
    expect(hold).toContain("old.delivery_hold_version");
    expect(hold).toContain("'task7-v1'");
    expect(hold).toContain("new.operation_id");
    expect(hold).toContain("new.idempotency_authority_version");
    expect(hold).toContain("new.idempotency_authority_sha256");
    expect(hold).toContain("new.idempotency_original_payload_sha256");
    expect(hold).toContain("release.release_version");
    expect(hold).toContain("release.release_receipt_sha256");
    expect(hold).toContain("'event-v1-native'");
    expect(hold).toContain("'event-v1-source-map'");
    expect(hold).toContain("provider_request_body_sha256");
    expect(hold).toContain("provider_request_body_length");
    expect(hold).toContain("raise exception");
    expect(migration).toContain(
      "drop trigger if exists email_outbox_delivery_hold",
    );
    expect(migration).toContain("create trigger email_outbox_delivery_hold");
    expect(migration).toContain(
      "enable always trigger email_outbox_delivery_hold",
    );
  });

  it("accepts receipt inserts only through the reviewed owner issuer", () => {
    const guard = functionBody("enforce_mail_delivery_release_receipt_insert");
    expect(guard).toContain("security invoker");
    expect(guard).toContain(
      "current_user is distinct from 'learncoding_owner'",
    );
    expect(guard).toContain("delivery_release_insert_xid");
    expect(guard).toContain("pg_catalog.pg_current_xact_id()");
    expect(guard).toContain("status is distinct from 'pending'");
    expect(guard).toContain("release_receipt_sha256");
    expect(compactMigration).toContain(
      "before insert on public.mail_delivery_release_receipt",
    );
    expect(migration).toContain(
      "enable always trigger mail_delivery_release_receipt_insert_authority",
    );
  });

  it("releases backup-status mail inside the reporter enqueue transaction", () => {
    const wrapper = functionBody("enqueue_backup_status_mail_authority");
    const issuer = functionBody("release_email_outbox_delivery");
    const marker = functionBody(
      "enforce_email_outbox_delivery_release_insert_xid",
    );
    expect(compactMigration).toContain(
      "rename to enqueue_backup_status_mail_authority_unreleased_0067",
    );
    expect(wrapper).toContain(
      "enqueue_backup_status_mail_authority_unreleased_0067",
    );
    expect(wrapper).toContain("release_email_outbox_delivery");
    expect(wrapper).toContain(
      "session_user is distinct from 'learncoding_backup_reporter'",
    );
    expect(issuer).toContain("'learncoding_backup_reporter'");
    expect(marker).toContain("'learncoding_backup_reporter'");
    expect(migration).not.toMatch(
      /grant execute on function\s+public\.release_email_outbox_delivery\([^;]*\)\s+to\s+learncoding_backup_reporter\s*;/u,
    );
  });

  it("permits only reviewed worker delivery arcs and resulting shapes", () => {
    const hold = functionBody("enforce_email_outbox_delivery_hold");
    const compactHold = hold.replace(/\s+/gu, " ");
    expect(hold).toContain("current_user is distinct from 'learncoding_owner'");
    expect(hold).toContain(
      "session_user is distinct from 'learncoding_worker'",
    );
    for (const arc of [
      "next_generation",
      "same_generation",
      "same_attempt",
      "same_claim_identity",
      "same_provider_authority",
      "bounded_new_lease",
      "guard_now",
      "pg_catalog.clock_timestamp()",
      "pg_catalog.isfinite(new.next_attempt_at)",
      "new.next_attempt_at <= guard_now + interval '6 hours'",
      "old.claim_version::pg_catalog.int8 <= 2147483645",
      "new.claim_version::pg_catalog.int8 = old.claim_version::pg_catalog.int8 + 1",
    ]) {
      expect(compactHold).toContain(arc);
    }
    for (const shape of [
      "claim_state_complete",
      "claim_state_absent",
      "provider_state_complete",
      "provider_state_absent",
    ]) {
      expect(hold).toContain(shape);
    }
    expect(compactHold).not.toContain(
      "old.lease_expires_at > pg_catalog.statement_timestamp()",
    );
    expect(compactHold).not.toContain(
      "old.lease_expires_at < pg_catalog.statement_timestamp()",
    );
    expect(compactHold).not.toContain(
      "old.status = 'sending' and new.status in",
    );
  });
  it("terminalizes every exhausted pre-provider counter state", () => {
    const hold = functionBody("enforce_email_outbox_delivery_hold");
    const compactHold = hold.replace(/\s+/gu, " ");
    expect(migration).toContain("email_outbox_attempt_count_nonnegative");
    expect(schema).toContain("email_outbox_attempt_count_nonnegative");
    for (const invariant of [
      "retired_generation",
      "old.claim_version::pg_catalog.int8 <= 2147483644",
      "old.claim_version::pg_catalog.int8 >= 2147483646",
      "old.attempt_count::pg_catalog.int8 = 2147483647",
      "new.last_error_code = 'delivery_counter_exhausted'",
      "case when old.claim_version::pg_catalog.int8 < 2147483647::pg_catalog.int8 then old.claim_version::pg_catalog.int8 + 1 else 2147483647::pg_catalog.int8 end",
      "old.claim_version::pg_catalog.int8 + 1",
      "2147483647::pg_catalog.int8",
    ]) {
      expect(compactHold).toContain(invariant);
    }
    expect(compactHold).not.toContain("pg_catalog.least(");
    expect(compactHold).not.toMatch(
      /new\.claim_version\s*=\s*old\.claim_version\s*\+\s*1/u,
    );
    expect(compactHold).not.toMatch(
      /new\.attempt_count\s*=\s*old\.attempt_count\s*\+\s*1/u,
    );
  });

  it("revalidates payload, marker, and retention timestamps in the final trigger", () => {
    const hold = functionBody("enforce_email_outbox_delivery_hold");
    const compactHold = hold.replace(/\s+/gu, " ");
    for (const invariant of [
      "payload_changed",
      "marker_changed",
      "updated_at_changed",
      "exact_redaction",
      "exact_marker_cleanup",
      "old.user_id is distinct from new.user_id",
      "old.to_email is distinct from new.to_email",
      "old.template is distinct from new.template",
      "old.template_version is distinct from new.template_version",
      "old.variables is distinct from new.variables",
      "old.idempotency_key is distinct from new.idempotency_key",
      "old.delivery_scope_key is distinct from new.delivery_scope_key",
      "marker_changed := row(",
      "old.delivery_release_insert_system_identifier",
      "new.delivery_release_insert_system_identifier",
      "old.created_at is distinct from new.created_at",
      "new.updated_at is distinct from pg_catalog.statement_timestamp()",
    ]) {
      expect(compactHold).toContain(invariant);
    }
    expect(migration).toMatch(
      /create trigger email_outbox_delivery_hold_final\s+after update on public\.email_outbox\s+for each row\s+execute function public\.enforce_email_outbox_delivery_hold\(\);/u,
    );
  });
  it("makes the first durable provider identity irreversible", () => {
    const hold = functionBody("enforce_email_outbox_delivery_hold");
    const compactHold = hold.replace(/\s+/gu, " ");
    expect(compactHold).toContain(
      "if (old.provider_message_id is not null or old.sent_at is not null) and row(new.provider_message_id, new.sent_at) is distinct from row(old.provider_message_id, old.sent_at) then raise exception 'email outbox provider identity is immutable'",
    );
  });

  it("blocks direct receipt mutation and grants only minimum authority", () => {
    expect(migration).toContain(
      "enforce_mail_delivery_release_receipt_append_only",
    );
    expect(migration).toContain(
      "before update on public.mail_delivery_release_receipt",
    );
    expect(migration).not.toContain(
      "before update or delete on public.mail_delivery_release_receipt",
    );
    expect(migration).toContain(
      "before truncate on public.mail_delivery_release_receipt",
    );
    expect(migration).toContain(
      "enable always trigger mail_delivery_release_receipt_append_only",
    );
    expect(migration).toContain(
      "enable always trigger mail_delivery_release_receipt_no_truncate",
    );
    expect(migration).toContain("pg_catalog.aclexplode");
    expect(migration).toContain("from public cascade");
    expect(migration).toMatch(
      /grant select\s*\([^;]*\boutbox_id\b[^;]*\boperation_id\b[^;]*\brelease_receipt_sha256\b[^;]*\)\s*on public\.mail_delivery_release_receipt\s+to learncoding_worker\s*;/u,
    );
    expect(migration).toMatch(
      /grant execute on function\s+public\.release_email_outbox_delivery\([^;]*\)\s+to learncoding_app\s*;/u,
    );
    expect(migration).toMatch(
      /grant execute on function\s+public\.release_email_outbox_delivery\([^;]*\)\s+to learncoding_worker\s*;/u,
    );
    expect(migration).not.toMatch(
      /grant\s+(insert|update|delete|truncate)[\s\S]{0,100}mail_delivery_release_receipt\s+to\s+(learncoding_app|learncoding_worker|public)/u,
    );
  });

  it("allows worker issuance only for a pristine row inserted in the same transaction and cluster", () => {
    const issuer = functionBody("release_email_outbox_delivery");
    const compactIssuer = issuer.replace(/\s+/gu, " ");
    const terminal = migration.slice(
      migration.indexOf("do $verify_terminal_catalog$"),
    );

    expect(compactIssuer).toMatch(
      /session_user not in \( 'learncoding_app', 'learncoding_worker', 'learncoding_owner', 'learncoding_backup_reporter' \)/u,
    );
    expect(compactIssuer).toContain(
      "candidate.delivery_release_insert_xid is distinct from pg_catalog.pg_current_xact_id()",
    );
    expect(compactIssuer).toContain(
      "candidate.delivery_release_insert_system_identifier is distinct from current_system_identifier",
    );
    expect(compactIssuer).toContain(
      "candidate.created_at is distinct from pg_catalog.transaction_timestamp()",
    );
    expect(compactIssuer).toContain(
      "candidate.updated_at is distinct from pg_catalog.transaction_timestamp()",
    );
    expect(compactIssuer).toContain("for update");
    expect(terminal).toContain(
      "'issuer|learncoding_worker|learncoding_owner|execute|false'",
    );
    expect(terminal).toMatch(
      /principal\.principal_name = 'learncoding_worker'\s+and routine\.routine_label = 'issuer'/u,
    );
  });

  it("verifies an existing exact receipt for deletion replay without granting receipt reads", () => {
    const verifier = functionBody("verify_email_outbox_delivery_release");
    const compactVerifier = verifier.replace(/\s+/gu, " ");
    const terminal = migration.slice(
      migration.indexOf("do $verify_terminal_catalog$"),
    );

    expect(compactVerifier).toContain(
      "returns table ( outbox_id pg_catalog.uuid, operation_id pg_catalog.uuid )",
    );
    expect(verifier).toContain("security definer");
    expect(verifier).toContain("set search_path = pg_catalog, pg_temp");
    expect(compactVerifier).toMatch(
      /session_user not in \( 'learncoding_app', 'learncoding_owner' \)/u,
    );
    expect(verifier).not.toContain("'learncoding_worker'");
    expect(verifier).not.toContain("'learncoding_backup_reporter'");
    expect(compactVerifier).toContain("conflicting_receipts <> 1");
    expect(compactVerifier).toContain(
      "candidate.delivery_release_insert_xid is not null",
    );
    expect(compactVerifier).toContain(
      "candidate.delivery_release_insert_system_identifier is not null",
    );
    expect(verifier).toContain("requested_authority_sha256");
    expect(verifier).toContain("requested_original_payload_sha256");
    expect(verifier).toContain("requested_release_version");
    expect(verifier).toContain("mail_delivery_release_receipt_sha256");
    expect(verifier).toContain("for share");
    expect(compactVerifier).not.toMatch(
      /\b(?:insert into|update only|delete from)\b/u,
    );
    expect(compactMigration).toMatch(
      /alter function public\.verify_email_outbox_delivery_release\( pg_catalog\.uuid, pg_catalog\.uuid, pg_catalog\.text, pg_catalog\.text, pg_catalog\.text \) owner to learncoding_owner/u,
    );
    expect(migration).toMatch(
      /grant execute on function\s+public\.verify_email_outbox_delivery_release\([^;]*\)\s+to learncoding_app\s*;/u,
    );
    expect(migration).toMatch(
      /grant execute on function\s+public\.verify_email_outbox_delivery_release\([^;]*\)\s+to learncoding_owner\s*;/u,
    );
    expect(migration).not.toMatch(
      /grant execute on function\s+public\.verify_email_outbox_delivery_release\([^;]*\)\s+to (?:learncoding_worker|learncoding_ops|learncoding_backup_reporter|public)\s*;/u,
    );
    expect(migration).not.toMatch(
      /grant select(?:\s*\([^;]*\))?\s+on public\.mail_delivery_release_receipt\s+to\s+learncoding_app\s*;/u,
    );
    expect(terminal).toContain(
      "'verifier|learncoding_app|learncoding_owner|execute|false'",
    );
    expect(terminal).toContain(
      "'verifier|learncoding_owner|learncoding_owner|execute|false'",
    );
    expect(terminal).toMatch(
      /principal\.principal_name = 'learncoding_app'\s+and routine\.routine_label = 'verifier'/u,
    );
    expect(migration).toContain(
      "b3277feeb2ed099406e17a3fe548bae580f978f5cd94a7f55f28687c81d9042c",
    );
    expect(migration).toContain(
      "8e50e51aae34e3657a6a2d9d90fc546025512f2678b083e824a5cc0f8457ee5f",
    );
  });

  it("ends with a terminal exact catalog verifier", () => {
    const start = migration.indexOf("do $verify_terminal_catalog$");
    const marker = "$verify_terminal_catalog$;";
    const end = migration.indexOf(marker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(migration.slice(end + marker.length).trim()).toBe("");
    const terminal = migration.slice(start, end);
    for (const markerText of [
      "mail_delivery_release_receipt",
      "mail_delivery_release_receipt_sha256",
      "release_email_outbox_delivery",
      "enforce_mail_delivery_release_receipt_append_only",
      "enforce_email_outbox_delivery_hold",
      "delivery_release_insert_xid",
      "delivery_release_insert_system_identifier",
      "enforce_email_outbox_delivery_release_insert_xid",
      "enforce_email_outbox_delivery_release_commit_exact",
      "enforce_mail_delivery_release_receipt_delete_exact",
      "provider_request_body_sha256",
      "provider_request_body_length",
      "enforce_email_outbox_provider_request_body_immutable",
      "pg_catalog.pg_proc",
      "pg_catalog.pg_trigger",
      "pg_catalog.pg_constraint",
      "pg_catalog.aclexplode",
      "learncoding_owner",
      "learncoding_app",
      "learncoding_worker",
    ]) {
      expect(terminal).toContain(markerText);
    }
    expect(terminal).toContain("0069 terminal catalog contract is invalid");
  });
  it("pins the complete physical shape of all four guarded outbox columns", () => {
    const terminal = migration.slice(
      migration.indexOf("do $verify_terminal_catalog$"),
    );
    const start = terminal.indexOf("expected_guarded_outbox_columns");
    const end = terminal.indexOf("guarded_outbox_column_delta", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const columnContract = terminal.slice(start, end);

    for (const columnName of [
      "delivery_release_insert_xid",
      "delivery_release_insert_system_identifier",
      "provider_request_body_sha256",
      "provider_request_body_length",
    ]) {
      expect(columnContract).toContain(columnName);
    }
    for (const exactField of [
      "attribute.attlen = type_row.typlen",
      "attribute.attbyval = type_row.typbyval",
      "attribute.attalign = type_row.typalign",
      "attribute.attstorage = type_row.typstorage",
      "attribute.attcompression = ''::\"char\"",
      "attribute.attstattarget is null",
      "attribute.attndims = 0",
      "attribute.attoptions is null",
      "attribute.attfdwoptions is null",
    ]) {
      expect(columnContract).toContain(exactField);
    }
  });
  it("rejects receipt-less backup rows that can still reconcile", () => {
    const stranded = dollarBlock("reject_stranded_backup_status");
    const wrapper = functionBody("enqueue_backup_status_mail_authority");
    expect(stranded.replace(/\s+/gu, " ")).toContain(
      "outbox.status is null or outbox.status not in ('sent', 'failed', 'suppressed')",
    );
    expect(wrapper.replace(/\s+/gu, " ")).toContain(
      "candidate.status is null or candidate.status not in ('sent', 'failed', 'suppressed')",
    );
  });

  it("freezes the complete Task 7A application schema contract", () => {
    const outboxConfig = getTableConfig(emailOutbox);
    const task7Columns = new Set([
      "delivery_release_insert_xid",
      "delivery_release_insert_system_identifier",
      "provider_request_body_sha256",
      "provider_request_body_length",
    ]);
    expect(
      outboxConfig.columns
        .filter((column) => task7Columns.has(column.name))
        .map((column) => ({
          name: column.name,
          type: column.getSQLType(),
          notNull: column.notNull,
          hasDefault: column.hasDefault,
          primary: column.primary,
        })),
    ).toEqual([
      {
        name: "delivery_release_insert_xid",
        type: "xid8",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "provider_request_body_sha256",
        type: "text",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "provider_request_body_length",
        type: "bigint",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "delivery_release_insert_system_identifier",
        type: "bigint",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
    ]);
    expectTypeOf<
      typeof emailOutbox.$inferSelect.deliveryReleaseInsertXid
    >().toEqualTypeOf<string | null>();
    expectTypeOf<
      typeof emailOutbox.$inferSelect.deliveryReleaseInsertSystemIdentifier
    >().toEqualTypeOf<bigint | null>();
    expectTypeOf<
      typeof emailOutbox.$inferSelect.providerRequestBodySha256
    >().toEqualTypeOf<string | null>();
    expectTypeOf<
      typeof emailOutbox.$inferSelect.providerRequestBodyLength
    >().toEqualTypeOf<number | null>();
    expect(
      outboxConfig.uniqueConstraints.map((constraint) => ({
        name: constraint.getName(),
        columns: constraint.columns.map((column) => column.name),
      })),
    ).toContainEqual({
      name: "email_outbox_delivery_release_parent_unique",
      columns: ["id", "operation_id"],
    });

    const receiptConfig = getTableConfig(mailDeliveryReleaseReceipt);
    expect(outboxConfig.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "email_outbox_claim_version_nonnegative",
        "email_outbox_delivery_release_insert_identity_valid",
        "email_outbox_attempt_count_nonnegative",
      ]),
    );
    expect(
      schemaCheckSql(outboxSchema, "email_outbox_claim_version_nonnegative"),
    ).toBe("sql`${table.claimVersion} >= 0`");
    expect(
      schemaCheckSql(outboxSchema, "email_outbox_attempt_count_nonnegative"),
    ).toBe("sql`(${table.attemptCount} >= 0) IS TRUE`");
    expect(
      schemaCheckSql(
        outboxSchema,
        "email_outbox_delivery_release_insert_identity_valid",
      ),
    ).toBe(
      "sql`((( ${table.deliveryReleaseInsertXid} IS NULL " +
        "AND ${table.deliveryReleaseInsertSystemIdentifier} IS NULL ) OR ( " +
        "${table.deliveryReleaseInsertXid} IS NOT NULL " +
        "AND ${table.deliveryReleaseInsertSystemIdentifier} IS NOT NULL )) IS TRUE)`",
    );
    expect(
      receiptConfig.columns.map((column) => ({
        name: column.name,
        type: column.getSQLType(),
        notNull: column.notNull,
        hasDefault: column.hasDefault,
        primary: column.primary,
      })),
    ).toEqual([
      {
        name: "outbox_id",
        type: "uuid",
        notNull: true,
        hasDefault: false,
        primary: true,
      },
      {
        name: "operation_id",
        type: "uuid",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "idempotency_authority_version",
        type: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "idempotency_authority_sha256",
        type: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "idempotency_original_payload_sha256",
        type: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "release_version",
        type: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "release_receipt_sha256",
        type: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "released_at",
        type: "timestamp with time zone",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
    ]);
    expect(
      receiptConfig.uniqueConstraints.map((constraint) => ({
        name: constraint.name,
        columns: constraint.columns.map((column) => column.name),
      })),
    ).toEqual([
      {
        name: "mail_delivery_release_receipt_operation_unique",
        columns: ["operation_id"],
      },
      {
        name: "mail_delivery_release_receipt_digest_unique",
        columns: ["release_receipt_sha256"],
      },
    ]);
    expect(receiptConfig.checks.map((check) => check.name)).toEqual([
      "mail_delivery_release_receipt_authority_version_valid",
      "mail_delivery_release_receipt_release_version_valid",
      "mail_delivery_release_receipt_digest_valid",
      "mail_delivery_release_receipt_digest_exact",
    ]);
    expect(
      schemaCheckSql(
        receiptSchema,
        "mail_delivery_release_receipt_authority_version_valid",
      ),
    ).toBe(
      "sql`(( ${table.idempotencyAuthorityVersion} IN ('event-v1-native', 'event-v1-source-map') " +
        "AND ${table.idempotencyAuthoritySha256} ~ '^[0-9a-f]{64}$' " +
        "AND ${table.idempotencyOriginalPayloadSha256} ~ '^[0-9a-f]{64}$' )) IS TRUE`",
    );
    expect(
      schemaCheckSql(
        receiptSchema,
        "mail_delivery_release_receipt_release_version_valid",
      ),
    ).toBe("sql`(${table.releaseVersion} = 'task7-v1') IS TRUE`");
    expect(
      schemaCheckSql(
        receiptSchema,
        "mail_delivery_release_receipt_digest_valid",
      ),
    ).toBe("sql`(${table.releaseReceiptSha256} ~ '^[0-9a-f]{64}$') IS TRUE`");
    expect(
      schemaCheckSql(
        receiptSchema,
        "mail_delivery_release_receipt_digest_exact",
      ),
    ).toBe(
      "sql`( ${table.releaseReceiptSha256} = " +
        "public.mail_delivery_release_receipt_sha256( ${table.outboxId}, ${table.operationId}, " +
        "${table.idempotencyAuthorityVersion}, ${table.idempotencyAuthoritySha256}, " +
        "${table.idempotencyOriginalPayloadSha256}, ${table.releaseVersion} ) ) IS TRUE`",
    );
    expect(
      receiptConfig.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          name: foreignKey.getName(),
          columns: reference.columns.map((column) => column.name),
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onUpdate: foreignKey.onUpdate,
          onDelete: foreignKey.onDelete,
        };
      }),
    ).toEqual([
      {
        name: "mail_delivery_release_receipt_outbox_fk",
        columns: ["outbox_id", "operation_id"],
        foreignColumns: ["id", "operation_id"],
        onUpdate: "restrict",
        onDelete: "cascade",
      },
      {
        name: "mail_delivery_release_receipt_idempotency_authority_fk",
        columns: [
          "idempotency_authority_sha256",
          "idempotency_original_payload_sha256",
        ],
        foreignColumns: ["idempotency_sha256", "original_payload_sha256"],
        onUpdate: "restrict",
        onDelete: "restrict",
      },
    ]);
    expect(
      receiptConfig.indexes.map((index) => ({
        name: index.config.name,
        unique: index.config.unique,
        method: index.config.method,
        columns: index.config.columns.map(
          (column) => (column as { name?: string }).name,
        ),
      })),
    ).toEqual([
      {
        name: "mail_delivery_release_receipt_authority_fk_idx",
        unique: false,
        method: "btree",
        columns: [
          "idempotency_authority_sha256",
          "idempotency_original_payload_sha256",
        ],
      },
    ]);
    expectTypeOf<
      typeof mailDeliveryReleaseReceipt.$inferSelect.releasedAt
    >().toEqualTypeOf<Date>();
    expectTypeOf<
      typeof mailDeliveryReleaseReceipt.$inferInsert.releasedAt
    >().toEqualTypeOf<Date | undefined>();
  });

  it("canonicalizes deparse output and protects permanent receipt identity", () => {
    const hold = functionBody("enforce_email_outbox_delivery_hold");
    expect(migration).toContain("set local quote_all_identifiers = off");
    expect(hold).toContain("new.id is distinct from old.id");
    expect(compactMigration).toContain(
      "create trigger email_outbox_delivery_hold_final after update on public.email_outbox",
    );
  });

  it("attests sensitive trigger bitmaps and role topology", () => {
    const terminal = dollarBlock("verify_terminal_catalog");
    expect(terminal).toContain("email_outbox_payload_immutable");
    expect(terminal).toContain(
      "email_outbox_delivery_release_insert_xid_immutable",
    );
    for (const marker of [
      "expected_user_triggers",
      "expected_internal_triggers",
      "email_outbox_idempotency_claim",
      "00_email_outbox_idempotency_persist",
      "email_outbox_idempotency_metadata_immutable",
      "email_outbox_idempotency_append_only",
      "email_outbox_idempotency_no_truncate",
      "email_outbox_user_id_user_id_fk",
      "email_outbox_idempotency_authority_fk",
      "mail_delivery_release_receipt_idempotency_authority_fk",
      "ri_fkey_restrict_del",
    ]) {
      expect(terminal).toContain(marker);
    }
    for (const role of ["learncoding_ops", "learncoding_backup_reporter"]) {
      expect(terminal).toContain(
        `pg_catalog.pg_has_role(\n       '${role}',\n       'learncoding_owner',\n       'member'\n     )`,
      );
    }
    for (const markerText of [
      "mail_delivery_release_receipt_authority_fk_idx",
      "pg_catalog.pg_get_constraintdef",
      "constraint_row.conkey",
      "index_row.indisvalid",
      "trigger_row.tgattr",
    ]) {
      expect(terminal).toContain(markerText);
    }
    for (const routineMarker of [
      "expected_routine_signatures",
      "reviewed_routine_names",
      "routine.proargnames",
      "routine.proallargtypes",
      "routine.proargmodes",
      "routine.proargdefaults",
      "routine.protrftypes",
      "routine.procost",
      "routine.prorows",
      "pg_catalog.pg_get_functiondef",
    ]) {
      expect(terminal).toContain(routineMarker);
    }
    for (const aclMarker of [
      "expected_direct_relation_acl",
      "expected_effective_function_authority",
      "expected_effective_relation_authority",
      "expected_managed_memberships",
      "expected_managed_roles",
      "inherit_option",
      "set_option",
      "maintain",
    ]) {
      expect(terminal).toContain(aclMarker);
    }
  });
});
