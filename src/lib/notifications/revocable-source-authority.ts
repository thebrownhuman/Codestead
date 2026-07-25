import { createHash, timingSafeEqual } from "node:crypto";

import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";

export const INACTIVITY_MAIL_POLICY_VERSION = "inactivity-2026-07.v2";
export const SMART_REMINDER_POLICY_VERSION = "smart-reminders-2026-07.v1";
export const SESSION_REVOCATION_EMAIL_DEVICE = "an approved browser profile";
export const SMART_REMINDER_WEEKLY_SUMMARY =
  "Your private, evidence-backed weekly summary is ready inside Codestead.";

export const REVOCABLE_SOURCE_LOCK_ORDER = Object.freeze([
  "email_outbox",
  "user:ascending-id",
  "verification",
  "lost_device_proof",
  "session",
  "session_revocation_request",
  "inactivity_episode",
  "consent_record",
  "notification_preference",
  "smart_reminder_dispatch",
] as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const RESET_TOKEN = /^[A-Za-z0-9_-]{20,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LOST_DEVICE_RAW_PROOF = /^[A-Za-z0-9_-]{43}$/;
const ISSUED_LOST_DEVICE_EVIDENCE = new WeakSet<object>();
const DATE_PERIOD = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_PERIOD = /^(\d{4})-W(\d{2})$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f]/;

const SMART_TEMPLATE = Object.freeze({
  "daily-study-reminder": {
    kind: "daily_study",
    path: "/learn",
    preferenceColumn: "daily_study_enabled",
    period: "date",
  },
  "revision-reminder": {
    kind: "revision",
    path: "/review",
    preferenceColumn: "revision_enabled",
    period: "date",
  },
  "goal-reminder": {
    kind: "goal",
    path: "/roadmap",
    preferenceColumn: "goal_enabled",
    period: "week",
  },
  "challenge-reminder": {
    kind: "challenge",
    path: "/community?section=battles",
    preferenceColumn: "challenge_enabled",
    period: "date",
  },
  "weekly-summary": {
    kind: "weekly_summary",
    path: "/learn",
    preferenceColumn: "weekly_summary_enabled",
    period: "week",
  },
} as const);

type SmartTemplate = keyof typeof SMART_TEMPLATE;
type SmartKind = typeof SMART_TEMPLATE[SmartTemplate]["kind"];
type InactivityTemplate =
  | "inactivity-reminder"
  | "inactivity-reminder-followup"
  | "inactivity-admin-notice";

type StringRecord = Readonly<Record<string, string>>;

type ParsedRevocableSource = Readonly<
  | { kind: "reset-password"; sourceId: string }
  | { kind: "lost-device-proof"; sourceId: string }
  | { kind: "session-revocation-requested"; sourceId: string }
  | { kind: "inactivity"; sourceId: string; template: InactivityTemplate }
  | {
      kind: "smart-reminder";
      sourceId: string;
      template: SmartTemplate;
      reminderKind: SmartKind;
      periodKey: string;
    }
>;

export type RevocableSourceAuthorityQuery = Readonly<{
  kind: ParsedRevocableSource["kind"];
  text: string;
  values: readonly unknown[];
}>;
export type LostDeviceAuthorityEvidence = Readonly<{
  kind: "lost-device-proof";
  sourceId: string;
  proofHash: string;
}>;

function sameSha256(left: string, right: string) {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return timingSafeEqual(leftBytes, rightBytes);
}

export function createLostDeviceAuthorityEvidence(input: Readonly<{
  sourceId: string;
  rawProof: string;
  storedProofHash: string;
}>): LostDeviceAuthorityEvidence | null {
  if (
    !UUID.test(input.sourceId)
    || !LOST_DEVICE_RAW_PROOF.test(input.rawProof)
    || !SHA256.test(input.storedProofHash)
  ) return null;
  const proofHash = createHash("sha256").update(input.rawProof).digest("hex");
  if (!sameSha256(proofHash, input.storedProofHash)) return null;
  const evidence = Object.freeze({
    kind: "lost-device-proof" as const,
    sourceId: input.sourceId,
    proofHash,
  });
  ISSUED_LOST_DEVICE_EVIDENCE.add(evidence);
  return evidence;
}

export function issuedLostDeviceAuthorityEvidenceMatches(
  evidence: LostDeviceAuthorityEvidence | undefined,
  sourceId: string,
): evidence is LostDeviceAuthorityEvidence {
  return evidence !== undefined
    && Object.isFrozen(evidence)
    && ISSUED_LOST_DEVICE_EVIDENCE.has(evidence)
    && UUID.test(sourceId)
    && evidence.kind === "lost-device-proof"
    && evidence.sourceId === sourceId
    && SHA256.test(evidence.proofHash);
}

export class RevocableSourceAuthorityError extends Error {
  constructor(readonly code:
    | "MAIL_SOURCE_EVIDENCE_INVALID"
    | "RESET_PASSWORD_SOURCE_UNAVAILABLE"
  ) {
    super("Mail source authority is unavailable.");
    this.name = "RevocableSourceAuthorityError";
  }
}

function boundedText(value: unknown, maximum: number) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maximum
    && !UNSAFE_TEXT.test(value);
}
function leapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validCalendarDatePeriod(value: string) {
  const match = DATE_PERIOD.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || year < 1 || year > 9_999 || month < 1 || month > 12) return false;
  const daysInMonth = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

