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

export type AccountMailAuthoritySnapshot = Readonly<{
  role: string | null;
  status: string;
  banned: boolean | null;
  emailVerified: boolean;
}>;

type AccountState = Readonly<{
  status: "pending" | "active" | "suspended" | "deletion_pending" | "deleted";
  emailVerified: boolean;
}>;

export type AccountMailAuthorityPolicy = Readonly<{
  roles: readonly ("admin" | "learner")[];
  banned: readonly boolean[];
  states: readonly AccountState[];
}>;

type AccountTemplateAuthorityPolicy = Readonly<{
  scope: "account";
  versions: readonly string[];
  account: AccountMailAuthorityPolicy;
}>;

type SystemTemplateAuthorityPolicy = Readonly<{
  scope: "system";
  versions: readonly string[];
  producer:
    | "access-request-admin"
    | "access-request-approved"
    | "access-request-rejected";
  account: AccountMailAuthorityPolicy | null;
}>;

type DeletionTemplateAuthorityPolicy = Readonly<{
  scope: "deletion-capability";
  versions: readonly string[];
  capability: "account-deletion-notice-v1";
  account: AccountMailAuthorityPolicy;
}>;

export type EmailTemplateAuthorityPolicy =
  | AccountTemplateAuthorityPolicy
  | SystemTemplateAuthorityPolicy
  | DeletionTemplateAuthorityPolicy;

function accountPolicy(
  roles: AccountMailAuthorityPolicy["roles"],
  banned: AccountMailAuthorityPolicy["banned"],
  states: AccountMailAuthorityPolicy["states"],
): AccountMailAuthorityPolicy {
  return Object.freeze({
    roles: Object.freeze([...roles]),
    banned: Object.freeze([...banned]),
    states: Object.freeze(states.map((state) => Object.freeze({ ...state }))),
  });
}

const ACTIVE_LEARNER = accountPolicy(
  ["learner"],
  [false],
  [{ status: "active", emailVerified: true }],
);
const ACTIVE_ADMIN = accountPolicy(
  ["admin"],
  [false],
  [{ status: "active", emailVerified: true }],
);
const ACTIVE_ACCOUNT = accountPolicy(
  ["admin", "learner"],
  [false],
  [{ status: "active", emailVerified: true }],
);
const PENDING_UNVERIFIED_LEARNER = accountPolicy(
  ["learner"],
  [false],
  [{ status: "pending", emailVerified: false }],
);
const PASSWORD_RESET_ACCOUNT = accountPolicy(
  ["admin", "learner"],
  [false],
  [
    { status: "pending", emailVerified: false },
    { status: "pending", emailVerified: true },
    { status: "active", emailVerified: true },
  ],
);
const DELETED_LEARNER = accountPolicy(
  ["learner"],
  [false, true],
  [
    { status: "deleted", emailVerified: false },
    { status: "deleted", emailVerified: true },
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
    account: ACTIVE_ACCOUNT,
  },
  "session-revocation-requested": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_ADMIN,
  },
  "session-revocation-updated": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_ACCOUNT,
  },
  "session-revoked": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_ACCOUNT,
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
    account: ACTIVE_LEARNER,
  },
  "credential-revealed": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
  },
  "fallback-grant-changed": {
    scope: "account",
    versions: VERSION_1,
    account: ACTIVE_LEARNER,
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

export type ResolvedEmailTemplateAuthorityPolicy = Readonly<{
  template: EmailTemplate;
  templateVersion: string;
  policy: EmailTemplateAuthorityPolicy;
}>;

export type AccountMailAuthorityDecision =
  | Readonly<{ kind: "allowed" }>
  | Readonly<{
      kind: "denied";
      code:
        | "UNKNOWN_TEMPLATE"
        | "TEMPLATE_VERSION_NOT_ALLOWED"
        | "ACCOUNT_AUTHORITY_NOT_APPLICABLE"
        | "ACCOUNT_ROLE_NOT_ALLOWED"
        | "ACCOUNT_STATUS_NOT_ALLOWED"
        | "ACCOUNT_BANNED"
        | "ACCOUNT_EMAIL_VERIFICATION_NOT_ALLOWED";
    }>;

function isEmailTemplate(value: string): value is EmailTemplate {
  return Object.hasOwn(TEMPLATE_AUTHORITY_POLICIES, value);
}

export function resolveEmailTemplateAuthorityPolicy(
  template: string,
  templateVersion: string,
): ResolvedEmailTemplateAuthorityPolicy | null {
  if (!isEmailTemplate(template)) return null;
  const policy = TEMPLATE_AUTHORITY_POLICIES[template];
  if (!policy.versions.some((version) => version === templateVersion)) return null;
  return { template, templateVersion, policy };
}

export function evaluateAccountMailAuthority(input: Readonly<{
  template: string;
  templateVersion: string;
  account: AccountMailAuthoritySnapshot;
}>): AccountMailAuthorityDecision {
  if (!isEmailTemplate(input.template)) {
    return { kind: "denied", code: "UNKNOWN_TEMPLATE" };
  }
  const policy = TEMPLATE_AUTHORITY_POLICIES[input.template];
  if (!policy.versions.some((version) => version === input.templateVersion)) {
    return { kind: "denied", code: "TEMPLATE_VERSION_NOT_ALLOWED" };
  }
  if (policy.account === null) {
    return { kind: "denied", code: "ACCOUNT_AUTHORITY_NOT_APPLICABLE" };
  }
  if (!policy.account.roles.some((role) => role === input.account.role)) {
    return { kind: "denied", code: "ACCOUNT_ROLE_NOT_ALLOWED" };
  }
  if (!policy.account.banned.some((banned) => banned === input.account.banned)) {
    return { kind: "denied", code: "ACCOUNT_BANNED" };
  }
  const statusStates = policy.account.states.filter(
    (state) => state.status === input.account.status,
  );
  if (statusStates.length === 0) {
    return { kind: "denied", code: "ACCOUNT_STATUS_NOT_ALLOWED" };
  }
  if (!statusStates.some(
    (state) => state.emailVerified === input.account.emailVerified,
  )) {
    return {
      kind: "denied",
      code: "ACCOUNT_EMAIL_VERIFICATION_NOT_ALLOWED",
    };
  }
  return { kind: "allowed" };
}
