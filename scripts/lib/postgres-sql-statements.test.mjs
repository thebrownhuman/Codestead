import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizePostgresStatement,
  splitPostgresStatements,
} from "./postgres-sql-statements.mjs";

test("splits only top-level statements and reports exact source spans", () => {
  const sql = String.raw`
-- leading semicolon ; is not a statement
LOCK TABLE public.email_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
/* outer ; comment /* nested ; comment */ still a comment */
LOCK TABLE public."user", public.access_request IN SHARE MODE NOWAIT;
CREATE FUNCTION public.parser_probe() RETURNS void
LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM 'literal;--not-comment';
  PERFORM E'escaped\';still-literal';
  PERFORM $inner$dollar;/*still-literal*/$inner$;
END
$body$;
SELECT "semi;Colon", $tag$MiX  Sp;--literal$tag$;
`;

  const statements = splitPostgresStatements(sql);
  assert.equal(statements.length, 4);
  for (const statement of statements) {
    assert.equal(sql.slice(statement.start, statement.end), statement.sql);
    assert.match(statement.sql, /;\s*$/u);
  }

  assert.deepEqual(
    statements
      .map(({ sql: statement }) => canonicalizePostgresStatement(statement))
      .filter((statement) => statement.startsWith("lock table ")),
    [
      "lock table public.email_outbox in access exclusive mode nowait;",
      'lock table public."user", public.access_request in share mode nowait;',
    ],
  );

  const secondStatementEnd = statements[1].end;
  const gated = `${sql.slice(0, secondStatementEnd)}
SELECT pg_catalog.pg_advisory_xact_lock(67006702);
${sql.slice(secondStatementEnd)}`;
  const gatedStatements = splitPostgresStatements(gated);
  assert.equal(
    canonicalizePostgresStatement(gatedStatements[2].sql),
    "select pg_catalog.pg_advisory_xact_lock(67006702);",
  );
});

test("canonicalizes code without rewriting quoted identifiers or literals", () => {
  const canonical = canonicalizePostgresStatement(
    ` CHECK  ( "Email" = E'A  B;--X'
       AND note = $tag$MiX  Sp$tag$ /* comment AND FALSE */
       AND FLAG = TRUE ) `,
  );
  assert.equal(
    canonical,
    `check ( "Email" = E'A  B;--X' and note = $tag$MiX  Sp$tag$ and flag = true )`,
  );
  assert.equal(canonicalizePostgresStatement("SELECT/**/TRUE"), "select true");
  assert.notEqual(
    canonicalizePostgresStatement("CHECK (value = 'A B')"),
    canonicalizePostgresStatement("CHECK (value = 'AB')"),
  );
  assert.notEqual(
    canonicalizePostgresStatement('CHECK ("Value" = 1)'),
    canonicalizePostgresStatement('CHECK ("value" = 1)'),
  );
});

test("fails closed on every unterminated PostgreSQL lexical state", () => {
  for (const sql of [
    "SELECT 'unterminated",
    'SELECT "unterminated',
    "SELECT E'escaped\\",
    "SELECT /* unterminated",
    "SELECT $tag$unterminated",
  ]) {
    assert.throws(
      () => splitPostgresStatements(sql),
      /Unterminated PostgreSQL/u,
    );
  }
});

test("reports JavaScript source positions as UTF-16 code-unit offsets", () => {
  const sql = "SELECT '🙂';\nSELECT 'unterminated";
  const expectedOffset = sql.indexOf("'unterminated");

  assert.throws(
    () => splitPostgresStatements(sql),
    (error) => {
      assert.ok(error instanceof SyntaxError);
      assert.match(
        error.message,
        new RegExp(
          `UTF-16 code-unit offset ${expectedOffset}[.]$`,
          "u",
        ),
      );
      assert.doesNotMatch(error.message, /byte offset/u);
      return true;
    },
  );
});
