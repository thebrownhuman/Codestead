import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const programPath = process.argv[2];
assert.ok(programPath, "captured authenticated smoke program path is required");
let program = readFileSync(programPath, "utf8");
program = program
  .replace('import { randomUUID } from "node:crypto";\n', "")
  .replace('import pg from "pg";\n', "")
  .replace('import { makeSignature } from "better-auth/crypto";\n', "");

const prelude = String.raw`
const events = [];
let uuidCounter = 0;
const randomUUID = () => "00000000-0000-4000-8000-" + String(++uuidCounter).padStart(12, "0");
const makeSignature = async () => "test-signature";
let staleUser = process.env.FAKE_STALE_FIXTURE === "1";
let cleanupCalls = 0;
let activeSession = false;
let insertedUserId = "";
let insertedSessionId = "";

class FakeClient {
  async query(statement, parameters = []) {
    const sql = String(statement).replace(/\s+/g, " ").trim();
    if (sql.includes("pg_advisory_lock")) {
      events.push("lock");
      return { rows: [{ locked: null }] };
    }
    if (sql.includes("pg_advisory_unlock")) {
      events.push("unlock");
      return { rows: [{ unlocked: true }] };
    }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      events.push(sql.toLowerCase());
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM "user" WHERE name =')) {
      cleanupCalls += 1;
      events.push("cleanup-user:" + (staleUser ? 1 : 0) + ":" + cleanupCalls);
      if (process.env.FAKE_FINAL_CLEANUP_FAILURE === "1" && cleanupCalls === 2) {
        throw new Error("synthetic cleanup failure");
      }
      staleUser = false;
      activeSession = false;
      return { rows: [] };
    }
    if (sql.startsWith("DELETE FROM runner_job")) {
      events.push("cleanup-runner-job");
      return { rows: [] };
    }
    if (sql.startsWith("DELETE FROM code_submission")) {
      events.push("cleanup-submission");
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO "user"')) {
      events.push("insert-user");
      insertedUserId = parameters[0];
      staleUser = true;
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO session")) {
      insertedSessionId = parameters[0];
      activeSession = true;
      return { rows: [] };
    }
    if (sql.startsWith("DELETE FROM session")) {
      activeSession = false;
      return { rows: [] };
    }
    if (sql.includes("drizzle.__drizzle_migrations")) return { rows: [{ total: 1, distinct_ids: 1 }] };
    if (sql.includes("FROM provider_policy")) return { rows: [{ total: 2 }] };
    if (sql.includes("FROM achievement")) return { rows: [{ total: 5 }] };
    if (sql.includes("FROM course") && sql.includes("module_project_template")) {
      return { rows: [{ courses: 1, projects: 1 }] };
    }
    if (sql.includes('FROM "user" WHERE role = \'admin\'')) {
      return { rows: [{ total: 1, email: "admin@example.test" }] };
    }
    if (sql.includes("FROM stored_object")) return { rows: [{ total: 0 }] };
    return { rows: [] };
  }

  release(destroyed) {
    events.push("release:" + (destroyed === true));
  }
}

const fakeClient = new FakeClient();
class FakePool {
  async connect() {
    events.push("connect");
    return fakeClient;
  }
  async query(statement, parameters) {
    return fakeClient.query(statement, parameters);
  }
  async end() {
    events.push("pool-end");
  }
}
const pg = { Pool: FakePool };

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  const cookie = init.headers?.cookie ?? "";
  const authenticated = Boolean(cookie) && activeSession;
  if (url.pathname === "/api/auth/get-session") {
    return jsonResponse(authenticated ? 200 : 401, authenticated
      ? { user: { id: insertedUserId }, session: { id: insertedSessionId } }
      : { code: "UNAUTHORIZED" });
  }
  if (url.pathname === "/api/files" && init.method === "POST") {
    return jsonResponse(503, { code: "UPLOADS_DISABLED" });
  }
  if (url.pathname === "/api/files") {
    return jsonResponse(authenticated ? 200 : 401, authenticated
      ? { files: [], uploadsEnabled: false }
      : { code: "UNAUTHORIZED" });
  }
  if (url.pathname === "/api/code/run" && init.method === "POST") {
    return jsonResponse(200, {
      status: "accepted",
      stdout: "codestead-production-smoke\n",
      stderr: "",
      exitCode: 0,
      officialMasteryEvidence: false,
      imageDigest: "sha256:" + "a".repeat(64),
    });
  }
  if (url.pathname === "/api/code/run") return jsonResponse(200, { available: true, concurrency: 2 });
  throw new Error("unexpected fake request: " + url.pathname);
};
`;
const epilogue = '\nprocess.stdout.write("SMOKE_EVENTS=" + JSON.stringify(events) + "\\n");\n';

function execute(extraEnvironment = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", prelude + program + epilogue], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://fixture.invalid/codestead",
      BETTER_AUTH_SECRET: "fixture-secret",
      ...extraEnvironment,
    },
    timeout: 20_000,
  });
  const eventLine = result.stdout.split("\n").find((line) => line.startsWith("SMOKE_EVENTS="));
  assert.ok(eventLine, `smoke lifecycle did not emit events: ${result.stderr}`);
  return { ...result, events: JSON.parse(eventLine.slice("SMOKE_EVENTS=".length)) };
}

const recovered = execute({ FAKE_STALE_FIXTURE: "1" });
assert.equal(recovered.status, 0, recovered.stderr);
assert.match(recovered.stdout, /production authenticated smoke passed/);
assert.ok(recovered.events.indexOf("lock") < recovered.events.indexOf("cleanup-user:1:1"));
assert.ok(recovered.events.indexOf("cleanup-user:1:1") < recovered.events.indexOf("insert-user"));
assert.ok(recovered.events.includes("cleanup-user:1:2"), "final cleanup did not remove the new fixture");
assert.ok(recovered.events.includes("unlock"), "advisory lock was not released");
assert.ok(recovered.events.includes("release:false"), "healthy client was not released cleanly");

const cleanupFailure = execute({ FAKE_STALE_FIXTURE: "1", FAKE_FINAL_CLEANUP_FAILURE: "1" });
assert.notEqual(cleanupFailure.status, 0, "cleanup failure did not fail the smoke process");
assert.doesNotMatch(cleanupFailure.stdout, /production authenticated smoke passed/);
assert.match(cleanupFailure.stderr, /production authenticated smoke failed/);
assert.ok(cleanupFailure.events.includes("release:true"), "failed cleanup did not discard the client");
assert.ok(cleanupFailure.events.includes("unlock"), "failed cleanup did not attempt advisory unlock");

process.stdout.write("smoke-fixture-lifecycle-tests-ok\n");
