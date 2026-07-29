export type DatabaseRuntimeCapabilityJsonPrimitive =
  | null
  | boolean
  | number
  | string;

export type DatabaseRuntimeCapabilityJsonValue =
  | DatabaseRuntimeCapabilityJsonPrimitive
  | readonly DatabaseRuntimeCapabilityJsonValue[]
  | {
      readonly [key: string]: DatabaseRuntimeCapabilityJsonValue;
    };

export const DATABASE_RUNTIME_CAPABILITY_SCHEMA_VERSION: 1;

export const DATABASE_RUNTIME_CAPABILITY_PHASES: Readonly<{
  FOUNDATION: "foundation";
  CURRENT_0069: "0069-current";
  EXPAND_PREPARE_0070: "0070-expand-prepare";
  CONTRACTED_0071: "0071-contracted";
}>;

export type DatabaseRuntimeCapabilityPhase =
  (typeof DATABASE_RUNTIME_CAPABILITY_PHASES)[keyof typeof DATABASE_RUNTIME_CAPABILITY_PHASES];

export type DatabaseRuntimeCapabilityPolicyPhase =
  | typeof DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069
  | typeof DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071;

export type DatabaseRuntimeCapabilityReconciliationPhase = Exclude<
  DatabaseRuntimeCapabilityPhase,
  typeof DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION
>;

export const CURRENT_0069_REVIEWED_MIGRATION_TAG: "0069_mail_outbox_guarded_delivery_authority";

export class DatabaseRuntimeCapabilityValidationError extends Error {
  constructor(message: string);
}

export class DatabaseRuntimeCapabilityPhaseError extends Error {
  constructor(message: string);
}

export interface DatabaseRuntimeCapabilityBootstrapSessionAuthority {
  readonly kind: "bootstrap-session";
}

export const BOOTSTRAP_SESSION_AUTHORITY: Readonly<DatabaseRuntimeCapabilityBootstrapSessionAuthority>;

export type DatabaseRuntimeCapabilityPrincipal =
  | string
  | DatabaseRuntimeCapabilityBootstrapSessionAuthority;

export interface DatabaseRuntimeCapabilityDatabase {
  readonly identity: "@database";
  readonly owner: "learncoding_owner";
}

export interface DatabaseRuntimeCapabilitySchema {
  readonly identity: "public" | "drizzle";
  readonly name: "public" | "drizzle";
  readonly owner: "learncoding_owner";
}

export interface DatabaseRuntimeCapabilityColumn {
  readonly identity: string;
  readonly name: string;
  readonly ordinal: number;
}

export interface DatabaseRuntimeCapabilityTable {
  readonly identity: string;
  readonly schema: "public" | "drizzle";
  readonly name: string;
  readonly owner: "learncoding_owner";
  readonly columns: readonly DatabaseRuntimeCapabilityColumn[];
}

export interface DatabaseRuntimeCapabilitySequence {
  readonly identity: string;
  readonly schema: "public" | "drizzle";
  readonly name: string;
  readonly owner: "learncoding_owner";
}

export type DatabaseRuntimeCapabilityType =
  | Readonly<{
      identity: string;
      schema: "public" | "drizzle";
      name: string;
      kind: "composite";
      owner: "learncoding_owner";
    }>
  | Readonly<{
      identity: string;
      schema: "public" | "drizzle";
      name: string;
      kind: "enum";
      owner: "learncoding_owner";
      values: readonly string[];
    }>;

export interface DatabaseRuntimeCapabilityRoutine {
  readonly identity: string;
  readonly schema: "public" | "drizzle";
  readonly signature: string;
  readonly kind: "function";
  readonly owner: "learncoding_owner";
}

export interface DatabaseRuntimeCapabilityInventory {
  readonly databases: readonly DatabaseRuntimeCapabilityDatabase[];
  readonly schemas: readonly DatabaseRuntimeCapabilitySchema[];
  readonly tables: readonly DatabaseRuntimeCapabilityTable[];
  readonly sequences: readonly DatabaseRuntimeCapabilitySequence[];
  readonly types: readonly DatabaseRuntimeCapabilityType[];
  readonly routines: readonly DatabaseRuntimeCapabilityRoutine[];
}