function validIsoWeekPeriod(value: string) {
  const match = WEEK_PERIOD.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isInteger(year) || year < 1 || year > 9_999 || !Number.isInteger(week)) return false;
  const januaryFirstWeekday = new Date(`${match[1]}-01-01T00:00:00.000Z`).getUTCDay();
  const maximumWeek = januaryFirstWeekday === 4 || (januaryFirstWeekday === 3 && leapYear(year)) ? 53 : 52;
  return week >= 1 && week <= maximumWeek;
}

function exactStringRecord(value: unknown, expectedKeys: readonly string[]): StringRecord | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const actualKeys = Object.keys(record).sort();
    const keys = [...expectedKeys].sort();
    if (actualKeys.length !== keys.length || actualKeys.some((key, index) => key !== keys[index])) {
      return null;
    }
    if (actualKeys.some((key) => typeof record[key] !== "string")) return null;
    return record as Record<string, string>;
  } catch {
    return null;
  }
}

function applicationOrigin(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function exactApplicationUrl(value: unknown, baseUrl: unknown, pathAndSearch: string) {
  if (typeof value !== "string" || value.length > 2_048) return false;
  const origin = applicationOrigin(baseUrl);
  if (!origin) return false;
  try {
    const url = new URL(value);
    return !url.username
      && !url.password
      && !url.hash
      && url.origin === origin
      && `${url.pathname}${url.search}` === pathAndSearch
      && value === `${origin}${pathAndSearch}`;
  } catch {
    return false;
  }
}

function resetTokenFromUrl(value: unknown, baseUrl: unknown) {
  if (typeof value !== "string" || value.length > 2_048) return null;
  const origin = applicationOrigin(baseUrl);
  if (!origin) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.origin !== origin) return null;
    const match = url.pathname.match(/^\/api\/auth\/reset-password\/([A-Za-z0-9_-]{20,128})$/);
    if (!match || !RESET_TOKEN.test(match[1]!)) return null;
    if (url.searchParams.getAll("callbackURL").length !== 1) return null;
    if ([...url.searchParams.keys()].some((key) => key !== "callbackURL")) return null;
    const callback = new URL(url.searchParams.get("callbackURL")!, origin);
    if (
      callback.origin !== origin
      || callback.username
      || callback.password
      || callback.hash
      || callback.search
      || callback.pathname !== "/reset-password"
    ) return null;
    return match[1]!;
  } catch {
    return null;
  }
}

