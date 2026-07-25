const PRODUCTION_EMAIL_TEMPLATE_DEFINITIONS = Object.freeze([
  "verify-email",
  "reset-password",
  "invitation",
  "access-request-admin",
  "lost-device-proof",
  "access-rejected",
  "learning-request-updated",
  "new-device",
  "session-revocation-requested",
  "session-revocation-updated",
  "session-revoked",
  "account-deleted",
  "credential-changed",
  "credential-revealed",
  "fallback-grant-changed",
  "learning-plan-changed",
  "storage-quota-changed",
  "inactivity-reminder",
  "inactivity-reminder-followup",
  "inactivity-admin-notice",
  "daily-study-reminder",
  "revision-reminder",
  "goal-reminder",
  "challenge-reminder",
  "mastery-awarded",
  "appeal-updated",
  "assessment-corrected",
  "weekly-summary",
  "backup-status",
] as const);

export type EmailTemplate =
  (typeof PRODUCTION_EMAIL_TEMPLATE_DEFINITIONS)[number];

export const SPECIALIZED_ACCOUNT_EMAIL_TEMPLATES = Object.freeze([
  "inactivity-reminder",
  "inactivity-reminder-followup",
  "inactivity-admin-notice",
] as const);

export type SpecializedAccountEmailTemplate =
  (typeof SPECIALIZED_ACCOUNT_EMAIL_TEMPLATES)[number];

export type AccountMailAuthoritySnapshot = Readonly<{
  role: string | null;
  status: string;
  banned: boolean | null;
  emailVerified: boolean;
}>;

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

type AccountState = Readonly<{
  role: "admin" | "learner";
  status: "pending" | "active" | "suspended" | "deletion_pending" | "deleted";
  emailVerified: boolean;
}>;

export type AccountMailAuthorityPolicy = Readonly<{
  banned: NonEmptyReadonlyArray<boolean>;
  states: NonEmptyReadonlyArray<AccountState>;
}>;

export type SystemEmailProducer =
  | "access-request-admin"
  | "access-request-approved"
  | "access-request-rejected";

export type AccountDeletionNoticeCapability = "account-deletion-notice-v1";

type AccountTemplateAuthorityPolicy = Readonly<{
  scope: "account";
  versions: NonEmptyReadonlyArray<string>;
  account: AccountMailAuthorityPolicy;
}>;

type SystemTemplateAuthorityPolicy = Readonly<{
  scope: "system";
  versions: NonEmptyReadonlyArray<string>;
  producer: SystemEmailProducer;
  account: AccountMailAuthorityPolicy | null;
}>;

type DeletionTemplateAuthorityPolicy = Readonly<{
  scope: "deletion-capability";
  versions: NonEmptyReadonlyArray<string>;
  capability: AccountDeletionNoticeCapability;
  account: AccountMailAuthorityPolicy;
}>;

export type EmailTemplateAuthorityPolicy =
  | AccountTemplateAuthorityPolicy
  | SystemTemplateAuthorityPolicy
  | DeletionTemplateAuthorityPolicy;

function frozenNonEmpty<T>(
  values: T[],
  emptyMessage: string,
): NonEmptyReadonlyArray<T> {
  if (values.length === 0) throw new Error(emptyMessage);
  return Object.freeze(values) as NonEmptyReadonlyArray<T>;
}

function accountPolicy(
  banned: AccountMailAuthorityPolicy["banned"],
  states: AccountMailAuthorityPolicy["states"],
): AccountMailAuthorityPolicy {
  return Object.freeze({
    banned: frozenNonEmpty([...banned], "Account policy requires banned authority."),
    states: frozenNonEmpty(
      states.map((state) => Object.freeze({ ...state })),
      "Account policy requires state authority.",
    ),
  });
}