export interface DatabaseRuntimeCapabilityRoleCommon {
  readonly identity: string;
  readonly name: string;
  readonly superuser: false;
  readonly createDatabase: false;
  readonly createRole: false;
  readonly inherit: false;
  readonly replication: false;
  readonly bypassRls: false;
  readonly connectionLimit: -1;
  readonly validUntil: "infinity";
  readonly settings: readonly [];
}

export type DatabaseRuntimeCapabilityRole =
  DatabaseRuntimeCapabilityRoleCommon &
    (
      | Readonly<{
          login: false;
          credential: "none";
        }>
      | Readonly<{
          login: true;
          credential: "scram-managed";
        }>
    );

export interface DatabaseRuntimeCapabilityMembership {
  readonly identity: string;
  readonly role: string;
  readonly member: string;
  readonly grantor: DatabaseRuntimeCapabilityBootstrapSessionAuthority;
  readonly adminOption: false;
  readonly inheritOption: false;
  readonly setOption: true;
}

export type DatabaseRuntimeCapabilityGrantObjectKind =
  | "database"
  | "schema"
  | "table"
  | "column"
  | "sequence"
  | "routine"
  | "type";

export type DatabaseRuntimeCapabilityPrivilege =
  | "CONNECT"
  | "CREATE"
  | "TEMPORARY"
  | "USAGE"
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "TRUNCATE"
  | "REFERENCES"
  | "TRIGGER"
  | "MAINTAIN"
  | "EXECUTE";

interface DatabaseRuntimeCapabilityGrantBase {
  readonly objectKind: DatabaseRuntimeCapabilityGrantObjectKind;
  readonly object: string;
  readonly grantor: "learncoding_owner";
  readonly grantee: string;
  readonly grantable: false;
}

export type DatabaseRuntimeCapabilityGrant =
  DatabaseRuntimeCapabilityGrantBase &
    (
      | Readonly<{
          objectKind: "database";
          privilege: "CONNECT" | "CREATE" | "TEMPORARY";
        }>
      | Readonly<{
          objectKind: "schema";
          privilege: "USAGE" | "CREATE";
        }>
      | Readonly<{
          objectKind: "table";
          privilege:
            | "SELECT"
            | "INSERT"
            | "UPDATE"
            | "DELETE"
            | "TRUNCATE"
            | "REFERENCES"
            | "TRIGGER"
            | "MAINTAIN";
        }>
      | Readonly<{
          objectKind: "column";
          privilege: "SELECT" | "INSERT" | "UPDATE" | "REFERENCES";
        }>
      | Readonly<{
          objectKind: "sequence";
          privilege: "USAGE" | "SELECT" | "UPDATE";
        }>
      | Readonly<{
          objectKind: "routine";
          privilege: "EXECUTE";
        }>
      | Readonly<{
          objectKind: "type";
          privilege: "USAGE";
        }>
    );

export type DatabaseRuntimeCapabilityDefaultAclObjectKind =
  | "table"
  | "sequence"
  | "routine"
  | "type";

export interface DatabaseRuntimeCapabilityDefaultAclRow {
  readonly identity: string;
  readonly creator: DatabaseRuntimeCapabilityPrincipal;
  readonly schema: string | null;
  readonly objectKind: DatabaseRuntimeCapabilityDefaultAclObjectKind;
}

interface DatabaseRuntimeCapabilityDefaultAclBase
  extends DatabaseRuntimeCapabilityDefaultAclRow {
  readonly grantor: DatabaseRuntimeCapabilityPrincipal;
  readonly grantee: DatabaseRuntimeCapabilityPrincipal;
  readonly grantable: false;
}

export type DatabaseRuntimeCapabilityDefaultAcl =
  DatabaseRuntimeCapabilityDefaultAclBase &
    (
      | Readonly<{
          objectKind: "table";
          privilege: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
        }>
      | Readonly<{
          objectKind: "sequence";
          privilege: "USAGE" | "SELECT" | "UPDATE";
        }>
      | Readonly<{
          objectKind: "routine";
          privilege: "EXECUTE";
        }>
      | Readonly<{
          objectKind: "type";
          privilege: "USAGE";
        }>
    );

export interface DatabaseRuntimeCapabilityDrizzleSnapshotSource {
  readonly kind: "drizzle-snapshot";
  readonly path: string;
  readonly publicTables: number;
  readonly publicColumns: number;
  readonly columnOrder: "migration-derived-pg-attribute-attnum-v1";
  readonly physicalOrderSource: string;
  readonly physicalOrderSha256: string;
}

