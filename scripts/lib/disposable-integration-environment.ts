import { Buffer } from "node:buffer";

const SAFE_HOST_ENVIRONMENT_KEYS = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "CI",
  "GITHUB_ACTIONS",
] as const;

function sourceValue(
  source: NodeJS.ProcessEnv,
  canonicalKey: string,
): string | undefined {
  const entry = Object.entries(source).find(
    ([key]) => key.toUpperCase() === canonicalKey,
  );
  return entry?.[1];
}

export function buildSafeIntegrationHostEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_HOST_ENVIRONMENT_KEYS) {
    const value = sourceValue(source, key);
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

export function buildDockerIntegrationEnvironment(
  source: NodeJS.ProcessEnv,
  password: string,
): NodeJS.ProcessEnv {
  return {
    ...buildSafeIntegrationHostEnvironment(source),
    POSTGRES_PASSWORD: password,
  };
}

export function buildNpmIntegrationEnvironment(
  source: NodeJS.ProcessEnv,
  input: Readonly<{
    databaseUrl: string;
    betterAuthSecret: string;
  }>,
): NodeJS.ProcessEnv {
  return {
    ...buildSafeIntegrationHostEnvironment(source),
    DATABASE_URL: input.databaseUrl,
    DATABASE_POOL_SIZE: "8",
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: input.betterAuthSecret,
    INTEGRATION_TEST: "1",
  };
}

function uniqueSecrets(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) => result.replaceAll(secret, "[REDACTED]"),
    value,
  );
}

function safePrefixLength(
  value: string,
  secrets: readonly string[],
  maximumSecretLength: number,
): number {
  let prefixLength = Math.max(0, value.length - Math.max(0, maximumSecretLength - 1));
  for (const secret of secrets) {
    const searchStart = Math.max(0, prefixLength - secret.length + 1);
    const matchIndex = value.indexOf(secret, searchStart);
    if (
      matchIndex >= 0
      && matchIndex < prefixLength
      && matchIndex + secret.length > prefixLength
    ) {
      prefixLength = matchIndex;
    }
  }
  return prefixLength;
}

export function createIntegrationOutputSanitizer(input: Readonly<{
  secrets: readonly string[];
  write: (value: string) => void;
}>): Readonly<{
  end: () => void;
  write: (value: string | Uint8Array) => void;
}> {
  const secrets = uniqueSecrets(input.secrets);
  const maximumSecretLength = Math.max(0, ...secrets.map((secret) => secret.length));
  let pending = "";

  const flushPrefix = () => {
    const prefixLength = safePrefixLength(
      pending,
      secrets,
      maximumSecretLength,
    );
    if (prefixLength === 0) return;
    input.write(redact(pending.slice(0, prefixLength), secrets));
    pending = pending.slice(prefixLength);
  };

  return {
    write(value) {
      pending += typeof value === "string"
        ? value
        : Buffer.from(value).toString("utf8");
      flushPrefix();
    },
    end() {
      if (pending.length > 0) {
        input.write(redact(pending, secrets));
        pending = "";
      }
    },
  };
}