const ACTIVE_LEARNER = accountPolicy(
  [false],
  [{ role: "learner", status: "active", emailVerified: true }],
);
const ACTIVE_ADMIN = accountPolicy(
  [false],
  [{ role: "admin", status: "active", emailVerified: true }],
);
const NEW_DEVICE_ACCOUNT = accountPolicy(
  [false],
  [
    { role: "admin", status: "active", emailVerified: true },
    { role: "learner", status: "pending", emailVerified: true },
    { role: "learner", status: "active", emailVerified: true },
  ],
);
const PENDING_OR_ACTIVE_VERIFIED_LEARNER = accountPolicy(
  [false],
  [
    { role: "learner", status: "pending", emailVerified: true },
    { role: "learner", status: "active", emailVerified: true },
  ],
);
const PENDING_UNVERIFIED_LEARNER = accountPolicy(
  [false],
  [{ role: "learner", status: "pending", emailVerified: false }],
);
const PASSWORD_RESET_ACCOUNT = accountPolicy(
  [false],
  [
    { role: "learner", status: "pending", emailVerified: false },
    { role: "learner", status: "pending", emailVerified: true },
    { role: "learner", status: "active", emailVerified: true },
    { role: "admin", status: "active", emailVerified: true },
  ],
);
const DELETED_LEARNER = accountPolicy(
  [false, true],
  [
    { role: "learner", status: "deleted", emailVerified: false },
    { role: "learner", status: "deleted", emailVerified: true },
  ],
);

const VERSION_1 = Object.freeze(["1"] as const);
const VERSION_2 = Object.freeze(["2"] as const);

const TEMPLATE_AUTHORITY_POLICY_DEFINITIONS = {
  "verify-email": {
    scope: "account",
    versions: VERSION_1,
    account: PENDING_UNVERIFIED_LEARNER,
  },
  "reset-password": {
    scope: "account",
    versions: VERSION_1,
    account: PASSWORD_RESET_ACCOUNT,
  },
  invitation: {
    scope: "system",
    versions: VERSION_1,
    producer: "access-request-approved",
    account: null,
  },
  "access-request-admin": {
    scope: "system",
    versions: VERSION_1,
    producer: "access-request-admin",
    account: ACTIVE_ADMIN,
  },
  "lost-device-proof": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "access-rejected": {
    scope: "system",
    versions: VERSION_1,
    producer: "access-request-rejected",
    account: null,
  },
  "learning-request-updated": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "new-device": {
    scope: "account",
    versions: VERSION_1,
    account: NEW_DEVICE_ACCOUNT,
  },
  "session-revocation-requested": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_ADMIN,
  },
  "session-revocation-updated": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "session-revoked": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "account-deleted": {
    scope: "deletion-capability",
    versions: VERSION_1,
    capability: "account-deletion-notice-v1",
    account: DELETED_LEARNER,
  },
  "credential-changed": {
    scope: "account",
    versions: VERSION_1,
    account: PENDING_OR_ACTIVE_VERIFIED_LEARNER,
  },
  "credential-revealed": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "fallback-grant-changed": {
    scope: "account",
    versions: VERSION_1,
    account: PENDING_OR_ACTIVE_VERIFIED_LEARNER,
  },
  "learning-plan-changed": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "storage-quota-changed": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "inactivity-reminder": {
    scope: "account",
    versions: VERSION_2,
    account: ACTIVE_LEARNER,
  },
  "inactivity-reminder-followup": {
    scope: "account",
    versions: VERSION_2,
    account: ACTIVE_LEARNER,
  },
  "inactivity-admin-notice": {
    scope: "account",
    versions: VERSION_2,
    account: ACTIVE_ADMIN,
  },
  "daily-study-reminder": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "revision-reminder": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "goal-reminder": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "challenge-reminder": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "mastery-awarded": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "appeal-updated": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "assessment-corrected": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "weekly-summary": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "backup-status": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_ADMIN,
  },
} as const satisfies Readonly<
  Record<EmailTemplate, EmailTemplateAuthorityPolicy>
>;

export type TemplateAuthorityRegistryInput = Readonly<{
  productionTemplates: readonly unknown[];
  policies: unknown;
}>;

export type TemplateAuthorityRegistry = Readonly<{
  productionTemplates: NonEmptyReadonlyArray<string>;
  policies: Readonly<Record<string, EmailTemplateAuthorityPolicy>>;
}>;

