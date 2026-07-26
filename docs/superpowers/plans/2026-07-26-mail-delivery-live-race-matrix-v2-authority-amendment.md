# Task 9 V2 Authority Amendment - Exact Major Selection

This amendment has highest precedence in the Task 9 design bundle.

## PostgreSQL image selection

`scripts/run-mail-delivery-race-matrix.ts` must not merely choose a local
constant. The existing disposable launcher reads
`INTEGRATION_POSTGRES_IMAGE`; without that variable it defaults to
PostgreSQL 17.

For each major, the matrix runner:

1. starts from an environment allowlist;
2. rejects a conflicting ambient `INTEGRATION_POSTGRES_IMAGE`;
3. sets `INTEGRATION_POSTGRES_IMAGE` to the exact approved, digest-pinned
   `POSTGRES_17_INTEGRATION_IMAGE` or
   `POSTGRES_18_INTEGRATION_IMAGE`;
4. passes that exact child environment to
   `tsx scripts/run-integration-tests.ts`;
5. verifies through Docker inspection that the running container image
   matches the selected digest;
6. queries `server_version_num` and requires `170000 <= value < 180000` for
   PG17 or `180000 <= value < 190000` for PG18;
7. records the selected digest and SQL-derived version in evidence.

A PG18 command that starts PG17 fails before any case record is accepted.

## Launcher authority inputs

Before creating any pool, parse the launcher-provided nonce and mapped port
from the exact environment keys defined by Work Item 1. Require:

- a canonical at-least-128-bit nonce encoding;
- an integer mapped port in range `1..65535`, not `5432`;
- exact equality between that port and every loopback role URL;
- equality between the nonce digest, mapped port, Docker run label, protected
  server attestation, and launcher record.

Malformed URL, nonce, port, Docker metadata, or server-attestation failures
collapse to one reviewed redacted error code. No raw parser or Docker error
may reach test output.

## Command portability

Windows PowerShell documentation may use `npm.cmd` and `npx.cmd`. Linux CI
uses `npm` and `npx`. Package-script values never contain a `.cmd`
executable name.