export interface DatabaseRuntimeCapabilityMigrationOverlaySource {
  readonly kind: "reviewed-migration-overlay";
  readonly path: string;
  readonly publicTables: number;
  readonly publicColumns: number;
}

export interface DatabaseRuntimeCapabilityDrizzleInternalSource {
  readonly kind: "drizzle-internal-contract";
  readonly path: string;
  readonly tables: number;
  readonly columns: number;
  readonly sequences: number;
}

export type DatabaseRuntimeCapabilityInventorySource =
  | DatabaseRuntimeCapabilityDrizzleSnapshotSource
  | DatabaseRuntimeCapabilityMigrationOverlaySource
  | DatabaseRuntimeCapabilityDrizzleInternalSource;

export interface DatabaseRuntimeCapabilityProvenance {
  readonly inventorySources: readonly [
    DatabaseRuntimeCapabilityDrizzleSnapshotSource,
    DatabaseRuntimeCapabilityMigrationOverlaySource,
    DatabaseRuntimeCapabilityDrizzleInternalSource,
  ];
  readonly expected: Readonly<{
    publicTables: number;
    publicColumns: number;
    publicTypes: number;
    publicRoutines: number;
    publicSequences: number;
  }>;
}

export interface DatabaseRuntimeCapabilityLedger {
  readonly reviewedMigrationTail: string;
  readonly requiredMigrationFile: string | null;
  readonly reason: string | null;
}

export interface DatabaseRuntimeCapabilityAuthority {
  readonly provenance: DatabaseRuntimeCapabilityProvenance;
  readonly inventory: DatabaseRuntimeCapabilityInventory;
  readonly roles: readonly DatabaseRuntimeCapabilityRole[];
  readonly memberships: readonly DatabaseRuntimeCapabilityMembership[];
  readonly grants: readonly DatabaseRuntimeCapabilityGrant[];
  readonly defaultAclRows: readonly DatabaseRuntimeCapabilityDefaultAclRow[];
  readonly defaultAcls: readonly DatabaseRuntimeCapabilityDefaultAcl[];
}

export interface DatabaseRuntimeCapabilityCurrentManifest
  extends DatabaseRuntimeCapabilityAuthority {
  readonly schemaVersion: 1;
  readonly contract: "codestead-database-runtime-capabilities-0069-current-v1";
  readonly phase: typeof DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069;
  readonly available: true;
  readonly ledger: Readonly<{
    reviewedMigrationTail: "0069_mail_outbox_guarded_delivery_authority";
    requiredMigrationFile: "drizzle/0069_mail_outbox_guarded_delivery_authority.sql";
    reason: null;
  }>;
}

export interface DatabaseRuntimeCapabilityPostContractManifest
  extends DatabaseRuntimeCapabilityAuthority {
  readonly schemaVersion: 1;
  readonly contract: "codestead-database-runtime-capabilities-post-contract-v1";
  readonly phase: typeof DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071;
  readonly available: false;
  readonly ledger: Readonly<{
    reviewedMigrationTail: "0071";
    requiredMigrationFile: null;
    reason: string;
  }>;
}

export type DatabaseRuntimeCapabilityManifest =
  | DatabaseRuntimeCapabilityCurrentManifest
  | DatabaseRuntimeCapabilityPostContractManifest;

export interface DatabaseRuntimeCapabilityCatalogDatabase {
  readonly identity: string;
  readonly owner: string;
}

export interface DatabaseRuntimeCapabilityCatalogSchema {
  readonly identity: string;
  readonly name: string;
  readonly owner: string;
}

export interface DatabaseRuntimeCapabilityCatalogColumn {
  readonly identity: string;
  readonly name: string;
  readonly ordinal: number;
}

export interface DatabaseRuntimeCapabilityCatalogTable {
  readonly identity: string;
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  readonly columns: readonly DatabaseRuntimeCapabilityCatalogColumn[];
}

export interface DatabaseRuntimeCapabilityCatalogSequence {
  readonly identity: string;
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
}