const ACCOUNT_ROLES = Object.freeze(["admin", "learner"] as const);
const ACCOUNT_STATUSES = Object.freeze([
  "pending",
  "active",
  "suspended",
  "deletion_pending",
  "deleted",
] as const);
const SYSTEM_EMAIL_PRODUCERS = Object.freeze([
  "access-request-admin",
  "access-request-approved",
  "access-request-rejected",
] as const);
const ACCOUNT_DELETION_NOTICE_CAPABILITIES = Object.freeze([
  "account-deletion-notice-v1",
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValue<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string"
    && values.some((candidate) => candidate === value);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  label: string,
) {
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length === 0 && unexpected.length === 0) return;
  const details = [
    missing.length > 0 ? `missing ${missing.join(", ")}` : "",
    unexpected.length > 0 ? `unexpected ${unexpected.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  throw new Error(`${label} has an inconsistent shape: ${details}.`);
}

function parseVersions(
  value: unknown,
  template: string,
): NonEmptyReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new Error(`Template ${template} versions must be an array.`);
  }
  const versions = value.map((version, index) => {
    if (typeof version !== "string" || !version.trim()) {
      throw new Error(
        `Template ${template} version at index ${index} must be a non-empty string.`,
      );
    }
    if (version !== version.trim()) {
      throw new Error(`Template ${template} version must not contain outer whitespace.`);
    }
    return version;
  });
  if (versions.length === 0) {
    throw new Error(
      `Template ${template} version authority must allow at least one version.`,
    );
  }
  if (new Set(versions).size !== versions.length) {
    throw new Error(`Duplicate template version in ${template}.`);
  }
  return Object.freeze(versions) as NonEmptyReadonlyArray<string>;
}

function parseAccountState(
  value: unknown,
  template: string,
  index: number,
): AccountState {
  const label = `Template ${template} account state ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(value, ["role", "status", "emailVerified"], label);
  if (!hasValue(ACCOUNT_ROLES, value.role)) {
    throw new Error(`${label} role is invalid.`);
  }
  if (!hasValue(ACCOUNT_STATUSES, value.status)) {
    throw new Error(`${label} status is invalid.`);
  }
  if (typeof value.emailVerified !== "boolean") {
    throw new Error(`${label} emailVerified must be boolean.`);
  }
  return Object.freeze({
    role: value.role,
    status: value.status,
    emailVerified: value.emailVerified,
  });
}

function parseAccountPolicy(
  value: unknown,
  template: string,
): AccountMailAuthorityPolicy {
  const label = `Template ${template} account policy`;
  if (!isRecord(value)) {
    throw new Error(`${label} must be a non-null object.`);
  }
  assertExactKeys(value, ["banned", "states"], label);
  if (!Array.isArray(value.banned)) {
    throw new Error(`${label} banned authority must be an array.`);
  }
  const banned = value.banned.map((candidate, index) => {
    if (typeof candidate !== "boolean") {
      throw new Error(
        `${label} banned value ${index} must be boolean.`,
      );
    }
    return candidate;
  });
  if (banned.length === 0) {
    throw new Error(`${label} banned authority must allow at least one value.`);
  }
  if (new Set(banned).size !== banned.length) {
    throw new Error(`Duplicate banned tuple in ${label}.`);
  }
  if (!Array.isArray(value.states)) {
    throw new Error(`${label} states must be an array.`);
  }
  const states = value.states.map((state, index) =>
    parseAccountState(state, template, index)
  );
  if (states.length === 0) {
    throw new Error(`${label} state authority must allow at least one state.`);
  }
  const stateTuples = states.map((state) =>
    `${state.role}\u0000${state.status}\u0000${state.emailVerified}`
  );
  if (new Set(stateTuples).size !== stateTuples.length) {
    throw new Error(`Duplicate account state tuple in ${label}.`);
  }
  return Object.freeze({
    banned: frozenNonEmpty(
      banned,
      `${label} banned authority must allow at least one value.`,
    ),
    states: frozenNonEmpty(
      states,
      `${label} state authority must allow at least one state.`,
    ),
  });
}

function parseTemplatePolicy(
  value: unknown,
  template: string,
): EmailTemplateAuthorityPolicy {
  const label = `Template policy ${template}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const versions = parseVersions(value.versions, template);
  if (value.scope === "account") {
    assertExactKeys(value, ["scope", "versions", "account"], label);
    if (value.account === null) {
      throw new Error(`Template ${template} requires an account policy.`);
    }
    return Object.freeze({
      scope: "account",
      versions,
      account: parseAccountPolicy(value.account, template),
    });
  }
  if (value.scope === "system") {
    assertExactKeys(
      value,
      ["scope", "versions", "producer", "account"],
      label,
    );
    if (!hasValue(SYSTEM_EMAIL_PRODUCERS, value.producer)) {
      throw new Error(`Template ${template} system producer is invalid.`);
    }
    return Object.freeze({
      scope: "system",
      versions,
      producer: value.producer,
      account: value.account === null
        ? null
        : parseAccountPolicy(value.account, template),
    });
  }
  if (value.scope === "deletion-capability") {
    assertExactKeys(
      value,
      ["scope", "versions", "capability", "account"],
      label,
    );
    if (!hasValue(
      ACCOUNT_DELETION_NOTICE_CAPABILITIES,
      value.capability,
    )) {
      throw new Error(`Template ${template} deletion capability is invalid.`);
    }
    if (value.account === null) {
      throw new Error(`Template ${template} requires an account policy.`);
    }
    return Object.freeze({
      scope: "deletion-capability",
      versions,
      capability: value.capability,
      account: parseAccountPolicy(value.account, template),
    });
  }
  throw new Error(`Template ${template} authority scope is invalid.`);
}

export function createTemplateAuthorityRegistry(
  input: TemplateAuthorityRegistryInput,
): TemplateAuthorityRegistry {
  if (!Array.isArray(input.productionTemplates)) {
    throw new Error("Production email templates must be an array.");
  }
  const productionTemplates = input.productionTemplates.map((template, index) => {
    if (typeof template !== "string" || !template.trim()) {
      throw new Error(
        `Production email template at index ${index} must be a non-empty string.`,
      );
    }
    if (template !== template.trim()) {
      throw new Error(
        "Production email templates must not contain outer whitespace.",
      );
    }
    return template;
  });
  if (productionTemplates.length === 0) {
    throw new Error("At least one production email template is required.");
  }
  if (new Set(productionTemplates).size !== productionTemplates.length) {
    throw new Error("Duplicate production email template.");
  }
  const inputPolicies = input.policies;
  if (!isRecord(inputPolicies)) {
    throw new Error("Template authority policies must be an object.");
  }

  const productionTemplateSet = new Set(productionTemplates);
  for (const template of productionTemplates) {
    if (!Object.hasOwn(inputPolicies, template)) {
      throw new Error(`Production template policy is missing for ${template}.`);
    }
  }
  for (const template of Object.keys(inputPolicies)) {
    if (!productionTemplateSet.has(template)) {
      throw new Error(
        `Template policy is not a production template: ${template}.`,
      );
    }
  }

  const systemProducers = new Set<SystemEmailProducer>();
  const deletionCapabilities = new Set<AccountDeletionNoticeCapability>();
  let accountAuthorities = 0;
  let systemAuthorities = 0;
  let deletionAuthorities = 0;
  const policyEntries = productionTemplates.map((template) => {
    const parsed = parseTemplatePolicy(inputPolicies[template], template);
    if (parsed.scope === "account") {
      accountAuthorities += 1;
    } else if (parsed.scope === "system") {
      systemAuthorities += 1;
      if (systemProducers.has(parsed.producer)) {
        throw new Error(
          `System producer ${parsed.producer} must map to exactly one template authority.`,
        );
      }
      systemProducers.add(parsed.producer);
    } else {
      deletionAuthorities += 1;
      if (deletionCapabilities.has(parsed.capability)) {
        throw new Error(
          `Deletion capability ${parsed.capability} must map to exactly one template authority.`,
        );
      }
      deletionCapabilities.add(parsed.capability);
    }
    return [template, parsed] as const;
  });

  if (accountAuthorities === 0) {
    throw new Error("At least one account template authority is required.");
  }
  if (systemAuthorities === 0) {
    throw new Error("At least one system email template authority is required.");
  }
  if (deletionAuthorities === 0) {
    throw new Error(
      "At least one deletion capability template authority is required.",
    );
  }

  const policies = Object.freeze(Object.fromEntries(policyEntries)) as
    Readonly<Record<string, EmailTemplateAuthorityPolicy>>;
  return Object.freeze({
    productionTemplates: frozenNonEmpty(
      [...productionTemplates],
      "At least one production email template is required.",
    ),
    policies,
  });
}

const TEMPLATE_AUTHORITY_REGISTRY = createTemplateAuthorityRegistry({
  productionTemplates: PRODUCTION_EMAIL_TEMPLATE_DEFINITIONS,
  policies: TEMPLATE_AUTHORITY_POLICY_DEFINITIONS,
});

export const PRODUCTION_EMAIL_TEMPLATES =
  TEMPLATE_AUTHORITY_REGISTRY.productionTemplates as readonly EmailTemplate[];

export const TEMPLATE_AUTHORITY_POLICIES =
  TEMPLATE_AUTHORITY_REGISTRY.policies as Readonly<
    Record<EmailTemplate, EmailTemplateAuthorityPolicy>
  >;

export type SystemEmailTemplateAuthority = Readonly<{
  template: EmailTemplate;
  versions: NonEmptyReadonlyArray<string>;
  producer: SystemEmailProducer;
}>;

export type DeletionCapabilityTemplateAuthority = Readonly<{
  template: EmailTemplate;
  versions: NonEmptyReadonlyArray<string>;
  capability: AccountDeletionNoticeCapability;
}>;

function nonEmptyAuthorityVersions(
  template: EmailTemplate,
  versions: readonly string[],
): NonEmptyReadonlyArray<string> {
  if (versions.length === 0) {
    throw new Error(`Template authority ${template} must allow at least one version.`);
  }
  return Object.freeze([...versions]) as NonEmptyReadonlyArray<string>;
}

function collectSystemEmailTemplateAuthorities() {
  const authorities = PRODUCTION_EMAIL_TEMPLATES.flatMap(
    (template): SystemEmailTemplateAuthority[] => {
      const policy = TEMPLATE_AUTHORITY_POLICIES[template];
      if (policy.scope !== "system") return [];
      return [{
        template,
        versions: nonEmptyAuthorityVersions(template, policy.versions),
        producer: policy.producer,
      }];
    },
  );
  if (authorities.length === 0) {
    throw new Error("At least one system email template authority is required.");
  }
  const producers = new Set(authorities.map((authority) => authority.producer));
  if (producers.size !== authorities.length) {
    throw new Error("System email producers must map to exactly one template authority.");
  }
  return Object.freeze(
    authorities.map((authority) => Object.freeze(authority)),
  );
}

function collectDeletionCapabilityTemplateAuthorities() {
  const authorities = PRODUCTION_EMAIL_TEMPLATES.flatMap(
    (template): DeletionCapabilityTemplateAuthority[] => {
      const policy = TEMPLATE_AUTHORITY_POLICIES[template];
      if (policy.scope !== "deletion-capability") return [];
      return [{
        template,
        versions: nonEmptyAuthorityVersions(template, policy.versions),
        capability: policy.capability,
      }];
    },
  );
  if (authorities.length === 0) {
    throw new Error("At least one deletion capability template authority is required.");
  }
  const capabilities = new Set(
    authorities.map((authority) => authority.capability),
  );
  if (capabilities.size !== authorities.length) {
    throw new Error(
      "Deletion capabilities must map to exactly one template authority.",
    );
  }
  return Object.freeze(
    authorities.map((authority) => Object.freeze(authority)),
  );
}

export const SYSTEM_EMAIL_TEMPLATE_AUTHORITIES =
  collectSystemEmailTemplateAuthorities();

export const DELETION_CAPABILITY_TEMPLATE_AUTHORITIES =
  collectDeletionCapabilityTemplateAuthorities();

export function requireSystemEmailTemplateAuthority(
  producer: SystemEmailProducer,
): SystemEmailTemplateAuthority {
  const matches = SYSTEM_EMAIL_TEMPLATE_AUTHORITIES.filter(
    (authority) => authority.producer === producer,
  );
  if (matches.length !== 1) {
    throw new Error(
      `System email producer ${producer} must have exactly one template authority.`,
    );
  }
  return matches[0]!;
}

export function requireDeletionCapabilityTemplateAuthority(
  capability: AccountDeletionNoticeCapability,
): DeletionCapabilityTemplateAuthority {
  const matches = DELETION_CAPABILITY_TEMPLATE_AUTHORITIES.filter(
    (authority) => authority.capability === capability,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Deletion capability ${capability} must have exactly one template authority.`,
    );
  }
  return matches[0]!;
}

