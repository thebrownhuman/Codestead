import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

export type ProductionLoadSystemdCredentialName =
  | "database_url"
  | "better_auth_secret";

export type ProductionLoadCredentialFileIdentity = {
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly linkCount: number;
  readonly size: number;
  readonly device: number;
  readonly inode: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
};

export type ReadProductionLoadSystemdCredentialOptions = {
  readonly environment: NodeJS.ProcessEnv;
  readonly name: ProductionLoadSystemdCredentialName;
  readonly inspect?: (target: string) => Promise<ProductionLoadCredentialFileIdentity>;
  readonly read?: (target: string, maximumBytes: number) => Promise<{
    readonly bytes: Uint8Array;
    readonly before: ProductionLoadCredentialFileIdentity;
    readonly after: ProductionLoadCredentialFileIdentity;
  }>;
};

const maximumCredentialBytes = 16 * 1024;
const credentialDirectoryPattern =
  /^\/run\/credentials\/[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

function fail(code: string): never {
  throw new Error(`Production load systemd credential failed: ${code}`);
}

function identity(metadata: Awaited<ReturnType<typeof lstat>>): ProductionLoadCredentialFileIdentity {
  return {
    kind: metadata.isSymbolicLink()
      ? "symbolic-link"
      : metadata.isFile()
        ? "file"
        : metadata.isDirectory()
          ? "directory"
          : "other",
    uid: Number(metadata.uid),
    gid: Number(metadata.gid),
    mode: Number(metadata.mode) & 0o777,
    linkCount: Number(metadata.nlink),
    size: Number(metadata.size),
    device: Number(metadata.dev),
    inode: Number(metadata.ino),
    modifiedAtMs: Number(metadata.mtimeMs),
    changedAtMs: Number(metadata.ctimeMs),
  };
}

const defaultInspect = async (target: string): Promise<ProductionLoadCredentialFileIdentity> =>
  identity(await lstat(target));

const defaultRead: NonNullable<ReadProductionLoadSystemdCredentialOptions["read"]> =
  async (target, maximumBytes) => {
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = identity(await handle.stat());
      if (before.size <= 0 || before.size > maximumBytes) fail("unsafe_credential_file");
      const bytes = await handle.readFile();
      const after = identity(await handle.stat());
      return { bytes, before, after };
    } finally {
      await handle.close();
    }
  };

function sameIdentity(
  left: ProductionLoadCredentialFileIdentity,
  right: ProductionLoadCredentialFileIdentity,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedAtMs === right.modifiedAtMs
    && left.changedAtMs === right.changedAtMs;
}

function safeFile(value: ProductionLoadCredentialFileIdentity): boolean {
  return value.kind === "file"
    && value.uid === 0
    && value.gid === 0
    && value.mode === 0o400
    && value.linkCount === 1
    && Number.isSafeInteger(value.size)
    && value.size > 0
    && value.size <= maximumCredentialBytes
    && Number.isSafeInteger(value.device)
    && value.device > 0
    && Number.isSafeInteger(value.inode)
    && value.inode > 0;
}

export function resolveProductionLoadCredentialPath(
  environment: NodeJS.ProcessEnv,
  name: ProductionLoadSystemdCredentialName,
): string {
  const directory = environment.CREDENTIALS_DIRECTORY;
  if (typeof directory !== "string"
    || !credentialDirectoryPattern.test(directory)
    || path.posix.normalize(directory) !== directory) {
    fail("invalid_credentials_directory");
  }
  return `${directory}/${name}`;
}

export async function readProductionLoadSystemdCredential(
  options: ReadProductionLoadSystemdCredentialOptions,
): Promise<string> {
  const target = resolveProductionLoadCredentialPath(options.environment, options.name);
  const inspect = options.inspect ?? defaultInspect;
  const read = options.read ?? defaultRead;
  let pathIdentity: ProductionLoadCredentialFileIdentity;
  let result: Awaited<ReturnType<typeof read>>;
  try {
    pathIdentity = await inspect(target);
    if (!safeFile(pathIdentity)) fail("unsafe_credential_file");
    result = await read(target, maximumCredentialBytes);
  } catch (error) {
    if (error instanceof Error
      && error.message.startsWith("Production load systemd credential failed:")) {
      throw error;
    }
    fail("unsafe_credential_file");
  }
  if (!safeFile(result.before) || !safeFile(result.after)) fail("unsafe_credential_file");
  if (!sameIdentity(pathIdentity, result.before)
    || !sameIdentity(result.before, result.after)) {
    fail("credential_changed");
  }
  if (result.bytes.byteLength !== result.after.size
    || result.bytes.byteLength <= 0
    || result.bytes.byteLength > maximumCredentialBytes) {
    fail("credential_changed");
  }
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
  } catch {
    fail("invalid_credential_bytes");
  }
  if (!value || /[\0\r\n]/.test(value)) fail("invalid_credential_bytes");
  return value;
}