export type DatabaseRuntimeCapabilityCatalogType =
  | Readonly<{
      identity: string;
      schema: string;
      name: string;
      kind: "composite";
      owner: string;
    }>
  | Readonly<{
      identity: string;
      schema: string;
      name: string;
      kind: "enum";
      owner: string;
      values: readonly string[];
    }>;

export interface DatabaseRuntimeCapabilityCatalogRoutine {
  readonly identity: string;
  readonly schema: string;
  readonly signature: string;
  readonly kind: "function";
  readonly owner: string;
}

export interface DatabaseRuntimeCapabilityCatalogInventory {
  readonly databases: readonly DatabaseRuntimeCapabilityCatalogDatabase[];
  readonly schemas: readonly DatabaseRuntimeCapabilityCatalogSchema[];
  readonly tables: readonly DatabaseRuntimeCapabilityCatalogTable[];
  readonly sequences: readonly DatabaseRuntimeCapabilityCatalogSequence[];
  readonly types: readonly DatabaseRuntimeCapabilityCatalogType[];
  readonly routines: readonly DatabaseRuntimeCapabilityCatalogRoutine[];
}

export interface DatabaseRuntimeCapabilityCatalogRole {
  readonly identity: string;
  readonly name: string;
  readonly login: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly inherit: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly connectionLimit: number;
  readonly validUntil: string;
  readonly settings: readonly string[];
  readonly credential: "none" | "scram-managed";
}

export interface DatabaseRuntimeCapabilityCatalogMembership {
  readonly identity: string;
  readonly role: string;
  readonly member: string;
  readonly grantor: DatabaseRuntimeCapabilityPrincipal;
  readonly adminOption: boolean;
  readonly inheritOption: boolean;
  readonly setOption: boolean;
}

interface DatabaseRuntimeCapabilityCatalogGrantBase {
  readonly object: string;
  readonly grantor: string;
  readonly grantee: string;
  readonly grantable: boolean;
}

export type DatabaseRuntimeCapabilityCatalogGrant =
  DatabaseRuntimeCapabilityCatalogGrantBase &
    (
      | Readonly<{
          objectKind: "database";
          privilege: "CONNECT" | "CREATE" | "TEMPORARY";
        }>
      | Readonly<{
          objectKind: "schema";
          privilege: "USAGE" | "CREATE";
        }>
      | Readonly<{
          objectKind: "table";
          privilege:
            | "SELECT"
            | "INSERT"
            | "UPDATE"
            | "DELETE"
            | "TRUNCATE"
            | "REFERENCES"
            | "TRIGGER"
            | "MAINTAIN";
        }>
      | Readonly<{
          objectKind: "column";
          privilege: "SELECT" | "INSERT" | "UPDATE" | "REFERENCES";
        }>
      | Readonly<{
          objectKind: "sequence";
          privilege: "USAGE" | "SELECT" | "UPDATE";
        }>
      | Readonly<{
          objectKind: "routine";
          privilege: "EXECUTE";
        }>
      | Readonly<{
          objectKind: "type";
          privilege: "USAGE";
        }>
    );

export interface DatabaseRuntimeCapabilityCatalogDefaultAclRow {
  readonly identity: string;
  readonly creator: DatabaseRuntimeCapabilityPrincipal;
  readonly schema: string | null;
  readonly objectKind: DatabaseRuntimeCapabilityDefaultAclObjectKind;
}

interface DatabaseRuntimeCapabilityCatalogDefaultAclBase
  extends DatabaseRuntimeCapabilityCatalogDefaultAclRow {
  readonly grantor: DatabaseRuntimeCapabilityPrincipal;
  readonly grantee: DatabaseRuntimeCapabilityPrincipal;
  readonly grantable: boolean;
}

export type DatabaseRuntimeCapabilityCatalogDefaultAcl =
  DatabaseRuntimeCapabilityCatalogDefaultAclBase &
    (
      | Readonly<{
          objectKind: "table";
          privilege: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
        }>
      | Readonly<{
          objectKind: "sequence";
          privilege: "USAGE" | "SELECT" | "UPDATE";
        }>
      | Readonly<{
          objectKind: "routine";
          privilege: "EXECUTE";
        }>
      | Readonly<{
          objectKind: "type";
          privilege: "USAGE";
        }>
    );

