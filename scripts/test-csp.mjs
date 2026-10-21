import { spawnSync, spawn } from "node:child_process";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { runDatabaseRoleBootstrap } from "./bootstrap-database-roles.mjs";
import { runProductionMigration } from "./migrate-production.mjs";

// Disposable PostgreSQL and the production migrator keep this browser check
// independent of developer databases, credentials and stored release evidence.
const container = `codestead-csp-${randomUUID()}`;
const secret = "local-csp-verification-only-secret-32-bytes";
const credentials = Object.fromEntries(["bootstrap", "app", "migrator", "worker", "mailWorker", "ops", "backupReporter"].map((role) => [role, randomBytes(32).toString("hex")]));
function docker(args, env = process.env) {
  const result = spawnSync("docker", args, { encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(`CSP fixture Docker command failed: ${args[0]}`);
  return result.stdout.trim();
}
let started = false;
async function runNode(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (status !== 0) {
    for (const value of Object.values(credentials)) output = output.replaceAll(value, "[redacted]");
    if (env.CSP_SESSION_COOKIE) output = output.replaceAll(env.CSP_SESSION_COOKIE, "[redacted]");
    process.stderr.write(output);
    throw new Error("CSP verification command failed");
  }
}
try {
  const buildEnvironment = {
    ...process.env, APP_URL: "https://localhost:3130", BETTER_AUTH_SECRET: secret,
    LOST_DEVICE_PROOF_KEY: "local-csp-verification-only-proof-32-bytes",
    GOOGLE_CLIENT_ID: "csp-test.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "csp-test-only",
  };
  await runNode(["node_modules/tsx/dist/cli.mjs", "scripts/sync-monaco-assets.ts"], buildEnvironment);
  await runNode(["node_modules/next/dist/bin/next", "build"], buildEnvironment);
  docker(["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,size=512m", "--env", "POSTGRES_DB=learncoding_integration", "--env", "POSTGRES_USER=codestead_ui", "--env", "POSTGRES_PASSWORD", "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"], { ...process.env, POSTGRES_PASSWORD: credentials.bootstrap });
  started = true;
  const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
  const names = { bootstrap: "codestead_ui", app: "learncoding_app", migrator: "learncoding_migrator", worker: "learncoding_worker", mailWorker: "learncoding_mail_worker", ops: "learncoding_ops", backupReporter: "learncoding_backup_reporter" };
  const urls = Object.fromEntries(Object.entries(names).map(([role, name]) => [role, `postgresql://${name}:${credentials[role]}@127.0.0.1:${port}/learncoding_integration`]));
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ connectionString: urls.bootstrap });
    try { await client.connect(); await client.end(); break; }
    catch { await client.end().catch(() => {}); if (attempt >= 60) throw new Error("CSP PostgreSQL fixture did not start"); await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  const containerUrl = (url) => { const parsed = new URL(url); parsed.hostname = "postgres"; parsed.port = "5432"; return parsed.href; };
  for (const complete of [false, true]) {
    await runDatabaseRoleBootstrap({
      postgresUser: "codestead_ui", postgresDatabase: "learncoding_integration",
      databaseBootstrapUrl: containerUrl(urls.bootstrap), databaseAppUrl: containerUrl(urls.app),
      databaseMigratorUrl: containerUrl(urls.migrator), databaseWorkerUrl: containerUrl(urls.worker), databaseMailWorkerUrl: containerUrl(urls.mailWorker),
      databaseOpsUrl: containerUrl(urls.ops), databaseBackupReporterUrl: containerUrl(urls.backupReporter),
      requireCompleteMigrationLedger: complete, lockTimeoutMs: 10_000, cleanupTimeoutMs: 5_000,
      pool: new pg.Pool({ connectionString: urls.bootstrap, max: 1 }),
      clusterAdministrationPool: new pg.Pool({ connectionString: urls.bootstrap.replace("/learncoding_integration", "/postgres"), max: 1 }),
    });
    if (!complete) await runProductionMigration({ connectionString: urls.migrator, migrationsFolder: path.resolve("drizzle"), requiredPostgresMajor: 17 });
  }
  const client = new pg.Client({ connectionString: urls.app });
  const token = randomBytes(32).toString("hex");
  try {
    await client.connect();
    await client.query(`INSERT INTO "user" (id,name,email,email_verified,status,must_change_password,two_factor_enabled,adult_confirmed_at,created_at,updated_at) VALUES ('csp-learner','CSP Learner','csp@example.invalid',true,'active',false,true,now(),now(),now())`);
    await client.query(`INSERT INTO learner_profile (user_id,selected_tracks,onboarding_step,onboarding_completed_at) VALUES ('csp-learner','["python"]'::jsonb,'complete',now())`);
    await client.query(`INSERT INTO session (id,user_id,token,expires_at,mfa_verified_at,created_at,updated_at) VALUES ('csp-session','csp-learner',$1,now()+interval '1 hour',now(),now(),now())`, [token]);
  } finally { await client.end(); }
  const cookie = encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);
  await runNode(["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.csp.config.ts"], {
    ...process.env, DATABASE_URL: urls.app, CSP_SESSION_COOKIE: cookie,
  });
} catch (error) {
  let message = error instanceof Error ? error.message : "unknown error";
  for (const value of Object.values(credentials)) message = message.replaceAll(value, "[redacted]");
  console.error(`CSP browser fixture failed: ${message}`);
  process.exitCode = 1;
} finally {
  if (started) docker(["rm", "--force", container]);
}
