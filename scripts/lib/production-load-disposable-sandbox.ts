import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const PRODUCTION_LOAD_DISPOSABLE_ATTESTATION_PATH =
  "/run/secrets/production_load_network_attestation";

const EXPECTED_ATTESTATION = [
  "schema=1",
  "profile=codestead-production-load-disposable-network-v1",
  "egress=default-deny",
  "",
].join("\n");

export type ProductionLoadDisposableNetworkSandbox = {
  readonly postgres: {
    readonly listenHost: "0.0.0.0";
    readonly listenPort: number;
    readonly upstreamHost: "production-load-postgres";
    readonly upstreamPort: 5432;
    readonly maximumConnections: 16;
  };
  readonly tunnel: {
    readonly listenHost: "0.0.0.0";
    readonly listenPort: number;
    readonly upstreamHost: "production-load-app";
    readonly upstreamPort: 3000;
    readonly maximumConnections: 16;
  };
  readonly provider: {
    readonly listenHost: "0.0.0.0";
    readonly listenPort: number;
  };
};

export type ProductionLoadDisposableSandboxEvidence = {
  readonly platform: string;
  readonly uid: number | undefined;
  readonly gid: number | undefined;
  readonly attestation: string;
  readonly attestationSafe: boolean;
  readonly dockerEnvironmentSafe: boolean;
  readonly hasDefaultRoute: boolean;
  readonly dangerousHostPathsPresent: boolean;
};

const FIXED_SANDBOX: ProductionLoadDisposableNetworkSandbox = Object.freeze({
  postgres: Object.freeze({
    listenHost: "0.0.0.0" as const,
    listenPort: 15_432,
    upstreamHost: "production-load-postgres" as const,
    upstreamPort: 5432 as const,
    maximumConnections: 16 as const,
  }),
  tunnel: Object.freeze({
    listenHost: "0.0.0.0" as const,
    listenPort: 13_000,
    upstreamHost: "production-load-app" as const,
    upstreamPort: 3000 as const,
    maximumConnections: 16 as const,
  }),
  provider: Object.freeze({
    listenHost: "0.0.0.0" as const,
    listenPort: 18_080,
  }),
});

function fail(): never {
  throw new Error("Production load disposable sandbox failed: unattested_sandbox");
}

export function validateProductionLoadDisposableSandboxEvidence(
  evidence: ProductionLoadDisposableSandboxEvidence,
): ProductionLoadDisposableNetworkSandbox {
  if (evidence.platform !== "linux"
    || evidence.uid !== 65_532
    || evidence.gid !== 65_532
    || evidence.attestation !== EXPECTED_ATTESTATION
    || !evidence.attestationSafe
    || !evidence.dockerEnvironmentSafe
    || evidence.hasDefaultRoute
    || evidence.dangerousHostPathsPresent) {
    fail();
  }
  return FIXED_SANDBOX;
}

async function safeRootOwnedFile(target: string, expectedMode: number | null): Promise<boolean> {
  try {
    const expectedParent = path.dirname(target);
    const parent = await realpath(expectedParent);
    if (parent !== expectedParent) return false;
    const metadata = await lstat(target);
    const mode = metadata.mode & 0o777;
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && metadata.uid === 0
      && metadata.gid === 0
      && metadata.nlink === 1
      && (expectedMode === null ? (mode & 0o022) === 0 : mode === expectedMode);
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

function ipv4RouteTableHasDefaultRoute(routeTable: string): boolean {
  const lines = routeTable.split("\n").slice(1);
  return lines.some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields.length >= 4 && fields[1] === "00000000" && (Number.parseInt(fields[3] ?? "0", 16) & 1) === 1;
  });
}
function ipv6RouteTableHasDefaultRoute(routeTable: string): boolean {
  return routeTable.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields.length >= 10
      && fields[0] === "0".repeat(32)
      && fields[1] === "00"
      && (Number.parseInt(fields[8] ?? "0", 16) & 1) === 1;
  });
}

export async function assertProductionLoadDisposableNetworkSandbox(): Promise<
  ProductionLoadDisposableNetworkSandbox
> {
  let attestation = "";
  let ipv4RouteTable = "";
  let ipv6RouteTable = "";
  try {
    [attestation, ipv4RouteTable, ipv6RouteTable] = await Promise.all([
      readFile(PRODUCTION_LOAD_DISPOSABLE_ATTESTATION_PATH, "utf8"),
      readFile("/proc/net/route", "utf8"),
      readFile("/proc/net/ipv6_route", "utf8"),
    ]);
  } catch {
    fail();
  }
  const [attestationSafe, dockerEnvironmentSafe, ...dangerousPaths] = await Promise.all([
    safeRootOwnedFile(PRODUCTION_LOAD_DISPOSABLE_ATTESTATION_PATH, 0o444),
    safeRootOwnedFile("/.dockerenv", null),
    pathExists("/run/docker.sock"),
    pathExists("/run/libvirt"),
    pathExists("/dev/kvm"),
  ]);
  return validateProductionLoadDisposableSandboxEvidence({
    platform: process.platform,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    attestation,
    attestationSafe,
    dockerEnvironmentSafe,
    hasDefaultRoute: ipv4RouteTableHasDefaultRoute(ipv4RouteTable)
      || ipv6RouteTableHasDefaultRoute(ipv6RouteTable),
    dangerousHostPathsPresent: dangerousPaths.some(Boolean),
  });
}