export interface DatabaseRuntimeCapabilityCatalog {
  readonly schemaVersion: 1;
  readonly contract: string;
  readonly phase: DatabaseRuntimeCapabilityPolicyPhase;
  readonly available: boolean;
  readonly ledger: DatabaseRuntimeCapabilityLedger;
  readonly provenance: DatabaseRuntimeCapabilityProvenance;
  readonly inventory: DatabaseRuntimeCapabilityCatalogInventory;
  readonly roles: readonly DatabaseRuntimeCapabilityCatalogRole[];
  readonly memberships: readonly DatabaseRuntimeCapabilityCatalogMembership[];
  readonly grants: readonly DatabaseRuntimeCapabilityCatalogGrant[];
  readonly defaultAclRows: readonly DatabaseRuntimeCapabilityCatalogDefaultAclRow[];
  readonly defaultAcls: readonly DatabaseRuntimeCapabilityCatalogDefaultAcl[];
}

interface DatabaseRuntimeCapabilityAllowanceIdentity {
  readonly schemaVersion: 1;
  readonly allowance: "codestead-database-runtime-predecessor-0070-v1";
  readonly phase: typeof DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070;
  readonly validOnlyAtMigrationIndex: 70;
  readonly expiresAtMigrationIndex: 71;
}

export interface DatabaseRuntimeCapabilityAvailableAllowance
  extends DatabaseRuntimeCapabilityAllowanceIdentity {
  readonly available: true;
  readonly reason: null;
  readonly roles: readonly DatabaseRuntimeCapabilityRole[];
  readonly memberships: readonly DatabaseRuntimeCapabilityMembership[];
  readonly grants: readonly DatabaseRuntimeCapabilityGrant[];
  readonly defaultAcls: readonly DatabaseRuntimeCapabilityDefaultAcl[];
  readonly defaultAclRows: readonly DatabaseRuntimeCapabilityDefaultAclRow[];
}

export interface DatabaseRuntimeCapabilityUnavailableAllowance
  extends DatabaseRuntimeCapabilityAllowanceIdentity {
  readonly available: false;
  readonly reason: string;
  readonly roles: readonly [];
  readonly memberships: readonly [];
  readonly grants: readonly [];
  readonly defaultAcls: readonly [];
  readonly defaultAclRows: readonly [];
}

export type DatabaseRuntimeCapabilityAllowance =
  | DatabaseRuntimeCapabilityAvailableAllowance
  | DatabaseRuntimeCapabilityUnavailableAllowance;

export type DatabaseRuntimeCapabilityAuthorityCollection =
  | "roles"
  | "memberships"
  | "grants"
  | "defaultAcls"
  | "defaultAclRows";

export type DatabaseRuntimeCapabilityAuthorityEntry =
  | DatabaseRuntimeCapabilityRole
  | DatabaseRuntimeCapabilityMembership
  | DatabaseRuntimeCapabilityGrant
  | DatabaseRuntimeCapabilityDefaultAcl
  | DatabaseRuntimeCapabilityDefaultAclRow;

export type DatabaseRuntimeCapabilityCatalogAuthorityEntry =
  | DatabaseRuntimeCapabilityCatalogRole
  | DatabaseRuntimeCapabilityCatalogMembership
  | DatabaseRuntimeCapabilityCatalogGrant
  | DatabaseRuntimeCapabilityCatalogDefaultAcl
  | DatabaseRuntimeCapabilityCatalogDefaultAclRow;

export interface DatabaseRuntimeCapabilityAuthorityCollections {
  readonly roles: readonly DatabaseRuntimeCapabilityRole[];
  readonly memberships: readonly DatabaseRuntimeCapabilityMembership[];
  readonly grants: readonly DatabaseRuntimeCapabilityGrant[];
  readonly defaultAcls: readonly DatabaseRuntimeCapabilityDefaultAcl[];
  readonly defaultAclRows: readonly DatabaseRuntimeCapabilityDefaultAclRow[];
}

export interface DatabaseRuntimeCapabilityCatalogAuthorityCollections {
  readonly roles: readonly DatabaseRuntimeCapabilityCatalogRole[];
  readonly memberships: readonly DatabaseRuntimeCapabilityCatalogMembership[];
  readonly grants: readonly DatabaseRuntimeCapabilityCatalogGrant[];
  readonly defaultAcls: readonly DatabaseRuntimeCapabilityCatalogDefaultAcl[];
  readonly defaultAclRows: readonly DatabaseRuntimeCapabilityCatalogDefaultAclRow[];
}