function sessionRevocationUrl(value: unknown, baseUrl: unknown) {
  if (typeof value !== "string" || value.length > 2_048) return false;
  const origin = applicationOrigin(baseUrl);
  if (!origin) return false;
  try {
    const url = new URL(value);
    return url.origin === origin
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && /^\/admin\/learners\/[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(url.pathname)
      && value === `${origin}${url.pathname}`;
  } catch {
    return false;
  }
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function requireRevocableSourceVariables<T extends StringRecord>(
  variables: T | null,
): T {
  if (!variables) throw new RevocableSourceAuthorityError("MAIL_SOURCE_EVIDENCE_INVALID");
  return variables;
}

function parseResetPassword(
  variables: unknown,
  applicationUrl: unknown,
): ParsedRevocableSource | null {
  const record = exactStringRecord(variables, ["name", "resetVerificationId", "url"]);
  if (
    !record
    || !boundedText(record.name, 200)
    || !STABLE_ID.test(record.resetVerificationId)
    || !resetTokenFromUrl(record.url, applicationUrl)
  ) return null;
  return freeze({ kind: "reset-password" as const, sourceId: record.resetVerificationId });
}

function parseLostDeviceProof(variables: unknown): ParsedRevocableSource | null {
  const record = exactStringRecord(variables, ["name", "recoveryRequestId"]);
  if (!record || !boundedText(record.name, 200) || !UUID.test(record.recoveryRequestId)) return null;
  return freeze({ kind: "lost-device-proof" as const, sourceId: record.recoveryRequestId });
}

function parseSessionRevocation(
  variables: unknown,
  applicationUrl: unknown,
): ParsedRevocableSource | null {
  const record = exactStringRecord(
    variables,
    ["device", "name", "revocationRequestId", "url"],
  );
  if (
    !record
    || record.device !== SESSION_REVOCATION_EMAIL_DEVICE
    || !boundedText(record.name, 200)
    || !UUID.test(record.revocationRequestId)
    || !sessionRevocationUrl(record.url, applicationUrl)
  ) return null;
  return freeze({
    kind: "session-revocation-requested" as const,
    sourceId: record.revocationRequestId,
  });
}

function parseInactivity(
  template: InactivityTemplate,
  variables: unknown,
  applicationUrl: unknown,
): ParsedRevocableSource | null {
  const record = exactStringRecord(
    variables,
    ["inactivityEpisodeId", "inactivityPolicyVersion", "name", "url"],
  );
  const expectedPath = template === "inactivity-admin-notice" ? "/admin" : "/learn";
  if (
    !record
    || !UUID.test(record.inactivityEpisodeId)
    || record.inactivityPolicyVersion !== INACTIVITY_MAIL_POLICY_VERSION
    || !boundedText(record.name, 200)
    || (template === "inactivity-admin-notice" && record.name !== "administrator")
    || !exactApplicationUrl(record.url, applicationUrl, expectedPath)
  ) return null;
  return freeze({ kind: "inactivity" as const, sourceId: record.inactivityEpisodeId, template });
}

function parseSmartReminder(
  template: SmartTemplate,
  variables: unknown,
  applicationUrl: unknown,
): ParsedRevocableSource | null {
  const policy = SMART_TEMPLATE[template];
  const keys = [
    "name",
    "smartReminderDispatchId",
    "smartReminderKind",
    "smartReminderPeriodKey",
    "smartReminderPolicyVersion",
    ...(template === "weekly-summary" ? ["summary"] : []),
    "url",
  ];
  const record = exactStringRecord(variables, keys);
  const validPeriod = policy.period === "week"
    ? validIsoWeekPeriod(record?.smartReminderPeriodKey ?? "")
    : validCalendarDatePeriod(record?.smartReminderPeriodKey ?? "");
  if (
    !record
    || !boundedText(record.name, 200)
    || !UUID.test(record.smartReminderDispatchId)
    || record.smartReminderKind !== policy.kind
    || !validPeriod
    || record.smartReminderPolicyVersion !== SMART_REMINDER_POLICY_VERSION
    || (template === "weekly-summary" && record.summary !== SMART_REMINDER_WEEKLY_SUMMARY)
    || !exactApplicationUrl(record.url, applicationUrl, policy.path)
  ) return null;
  return freeze({
    kind: "smart-reminder" as const,
    sourceId: record.smartReminderDispatchId,
    template,
    reminderKind: policy.kind,
    periodKey: record.smartReminderPeriodKey,
  });
}

export function parseRevocableSourceVariables(input: {
  applicationUrl: string;
  template: unknown;
  templateVersion: unknown;
  variables: unknown;
}): ParsedRevocableSource | null {
  if (typeof input.template !== "string" || typeof input.templateVersion !== "string") return null;
  if (input.template === "reset-password" && input.templateVersion === "1") {
    return parseResetPassword(input.variables, input.applicationUrl);
  }
  if (input.template === "lost-device-proof" && input.templateVersion === "1") {
    return parseLostDeviceProof(input.variables);
  }
  if (input.template === "session-revocation-requested" && input.templateVersion === "1") {
    return parseSessionRevocation(input.variables, input.applicationUrl);
  }
  if (
    input.templateVersion === "2"
    && ["inactivity-reminder", "inactivity-reminder-followup", "inactivity-admin-notice"]
      .includes(input.template)
  ) {
    return parseInactivity(input.template as InactivityTemplate, input.variables, input.applicationUrl);
  }
  if (
    input.templateVersion === "1"
    && Object.hasOwn(SMART_TEMPLATE, input.template)
  ) {
    return parseSmartReminder(input.template as SmartTemplate, input.variables, input.applicationUrl);
  }
  return null;
}

export function createResetPasswordSourceVariables(input: {
  applicationUrl: string;
  name: string;
  token: string;
  url: string;
  verificationId: string;
}): StringRecord | null {
  const variables = {
    name: input.name,
    resetVerificationId: input.verificationId,
    url: input.url,
  };
  const token = resetTokenFromUrl(input.url, input.applicationUrl);
  if (token !== input.token || !parseResetPassword(variables, input.applicationUrl)) return null;
  return freeze(variables);
}

export function createLostDeviceProofSourceVariables(input: {
  name: string;
  recoveryRequestId: string;
}): StringRecord | null {
  const variables = { name: input.name, recoveryRequestId: input.recoveryRequestId };
  return parseLostDeviceProof(variables) ? freeze(variables) : null;
}

export function createSessionRevocationSourceVariables(input: {
  applicationUrl: string;
  name: string;
  requestId: string;
  url: string;
}): StringRecord | null {
  const variables = {
    device: SESSION_REVOCATION_EMAIL_DEVICE,
    name: input.name,
    revocationRequestId: input.requestId,
    url: input.url,
  };
  return parseSessionRevocation(variables, input.applicationUrl) ? freeze(variables) : null;
}

export function createInactivitySourceVariables(input: {
  applicationUrl: string;
  episodeId: string;
  name: string;
  template: InactivityTemplate;
  url: string;
}): StringRecord | null {
  const variables = {
    inactivityEpisodeId: input.episodeId,
    inactivityPolicyVersion: INACTIVITY_MAIL_POLICY_VERSION,
    name: input.name,
    url: input.url,
  };
  return parseInactivity(input.template, variables, input.applicationUrl) ? freeze(variables) : null;
}

export function createSmartReminderSourceVariables(input: {
  applicationUrl: string;
  dispatchId: string;
  kind: SmartKind;
  name: string;
  periodKey: string;
  template: SmartTemplate;
  url: string;
}): StringRecord | null {
  const variables = {
    name: input.name,
    smartReminderDispatchId: input.dispatchId,
    smartReminderKind: input.kind,
    smartReminderPeriodKey: input.periodKey,
    smartReminderPolicyVersion: SMART_REMINDER_POLICY_VERSION,
    ...(input.template === "weekly-summary" ? { summary: SMART_REMINDER_WEEKLY_SUMMARY } : {}),
    url: input.url,
  };
  return parseSmartReminder(input.template, variables, input.applicationUrl) ? freeze(variables) : null;
}

function frozenQuery(
  kind: ParsedRevocableSource["kind"],
  text: string,
  values: readonly unknown[],
): RevocableSourceAuthorityQuery {
  return freeze({ kind, text, values: Object.freeze([...values]) });
}

function resetAuthorityQuery(
  input: BuildRevocableSourceAuthorityQueryInput,
  parsed: Extract<ParsedRevocableSource, { kind: "reset-password" }>,
) {
  const record = input.variables as Record<string, string>;
  const token = resetTokenFromUrl(record.url, input.applicationUrl);
  if (!token) return null;
  return frozenQuery(parsed.kind, `
    select 1
      from public.verification source_verification
      join public.email_outbox mail on mail.id = $1::uuid
      join public."user" recipient_user on recipient_user.id = mail.user_id
     where mail.template = 'reset-password'
       and mail.template_version = '1'
       and mail.variables ->> 'resetVerificationId' = $2
       and source_verification.id = $2
       and source_verification.identifier = $3
       and source_verification.value = mail.user_id
       and source_verification.expires_at > $4
       and recipient_user.status in ('pending','active')
       and recipient_user.banned = false
       and lower(btrim(recipient_user.email)) = mail.to_email
       and mail.variables ->> 'name' = recipient_user.name
     for share of recipient_user, source_verification
  `, [input.outboxId, parsed.sourceId, `reset-password:${token}`, input.now]);
}

function lostDeviceAuthorityQuery(
  input: BuildRevocableSourceAuthorityQueryInput,
  parsed: Extract<ParsedRevocableSource, { kind: "lost-device-proof" }>,
) {
  const evidence = input.authorityEvidence;
  if (!issuedLostDeviceAuthorityEvidenceMatches(evidence, parsed.sourceId)) return null;
  return frozenQuery(parsed.kind, `
    select 1
      from public.lost_device_proof source_proof
      join public.session source_session
        on source_session.id = source_proof.session_id
       and source_session.user_id = source_proof.user_id
      join public.email_outbox mail on mail.id = $1::uuid
      join public."user" recipient_user
        on recipient_user.id = mail.user_id
       and recipient_user.id = source_proof.user_id
     where mail.template = 'lost-device-proof'
       and mail.template_version = '1'
       and mail.variables ->> 'recoveryRequestId' = $2::text
       and source_proof.id = $2::uuid
       and source_proof.proof_hash = $3
       and source_proof.consumed_at is null
       and source_proof.expires_at > $4
       and source_session.revoked_at is null
       and source_session.expires_at > $4
       and recipient_user.role = 'learner'
       and recipient_user.status = 'active'
       and recipient_user.email_verified = true
       and recipient_user.banned = false
       and lower(btrim(recipient_user.email)) = mail.to_email
       and mail.variables ->> 'name' = recipient_user.name
     for share of recipient_user, source_proof, source_session
  `, [input.outboxId, parsed.sourceId, evidence.proofHash, input.now]);
}

function sessionRevocationAuthorityQuery(
  input: BuildRevocableSourceAuthorityQueryInput,
  parsed: Extract<ParsedRevocableSource, { kind: "session-revocation-requested" }>,
) {
  const origin = applicationOrigin(input.applicationUrl);
  if (!origin) return null;
  return frozenQuery(parsed.kind, `
    select 1
      from public.session_revocation_request source_request
      join public.email_outbox mail on mail.id = $1::uuid
      join public."user" recipient_user on recipient_user.id = mail.user_id
      join public."user" subject_user on subject_user.id = source_request.user_id
     where mail.template = 'session-revocation-requested'
       and mail.template_version = '1'
       and mail.variables ->> 'revocationRequestId' = $2::text
       and source_request.id = $2::uuid
       and source_request.status = 'pending'
       and subject_user.role = 'learner'
       and subject_user.status = 'active'
       and subject_user.banned = false
       and recipient_user.role = 'admin'
       and recipient_user.status = 'active'
       and recipient_user.banned = false
       and lower(btrim(recipient_user.email)) = mail.to_email
       and mail.variables ->> 'name' = recipient_user.name
       and mail.variables ->> 'url' = $3 || '/admin/learners/' || source_request.user_id
       and mail.variables ->> 'device' = $4
     for share of recipient_user, source_request, subject_user
  `, [input.outboxId, parsed.sourceId, origin, SESSION_REVOCATION_EMAIL_DEVICE]);
}

function inactivityAuthorityQuery(
  input: BuildRevocableSourceAuthorityQueryInput,
  parsed: Extract<ParsedRevocableSource, { kind: "inactivity" }>,
) {
  const origin = applicationOrigin(input.applicationUrl);
  if (!origin) return null;
  return frozenQuery(parsed.kind, `
    select 1
      from public.inactivity_episode source_episode
      join public."user" learner_user on learner_user.id = source_episode.user_id
      join public.learner_profile learner_profile
        on learner_profile.user_id = learner_user.id
       and learner_profile.onboarding_completed_at is not null
      join public.email_outbox mail on mail.id = $1::uuid
      join public."user" recipient_user on recipient_user.id = mail.user_id
      left join public.notification_preference source_preference
        on source_preference.user_id = learner_user.id
      left join lateral (
        select consent.decision, consent.policy_version
          from public.consent_record consent
         where consent.user_id = learner_user.id
           and consent.purpose = 'inactivity_mentor_notice'
         order by consent.occurred_at desc, consent.created_at desc, consent.id desc
         limit 1
      ) latest_consent on true
     where source_episode.id = $2::uuid
       and mail.variables ->> 'inactivityEpisodeId' = $2::text
       and mail.variables ->> 'inactivityPolicyVersion' = $5
       and mail.template_version = '2'
       and mail.template = $7
       and source_episode.policy_version = $5
       and source_episode.closed_at is null
       and coalesce(learner_user.last_meaningful_activity_at, learner_profile.onboarding_completed_at)
             = source_episode.last_activity_at
       and learner_user.role = 'learner'
       and learner_user.status = 'active'
       and learner_user.banned = false
       and latest_consent.decision = 'accepted'
       and latest_consent.policy_version = $4
       and (source_preference.inactivity_paused_until is null
            or source_preference.inactivity_paused_until <= $3)
       and recipient_user.status = 'active'
       and recipient_user.banned = false
       and (
         (mail.template = 'inactivity-reminder'
           and mail.user_id = learner_user.id
           and lower(btrim(learner_user.email)) = mail.to_email
           and mail.variables ->> 'name' = learner_user.name
           and mail.variables ->> 'url' = $6 || '/learn'
           and source_episode.learner_first_queued_at between source_episode.eligible_at and $3)
         or (mail.template = 'inactivity-reminder-followup'
           and mail.user_id = learner_user.id
           and lower(btrim(learner_user.email)) = mail.to_email
           and mail.variables ->> 'name' = learner_user.name
           and mail.variables ->> 'url' = $6 || '/learn'
           and source_episode.learner_first_queued_at between source_episode.eligible_at and $3 - interval '48 hours'
           and source_episode.learner_second_queued_at between source_episode.second_eligible_at and $3
           and source_episode.learner_second_queued_at >= source_episode.learner_first_queued_at + interval '48 hours')
         or (mail.template = 'inactivity-admin-notice'
           and recipient_user.role = 'admin'
           and lower(btrim(recipient_user.email)) = mail.to_email
           and mail.variables ->> 'name' = 'administrator'
           and mail.variables ->> 'url' = $6 || '/admin'
           and source_episode.admin_notice_queued_at <= $3
           and source_episode.learner_first_queued_at is not null
           and source_episode.learner_first_queued_at >= source_episode.eligible_at
           and source_episode.learner_first_queued_at <= source_episode.admin_notice_queued_at)
       )
     for share of recipient_user, learner_user, source_episode
  `, [
    input.outboxId,
    parsed.sourceId,
    input.now,
    ENROLLMENT_DISCLOSURE_VERSION,
    INACTIVITY_MAIL_POLICY_VERSION,
    origin,
    parsed.template,
  ]);
}

function smartReminderAuthorityQuery(
  input: BuildRevocableSourceAuthorityQueryInput,
  parsed: Extract<ParsedRevocableSource, { kind: "smart-reminder" }>,
) {
  const policy = SMART_TEMPLATE[parsed.template];
  const expectedUrl = `${applicationOrigin(input.applicationUrl)}${policy.path}`;
  return frozenQuery(parsed.kind, `
    select 1
      from public.smart_reminder_dispatch source_dispatch
      join public.email_outbox mail on mail.id = $1::uuid
      join public."user" recipient_user on recipient_user.id = mail.user_id
      join public.notification_preference recipient_preference
        on recipient_preference.user_id = recipient_user.id
      join pg_catalog.pg_timezone_names source_timezone
        on source_timezone.name = source_dispatch.timezone
     where source_dispatch.id = $2::uuid
       and source_dispatch.user_id = mail.user_id
       and source_dispatch.kind = $3
       and source_dispatch.local_period_key = $4
       and source_dispatch.timezone = recipient_preference.timezone
       and source_dispatch.local_period_key = to_char(
         source_dispatch.scheduled_for at time zone source_timezone.name, $7
       )
       and source_dispatch.scheduled_for <= $8 and source_dispatch.dispatched_at <= $8
       and source_dispatch.dispatched_at >= source_dispatch.scheduled_for
       and source_dispatch.evidence ->> 'policyVersion' = $5
       and mail.template = '${parsed.template}'
       and mail.template_version = '1'
       and mail.variables ->> 'smartReminderDispatchId' = $2::text
       and mail.variables ->> 'smartReminderKind' = $3
       and mail.variables ->> 'smartReminderPeriodKey' = $4
       and mail.variables ->> 'smartReminderPolicyVersion' = $5
       and mail.variables ->> 'url' = $6
       and recipient_user.role = 'learner'
       and recipient_user.status = 'active'
       and recipient_user.banned = false
       and lower(btrim(recipient_user.email)) = mail.to_email
       and mail.variables ->> 'name' = recipient_user.name
       and recipient_preference.learning_email_enabled = true
       and recipient_preference.${policy.preferenceColumn} = true
     for share of recipient_user, recipient_preference, source_dispatch
  `, [
    input.outboxId,
    parsed.sourceId,
    parsed.reminderKind,
    parsed.periodKey,
    SMART_REMINDER_POLICY_VERSION,
    expectedUrl,
    policy.period === "week" ? 'IYYY-"W"IW' : "YYYY-MM-DD",
    input.now,
  ]);
}

type BuildRevocableSourceAuthorityQueryInput = Readonly<{
  applicationUrl: string;
  authorityEvidence?: LostDeviceAuthorityEvidence;
  now: Date;
  outboxId: string;
  template: unknown;
  templateVersion: unknown;
  variables: unknown;
}>;

export function buildRevocableSourceAuthorityQuery(
  input: BuildRevocableSourceAuthorityQueryInput,
): RevocableSourceAuthorityQuery | null {
  if (!UUID.test(input.outboxId) || !Number.isFinite(input.now.getTime())) return null;
  const parsed = parseRevocableSourceVariables(input);
  if (!parsed) return null;
  switch (parsed.kind) {
    case "reset-password": return resetAuthorityQuery(input, parsed);
    case "lost-device-proof": return lostDeviceAuthorityQuery(input, parsed);
    case "session-revocation-requested": return sessionRevocationAuthorityQuery(input, parsed);
    case "inactivity": return inactivityAuthorityQuery(input, parsed);
    case "smart-reminder": return smartReminderAuthorityQuery(input, parsed);
  }
}

type ResetSourceDatabase = Readonly<{
  query(
    text: string,
    values: unknown[],
  ): Promise<Readonly<{ rows: unknown[] }>>;
}>;

export async function loadResetPasswordVerificationSource(
  database: ResetSourceDatabase,
  input: Readonly<{ token: string; userId: string }>,
): Promise<string | null> {
  if (!RESET_TOKEN.test(input.token) || !STABLE_ID.test(input.userId)) return null;
  let rows: unknown[];
  try {
    rows = (await database.query(
      `select id
         from public.verification
        where identifier = $1
          and value = $2
          and expires_at > statement_timestamp()
        order by created_at desc, id desc
        limit 2`,
      [`reset-password:${input.token}`, input.userId],
    )).rows;
  } catch {
    throw new RevocableSourceAuthorityError("RESET_PASSWORD_SOURCE_UNAVAILABLE");
  }
  if (rows.length !== 1) return null;
  const id = (rows[0] as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && STABLE_ID.test(id) ? id : null;
}
