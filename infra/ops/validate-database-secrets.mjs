import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const INVALID_MESSAGE = "database secret topology is invalid";
const MIN_PASSWORD_BYTES = 32;
const MAX_PASSWORD_BYTES = 1024;
const FIXED_USERS = Object.freeze({
  app: "learncoding_app",
  migrator: "learncoding_migrator",
  worker: "learncoding_worker",
  ops: "learncoding_ops",
});

function invalid() {
  return new Error(INVALID_MESSAGE);
}

function decodeRequired(value) {
  const decoded = decodeURIComponent(value);
  if (!decoded || /[\u0000-\u001f\u007f]/u.test(decoded)) throw invalid();
  return decoded;
}

function parseUrl(value, expectedUser, expectedDatabase) {
  const url = new URL(value);
  const username = decodeRequired(url.username);
  const password = decodeRequired(url.password);
  const passwordBytes = Buffer.byteLength(password, "utf8");
  if (passwordBytes < MIN_PASSWORD_BYTES || passwordBytes > MAX_PASSWORD_BYTES) {
    throw invalid();
  }
  const database = decodeRequired(url.pathname.slice(1));
  if (
    url.protocol !== "postgresql:" ||
    username !== expectedUser ||
    url.hostname !== "postgres" ||
    (url.port !== "" && url.port !== "5432") ||
    database !== expectedDatabase ||
    url.pathname !== `/${encodeURIComponent(expectedDatabase)}` ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw invalid();
  }
  return { username, password };
}

export function validateDatabaseSecretValues(values) {
  try {
    if (
      !/^[a-z_][a-z0-9_]{0,62}$/u.test(values.postgresUser) ||
      !/^[a-z_][a-z0-9_]{0,62}$/u.test(values.postgresDatabase) ||
      !values.postgresPassword ||
      /[\u0000-\u001f\u007f]/u.test(values.postgresPassword) ||
      Buffer.byteLength(values.postgresPassword, "utf8") < MIN_PASSWORD_BYTES ||
      Buffer.byteLength(values.postgresPassword, "utf8") > MAX_PASSWORD_BYTES
    ) {
      throw invalid();
    }

    const bootstrap = parseUrl(
      values.databaseBootstrapUrl,
      values.postgresUser,
      values.postgresDatabase,
    );
    const restricted = Object.entries(FIXED_USERS).map(([name, username]) =>
      parseUrl(
        values[`database${name[0].toUpperCase()}${name.slice(1)}Url`],
        username,
        values.postgresDatabase,
      ),
    );
    if (bootstrap.password !== values.postgresPassword) throw invalid();
    const passwords = [bootstrap.password, ...restricted.map((entry) => entry.password)];
    if (new Set(passwords).size !== passwords.length) throw invalid();

    return {
      bootstrapUser: bootstrap.username,
      database: values.postgresDatabase,
      restrictedUsers: restricted.map((entry) => entry.username),
    };
  } catch {
    throw invalid();
  }
}

function readSecret(path) {
  return readFileSync(path, "utf8");
}

function main(argv) {
  if (argv.length !== 8) throw invalid();
  const [
    postgresUser,
    postgresDatabase,
    postgresPasswordPath,
    databaseBootstrapUrlPath,
    databaseAppUrlPath,
    databaseMigratorUrlPath,
    databaseWorkerUrlPath,
    databaseOpsUrlPath,
  ] = argv;
  validateDatabaseSecretValues({
    postgresUser,
    postgresDatabase,
    postgresPassword: readSecret(postgresPasswordPath),
    databaseBootstrapUrl: readSecret(databaseBootstrapUrlPath),
    databaseAppUrl: readSecret(databaseAppUrlPath),
    databaseMigratorUrl: readSecret(databaseMigratorUrlPath),
    databaseWorkerUrl: readSecret(databaseWorkerUrlPath),
    databaseOpsUrl: readSecret(databaseOpsUrlPath),
  });
  process.stdout.write("database secret topology valid\n");
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    main(process.argv.slice(2));
  } catch {
    process.stderr.write(`${INVALID_MESSAGE}\n`);
    process.exitCode = 1;
  }
}