export interface DatabaseRuntimeCapabilityPolicyCollectionMap {
  readonly roles: DatabaseRuntimeCapabilityRole;
  readonly memberships: DatabaseRuntimeCapabilityMembership;
  readonly grants: DatabaseRuntimeCapabilityGrant;
  readonly defaultAcls: DatabaseRuntimeCapabilityDefaultAcl;
  readonly defaultAclRows: DatabaseRuntimeCapabilityDefaultAclRow;
}

export interface DatabaseRuntimeCapabilityCatalogCollectionMap {
  readonly roles: DatabaseRuntimeCapabilityCatalogRole;
  readonly memberships: DatabaseRuntimeCapabilityCatalogMembership;
  readonly grants: DatabaseRuntimeCapabilityCatalogGrant;
  readonly defaultAcls: DatabaseRuntimeCapabilityCatalogDefaultAcl;
  readonly defaultAclRows: DatabaseRuntimeCapabilityCatalogDefaultAclRow;
}

export interface DatabaseRuntimeCapabilityInventoryDelta {
  readonly databases: readonly DatabaseRuntimeCapabilityDatabase[];
  readonly schemas: readonly DatabaseRuntimeCapabilitySchema[];
  readonly tables: readonly DatabaseRuntimeCapabilityTable[];
  readonly columns: readonly DatabaseRuntimeCapabilityColumn[];
  readonly sequences: readonly DatabaseRuntimeCapabilitySequence[];
  readonly types: readonly DatabaseRuntimeCapabilityType[];
  readonly routines: readonly DatabaseRuntimeCapabilityRoutine[];
}

export interface DatabaseRuntimeCapabilityCatalogInventoryDelta {
  readonly databases: readonly DatabaseRuntimeCapabilityCatalogDatabase[];
  readonly schemas: readonly DatabaseRuntimeCapabilityCatalogSchema[];
  readonly tables: readonly DatabaseRuntimeCapabilityCatalogTable[];
  readonly columns: readonly DatabaseRuntimeCapabilityCatalogColumn[];
  readonly sequences: readonly DatabaseRuntimeCapabilityCatalogSequence[];
  readonly types: readonly DatabaseRuntimeCapabilityCatalogType[];
  readonly routines: readonly DatabaseRuntimeCapabilityCatalogRoutine[];
}

export interface DatabaseRuntimeCapabilityPair<Expected, Observed = Expected> {
  readonly identity: string;
  readonly expected: Expected;
  readonly observed: Observed;
}

export interface DatabaseRuntimeCapabilityInventoryMismatch {
  readonly databases: readonly DatabaseRuntimeCapabilityPair<
    DatabaseRuntimeCapabilityDatabase,
    DatabaseRuntimeCapabilityCatalogDatabase
  >[];
  readonly schemas: readonly DatabaseRuntimeCapabilityPair<
    DatabaseRuntimeCapabilitySchema,
    DatabaseRuntimeCapabilityCatalogSchema
  >[];
  readonly tables: readonly DatabaseRuntimeCapabilityPair<
    DatabaseRuntimeCapabilityTable,
    DatabaseRuntimeCapabilityCatalogTable
  >[];
  readonly columns: readonly DatabaseRuntimeCapabilityPair<
    DatabaseRuntimeCapabilityColumn,
    DatabaseRuntimeCapabilityCatalogColumn
  >[];
  readonly sequences: readonly DatabaseRuntimeCapabilityPair<
    DatabaseRuntimeCapabilitySequence,
    DatabaseRuntimeCapabilityCatalogSequence
  >[];
  readonly types: readonly DatabaseRuntimeCapabilityPair<
    DatabaseRuntimeCapabilityType,
    DatabaseRuntimeCapabilityCatalogType
  >[];
  readonly routines: readonly DatabaseRuntimeCapabilityPair<
    DatabaseRuntimeCapabilityRoutine,
    DatabaseRuntimeCapabilityCatalogRoutine
  >[];
}