export type ResolvedEmailTemplateAuthorityPolicy = Readonly<{
  template: EmailTemplate;
  templateVersion: string;
  policy: EmailTemplateAuthorityPolicy;
}>;

export type TemplateAccountSnapshotDecision =
  | Readonly<{
      kind: "account-snapshot-satisfied";
      deliveryAuthorityEstablished: false;
      remainingAuthority:
        | "account-template-source"
        | "system-source"
        | "account-deletion-capability";
    }>
  | Readonly<{
      kind: "account-snapshot-denied";
      deliveryAuthorityEstablished: false;
      code:
        | "UNKNOWN_TEMPLATE"
        | "TEMPLATE_VERSION_NOT_ALLOWED"
        | "ACCOUNT_SNAPSHOT_NOT_APPLICABLE"
        | "ACCOUNT_ROLE_NOT_ALLOWED"
        | "ACCOUNT_STATUS_NOT_ALLOWED"
        | "ACCOUNT_BANNED"
        | "ACCOUNT_EMAIL_VERIFICATION_NOT_ALLOWED";
    }>;

export function isProductionEmailTemplate(value: string): value is EmailTemplate {
  return Object.hasOwn(TEMPLATE_AUTHORITY_POLICIES, value);
}

export function isSpecializedAccountEmailTemplate(
  value: string,
): value is SpecializedAccountEmailTemplate {
  return SPECIALIZED_ACCOUNT_EMAIL_TEMPLATES.some((template) => template === value);
}

