export const PRODUCTION_EMAIL_TEMPLATES = Object.freeze([
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

export type EmailTemplate = (typeof PRODUCTION_EMAIL_TEMPLATES)[number];

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

type AccountState = Readonly<{
  role: "admin" | "learner";
  status: "pending" | "active" | "suspended" | "deletion_pending" | "deleted";
  emailVerified: boolean;
}>;

export type AccountMailAuthorityPolicy = Readonly<{
  banned: readonly boolean[];
  states: readonly AccountState[];
}>;

export type SystemEmailProducer =
  | "access-request-admin"
  | "access-request-approved"
  | "access-request-rejected";

export type AccountDeletionNoticeCapability = "account-deletion-notice-v1";

type AccountTemplateAuthorityPolicy = Readonly<{
  scope: "account";
  versions: readonly string[];
  account: AccountMailAuthorityPolicy;
}>;

type SystemTemplateAuthorityPolicy = Readonly<{
  scope: "system";
  versions: readonly string[];
  producer: SystemEmailProducer;
  account: AccountMailAuthorityPolicy | null;
}>;

type DeletionTemplateAuthorityPolicy = Readonly<{
  scope: "deletion-capability";
  versions: readonly string[];
  capability: AccountDeletionNoticeCapability;
  account: AccountMailAuthorityPolicy;
}>;

export type EmailTemplateAuthorityPolicy =
  | AccountTemplateAuthorityPolicy
  | SystemTemplateAuthorityPolicy
  | DeletionTemplateAuthorityPolicy;

function accountPolicy(
  banned: AccountMailAuthorityPolicy["banned"],
  states: AccountMailAuthorityPolicy["states"],
): AccountMailAuthorityPolicy {
  return Object.freeze({
    banned: Object.freeze([...banned]),
    states: Object.freeze(states.map((state) => Object.freeze({ ...state }))),
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

export const TEMPLATE_AUTHORITY_POLICIES = Object.freeze({
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
>);

export type SystemEmailTemplateAuthority = Readonly<{
  template: EmailTemplate;
  versions: readonly string[];
  producer: SystemEmailProducer;
}>;

export type DeletionCapabilityTemplateAuthority = Readonly<{
  template: EmailTemplate;
  versions: readonly string[];
  capability: AccountDeletionNoticeCapability;
}>;

function nonEmptyAuthorityVersions(
  template: EmailTemplate,
  versions: readonly string[],
): readonly string[] {
  if (versions.length === 0) {
    throw new Error(`Template authority ${template} must allow at least one version.`);
  }
  return Object.freeze([...versions]);
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