export interface DatabaseRuntimeCapabilityDiff {
  readonly matches: boolean;
  readonly missing: Readonly<
    DatabaseRuntimeCapabilityAuthorityCollections & {
      inventory: DatabaseRuntimeCapabilityInventoryDelta;
    }
  >;
  readonly extra: Readonly<
    DatabaseRuntimeCapabilityCatalogAuthorityCollections & {
      inventory: DatabaseRuntimeCapabilityCatalogInventoryDelta;
    }
  >;
  readonly mismatched: Readonly<{
    owners: readonly DatabaseRuntimeCapabilityPair<
      | DatabaseRuntimeCapabilityDatabase
      | DatabaseRuntimeCapabilitySchema
      | DatabaseRuntimeCapabilityTable
      | DatabaseRuntimeCapabilitySequence
      | DatabaseRuntimeCapabilityType
      | DatabaseRuntimeCapabilityRoutine,
      | DatabaseRuntimeCapabilityCatalogDatabase
      | DatabaseRuntimeCapabilityCatalogSchema
      | DatabaseRuntimeCapabilityCatalogTable
      | DatabaseRuntimeCapabilityCatalogSequence
      | DatabaseRuntimeCapabilityCatalogType
      | DatabaseRuntimeCapabilityCatalogRoutine
    >[];
    inventory: DatabaseRuntimeCapabilityInventoryMismatch;
    roles: readonly DatabaseRuntimeCapabilityPair<
      DatabaseRuntimeCapabilityRole,
      DatabaseRuntimeCapabilityCatalogRole
    >[];
    memberships: readonly DatabaseRuntimeCapabilityPair<
      DatabaseRuntimeCapabilityMembership,
      DatabaseRuntimeCapabilityCatalogMembership
    >[];
    defaultAclRows: readonly DatabaseRuntimeCapabilityPair<
      DatabaseRuntimeCapabilityDefaultAclRow,
      DatabaseRuntimeCapabilityCatalogDefaultAclRow
    >[];
  }>;
}

export interface DatabaseRuntimeCapabilityClassifiedDelta<Expected, Observed> {
  readonly grant: readonly Expected[];
  readonly revoke: readonly Observed[];
  readonly reportOnly: readonly Observed[];
  readonly forbidden: readonly Observed[];
}

export type DatabaseRuntimeCapabilityMutation =
  | Readonly<{
      action: "add";
      collection: "roles";
      value: DatabaseRuntimeCapabilityRole;
      identity?: never;
    }>
  | Readonly<{
      action: "remove";
      collection: "roles";
      value: DatabaseRuntimeCapabilityCatalogRole;
      identity?: never;
    }>
  | Readonly<{
      action: "replace";
      collection: "roles";
      identity: string;
      value: DatabaseRuntimeCapabilityRole;
    }>
  | Readonly<{
      action: "add";
      collection: "memberships";
      value: DatabaseRuntimeCapabilityMembership;
      identity?: never;
    }>
  | Readonly<{
      action: "remove";
      collection: "memberships";
      value: DatabaseRuntimeCapabilityCatalogMembership;
      identity?: never;
    }>
  | Readonly<{
      action: "replace";
      collection: "memberships";
      identity: string;
      value: DatabaseRuntimeCapabilityMembership;
    }>
  | Readonly<{
      action: "add";
      collection: "grants";
      value: DatabaseRuntimeCapabilityGrant;
      identity?: never;
    }>
  | Readonly<{
      action: "remove";
      collection: "grants";
      value: DatabaseRuntimeCapabilityCatalogGrant;
      identity?: never;
    }>
  | Readonly<{
      action: "ensure";
      collection: "defaultAclRows";
      identity: string;
      value: DatabaseRuntimeCapabilityDefaultAclRow;
    }>
  | Readonly<{
      action: "add";
      collection: "defaultAcls";
      value: DatabaseRuntimeCapabilityDefaultAcl;
      identity?: never;
    }>
  | Readonly<{
      action: "remove";
      collection: "defaultAcls";
      value: DatabaseRuntimeCapabilityCatalogDefaultAcl;
      identity?: never;
    }>;

export interface DatabaseRuntimeCapabilityReconciliationPlan {
  readonly blocked: boolean;
  readonly mutations: readonly DatabaseRuntimeCapabilityMutation[];
  readonly reports: Readonly<{
    predecessor: DatabaseRuntimeCapabilityCatalogAuthorityCollections;
    forbidden: DatabaseRuntimeCapabilityCatalogAuthorityCollections;
  }>;
  readonly drift: DatabaseRuntimeCapabilityDiff;
  readonly policyFingerprint: string;
}

