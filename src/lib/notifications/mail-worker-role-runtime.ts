import { createHash } from "node:crypto";
import inventory from "../../../drizzle/meta/0074_mail_runtime.json";

type Queryable = {
  query(text: string): Promise<{ readonly rows: readonly unknown[] }>;
};

const INVENTORY_SHA256 =
  "9a0a41cd2c2bbc9c366a517c69e321f0ec58128bb7cca7f74b36bdad68143912";

export async function requireMailWorkerRoleRuntime(database: Queryable) {
  if (createHash("sha256").update(JSON.stringify(inventory) + "\n").digest("hex") !== INVENTORY_SHA256) {
    throw new Error("Mail worker role inventory is invalid.");
  }
  // Only reviewed, secret-free metadata enters this literal. The effective
  // column inventory catches broad table/PUBLIC grants as well as extra ACLs.
  const expectedColumns = JSON.stringify(inventory.grants
    .filter(row => row.objectKind === "column")
    .map(row => ({ object: row.objectIdentity, privilege: row.privilege }))
    .sort((a, b) => a.object.localeCompare(b.object) || a.privilege.localeCompare(b.privilege)))
    .replaceAll("'", "''");
  const expectedRoutines = JSON.stringify(inventory.routines
    .map(({ signature, bodySha256, definitionSha256 }) => ({ signature, bodySha256, definitionSha256 })))
    .replaceAll("'", "''");
  const result = await database.query(`
    with principal as (
      select * from pg_catalog.pg_roles where rolname=current_user
    ), column_access as (
      select n.nspname||'.'||c.relname||'.'||a.attname as object, privilege
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid=c.oid
      cross join (values ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) access(privilege)
      where n.nspname in ('public','drizzle') and c.relkind in ('r','p')
        and a.attnum>0 and not a.attisdropped
        and pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,privilege)
    ), expected_columns as (
      select * from pg_catalog.jsonb_to_recordset('${expectedColumns}'::jsonb)
        as expected(object text,privilege text)
    ), expected_routines as (
      select * from pg_catalog.jsonb_to_recordset('${expectedRoutines}'::jsonb)
        as expected(signature text,"bodySha256" text,"definitionSha256" text)
    )
    select (
      session_user='learncoding_mail_worker' and current_user=session_user
      and (select count(*) from principal)=1
      and exists(select 1 from principal p where p.rolcanlogin
        and not p.rolsuper and not p.rolcreatedb and not p.rolcreaterole
        and not p.rolinherit and not p.rolreplication and not p.rolbypassrls
        and p.rolconnlimit=-1 and p.rolconfig is null
        and p.rolvaliduntil='infinity'::timestamptz)
      and not exists(select 1 from pg_catalog.pg_auth_members m, principal p
        where m.member=p.oid or m.roleid=p.oid)
      and not exists(select 1 from pg_catalog.pg_db_role_setting s, principal p
        where s.setrole=p.oid)
      and pg_catalog.has_database_privilege(current_user,current_database(),'CONNECT')
      and not pg_catalog.has_database_privilege(current_user,current_database(),'CREATE')
      and not pg_catalog.has_database_privilege(current_user,current_database(),'TEMP')
      and pg_catalog.has_schema_privilege(current_user,'public','USAGE')
      and not pg_catalog.has_schema_privilege(current_user,'public','CREATE')
      and not pg_catalog.has_schema_privilege(current_user,'drizzle','USAGE')
      and not pg_catalog.has_schema_privilege(current_user,'drizzle','CREATE')
      and not exists((select * from column_access except select * from expected_columns)
        union all (select * from expected_columns except select * from column_access))
      and not exists(select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),
          ('REFERENCES'),('TRIGGER'),('MAINTAIN')) access(privilege)
        where n.nspname in ('public','drizzle') and c.relkind in ('r','p')
          and pg_catalog.has_table_privilege(current_user,c.oid,privilege))
      and not exists(select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        cross join (values ('USAGE'),('SELECT'),('UPDATE')) access(privilege)
        where n.nspname in ('public','drizzle') and c.relkind='S'
          and pg_catalog.has_sequence_privilege(current_user,c.oid,privilege))
      and not exists(select 1 from pg_catalog.pg_default_acl d
        cross join lateral pg_catalog.aclexplode(d.defaclacl) access
        where access.grantee in (0,(select oid from principal))
          and (d.defaclnamespace=0 or d.defaclnamespace in
            (select oid from pg_catalog.pg_namespace where nspname in ('public','drizzle'))))
      and (select count(*) from expected_routines)=14
      and not exists(select 1 from expected_routines expected
        left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(expected.signature)
        where p.oid is null or pg_catalog.pg_get_userbyid(p.proowner)<>'learncoding_owner'
          or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')<>expected."bodySha256"
          or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex')<>expected."definitionSha256"
          or p.prosupport<>0 or p.probin is not null or p.prosqlbody is not null
          or coalesce(p.protrftypes,array[]::oid[])<>array[]::oid[])
      and not exists(select 1 from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
          is distinct from (p.oid in (select pg_catalog.to_regprocedure(signature)
            from expected_routines where signature like 'public.mail_worker_%')))
      and not exists(select 1 from expected_routines expected
        join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(expected.signature)
        where expected.signature like 'public.mail_worker_%' and (
          not p.prosecdef or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
          or (select count(*) from pg_catalog.aclexplode(p.proacl))<>2
          or exists(select 1 from pg_catalog.aclexplode(p.proacl) access where
            pg_catalog.pg_get_userbyid(access.grantee) not in ('learncoding_owner','learncoding_mail_worker')
            or pg_catalog.pg_get_userbyid(access.grantor)<>'learncoding_owner'
            or access.privilege_type<>'EXECUTE' or access.is_grantable)))
    ) as mail_role_exact
  `);
  const row = result.rows[0] as { mail_role_exact?: unknown } | undefined;
  if (result.rows.length !== 1 || row?.mail_role_exact !== true) {
    throw new Error("Mail worker role authority is unavailable.");
  }
}