export function resolveEmailTemplateAuthorityPolicy(
  template: string,
  templateVersion: string,
): ResolvedEmailTemplateAuthorityPolicy | null {
  if (!isProductionEmailTemplate(template)) return null;
  const policy = TEMPLATE_AUTHORITY_POLICIES[template];
  if (!policy.versions.some((version) => version === templateVersion)) return null;
  return { template, templateVersion, policy };
}

function denied(
  code: Extract<TemplateAccountSnapshotDecision, { kind: "account-snapshot-denied" }>["code"],
): TemplateAccountSnapshotDecision {
  return {
    kind: "account-snapshot-denied",
    deliveryAuthorityEstablished: false,
    code,
  };
}

export function evaluateTemplateAccountSnapshot(input: Readonly<{
  template: string;
  templateVersion: string;
  account: AccountMailAuthoritySnapshot;
}>): TemplateAccountSnapshotDecision {
  if (!isProductionEmailTemplate(input.template)) {
    return denied("UNKNOWN_TEMPLATE");
  }
  const policy = TEMPLATE_AUTHORITY_POLICIES[input.template];
  if (!policy.versions.some((version) => version === input.templateVersion)) {
    return denied("TEMPLATE_VERSION_NOT_ALLOWED");
  }
  if (policy.account === null) {
    return denied("ACCOUNT_SNAPSHOT_NOT_APPLICABLE");
  }
  const roleStates = policy.account.states.filter(
    (state) => state.role === input.account.role,
  );
  if (roleStates.length === 0) {
    return denied("ACCOUNT_ROLE_NOT_ALLOWED");
  }
  if (!policy.account.banned.some((banned) => banned === input.account.banned)) {
    return denied("ACCOUNT_BANNED");
  }
  const statusStates = roleStates.filter(
    (state) => state.status === input.account.status,
  );
  if (statusStates.length === 0) {
    return denied("ACCOUNT_STATUS_NOT_ALLOWED");
  }
  if (!statusStates.some(
    (state) => state.emailVerified === input.account.emailVerified,
  )) {
    return denied("ACCOUNT_EMAIL_VERIFICATION_NOT_ALLOWED");
  }
  const remainingAuthority = policy.scope === "account"
    ? "account-template-source"
    : policy.scope === "system"
      ? "system-source"
      : "account-deletion-capability";
  return {
    kind: "account-snapshot-satisfied",
    deliveryAuthorityEstablished: false,
    remainingAuthority,
  };
}