export interface DatabaseRuntimeCapabilityLedgerIdentity {
  readonly journalPresent: boolean;
  readonly appliedCount: number;
  readonly reviewedLedgerSha256: string;
}

export type DatabaseRuntimeCapabilityResolution =
  | Readonly<{
      phase: typeof DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION;
      policy: null;
      reconcileApplicationAcls: false;
      ledgerIdentity: DatabaseRuntimeCapabilityLedgerIdentity;
    }>
  | Readonly<{
      phase: typeof DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069;
      policy: DatabaseRuntimeCapabilityCurrentManifest;
      reconcileApplicationAcls: true;
      ledgerIdentity: DatabaseRuntimeCapabilityLedgerIdentity;
    }>;

export const CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES: Readonly<DatabaseRuntimeCapabilityCurrentManifest>;

export const POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES: Readonly<DatabaseRuntimeCapabilityPostContractManifest>;

export const PREDECESSOR_0070_DATABASE_RUNTIME_CAPABILITY_ALLOWANCE: Readonly<DatabaseRuntimeCapabilityUnavailableAllowance>;

export function canonicalizeDatabaseRuntimeCapabilities(
  value: unknown,
): DatabaseRuntimeCapabilityJsonValue;

export function canonicalDatabaseRuntimeCapabilitiesJson(
  value: unknown,
): string;

export function fingerprintDatabaseRuntimeCapabilities(
  value: unknown,
): string;

export function validateDatabaseRuntimeCapabilities<T>(
  value: T,
): T & DatabaseRuntimeCapabilityManifest;

export function diffDatabaseRuntimeCapabilities(
  expected: DatabaseRuntimeCapabilityManifest,
  observed: DatabaseRuntimeCapabilityCatalog,
): DatabaseRuntimeCapabilityDiff;

export function validateDatabaseRuntimeCapabilityAllowance<T>(
  value: T,
  pairedPolicy?: DatabaseRuntimeCapabilityManifest | null,
): T & DatabaseRuntimeCapabilityAllowance;

export function classifyDatabaseRuntimeCapabilityPredecessorDelta<
  Collection extends DatabaseRuntimeCapabilityAuthorityCollection,
  Expected extends DatabaseRuntimeCapabilityPolicyCollectionMap[Collection],
  Observed extends DatabaseRuntimeCapabilityCatalogCollectionMap[Collection],
>(options: Readonly<{
  phase: DatabaseRuntimeCapabilityReconciliationPhase;
  collection: Collection;
  expected: readonly Expected[];
  observed: readonly Observed[];
  allowance?: DatabaseRuntimeCapabilityAllowance | null;
}>): DatabaseRuntimeCapabilityClassifiedDelta<Expected, Observed>;

export function classifyDatabaseRuntimeCapabilityGrantDelta<
  Expected extends DatabaseRuntimeCapabilityGrant,
  Observed extends DatabaseRuntimeCapabilityCatalogGrant,
>(
  options: Readonly<{
    phase: DatabaseRuntimeCapabilityReconciliationPhase;
    expectedGrants: readonly Expected[];
    observedGrants: readonly Observed[];
    allowance?: DatabaseRuntimeCapabilityAllowance | null;
  }>,
): DatabaseRuntimeCapabilityClassifiedDelta<Expected, Observed>;

export function planDatabaseRuntimeCapabilityReconciliation(
  options: Readonly<{
    phase: DatabaseRuntimeCapabilityReconciliationPhase;
    policy: DatabaseRuntimeCapabilityManifest;
    catalog: DatabaseRuntimeCapabilityCatalog;
    allowance?: DatabaseRuntimeCapabilityAllowance | null;
  }>,
): DatabaseRuntimeCapabilityReconciliationPlan;

export function resolveDatabaseRuntimeCapabilityPhase(
  options: Readonly<{
    journalPresent: boolean;
    reviewedMigrationTail: string | null;
    reviewedPrefixExact: boolean;
    reviewedMigrationCount: number;
    reviewedMigrationLedgerSha256: string;
    requestedPhase?: DatabaseRuntimeCapabilityPhase;
  }>,
): DatabaseRuntimeCapabilityResolution;
