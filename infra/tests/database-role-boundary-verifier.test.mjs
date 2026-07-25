import assert from "node:assert/strict";
import test from "node:test";

import {
  DATABASE_PRIVILEGE_MANIFEST,
  expectedTablePrivilegeRows,
  validateDatabasePrivilegeCatalogSnapshot,
} from "../../scripts/database-privilege-manifest.mjs";

function exactSnapshot() {
  return {
    tableNames: Object.keys(DATABASE_PRIVILEGE_MANIFEST.tables),
    tablePrivileges: expectedTablePrivilegeRows(),
    columnPrivileges: [],
    defaultAcls: [],
  };
}

test("catalog verifier rejects a grant-option tamper on a non-first object", () => {
  const snapshot = exactSnapshot();
  assert.ok(snapshot.tablePrivileges.length > 1);
  snapshot.tablePrivileges[1] = {
    ...snapshot.tablePrivileges[1],
    isGrantable: true,
  };

  assert.throws(
    () => validateDatabasePrivilegeCatalogSnapshot(snapshot),
    /database privilege catalog does not match the manifest/u,
  );
});

test("catalog verifier rejects every non-owner default ACL grant", () => {
  const snapshot = exactSnapshot();
  snapshot.defaultAcls.push({
    owner: "learncoding_owner",
    schema: "public",
    kind: "r",
    grantee: "learncoding_app",
    privilege: "SELECT",
    isGrantable: false,
  });

  assert.throws(
    () => validateDatabasePrivilegeCatalogSnapshot(snapshot),
    /database privilege catalog does not match the manifest/u,
  );
});

test("catalog verifier rejects legacy column ACLs", () => {
  const snapshot = exactSnapshot();
  snapshot.columnPrivileges.push({
    table: "lesson",
    column: "title",
    role: "learncoding_app",
    privilege: "SELECT",
    isGrantable: false,
  });

  assert.throws(
    () => validateDatabasePrivilegeCatalogSnapshot(snapshot),
    /database privilege catalog does not match the manifest/u,
  );
});
