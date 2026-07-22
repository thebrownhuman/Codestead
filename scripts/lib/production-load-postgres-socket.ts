import { lstat } from "node:fs/promises";

export const PRODUCTION_LOAD_POSTGRES_SOCKET_PATH =
  "/run/learncoding-postgres/.s.PGSQL.5432";

export type ProductionLoadPostgresPathIdentity = {
  readonly kind: "directory" | "socket" | "symbolic-link" | "other";
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly linkCount: number;
  readonly device: number;
  readonly inode: number;
};

export type ProductionLoadPostgresSocketIdentity = {
  readonly device: number;
  readonly inode: number;
};

export type AssertProductionLoadPostgresSocketOptions = {
  readonly platform?: NodeJS.Platform;
  readonly inspect?: (
    target: string,
  ) => Promise<ProductionLoadPostgresPathIdentity>;
};

function fail(code: string): never {
  throw new Error(`Production load PostgreSQL socket failed: ${code}`);
}

const defaultInspect = async (
  target: string,
): Promise<ProductionLoadPostgresPathIdentity> => {
  const metadata = await lstat(target);
  return {
    kind: metadata.isSymbolicLink()
      ? "symbolic-link"
      : metadata.isDirectory()
        ? "directory"
        : metadata.isSocket()
          ? "socket"
          : "other",
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o777,
    linkCount: metadata.nlink,
    device: metadata.dev,
    inode: metadata.ino,
  };
};

function safeInteger(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

function commonIdentitySafe(value: ProductionLoadPostgresPathIdentity): boolean {
  return safeInteger(value.uid, 0)
    && safeInteger(value.gid, 0)
    && safeInteger(value.mode, 0)
    && value.mode <= 0o777
    && safeInteger(value.linkCount, 1)
    && safeInteger(value.device, 0)
    && safeInteger(value.inode, 0);
}

export async function assertProductionLoadPostgresSocketIdentity(
  options: AssertProductionLoadPostgresSocketOptions = {},
): Promise<ProductionLoadPostgresSocketIdentity> {
  if ((options.platform ?? process.platform) !== "linux") fail("linux_only");
  const inspect = options.inspect ?? defaultInspect;
  let run: ProductionLoadPostgresPathIdentity;
  let directory: ProductionLoadPostgresPathIdentity;
  let socket: ProductionLoadPostgresPathIdentity;
  try {
    [run, directory, socket] = await Promise.all([
      inspect("/run"),
      inspect("/run/learncoding-postgres"),
      inspect(PRODUCTION_LOAD_POSTGRES_SOCKET_PATH),
    ]);
  } catch {
    fail("unsafe_socket_identity");
  }

  if (!commonIdentitySafe(run)
    || run.kind !== "directory"
    || run.uid !== 0
    || run.gid !== 0
    || run.mode !== 0o755
    || run.linkCount < 2
    || !commonIdentitySafe(directory)
    || directory.kind !== "directory"
    || directory.uid !== 999
    || directory.gid !== 999
    || directory.mode !== 0o700
    || directory.linkCount < 2
    || !commonIdentitySafe(socket)
    || socket.kind !== "socket"
    || socket.uid !== 999
    || socket.gid !== 999
    || socket.mode !== 0o700
    || socket.linkCount !== 1
    || socket.device <= 0
    || socket.inode <= 0) {
    fail("unsafe_socket_identity");
  }
  return { device: socket.device, inode: socket.inode };
}

export function assertProductionLoadPostgresSocketUnchanged(
  before: ProductionLoadPostgresSocketIdentity,
  after: ProductionLoadPostgresSocketIdentity,
): void {
  if (!safeInteger(before.device, 1)
    || !safeInteger(before.inode, 1)
    || before.device !== after.device
    || before.inode !== after.inode) {
    fail("socket_identity_changed");
  }
}
