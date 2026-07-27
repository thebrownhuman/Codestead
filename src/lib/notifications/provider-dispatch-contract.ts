export type PostProviderExit =
  | { readonly kind: "sent"; readonly providerMessageId: string }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "quarantined"; readonly code: string };

declare const committedPreparedDispatchReceiptBrand: unique symbol;

export type CommittedPreparedDispatchReceipt = Readonly<{
  [committedPreparedDispatchReceiptBrand]: "CommittedPreparedDispatchReceipt";
}>;

export type FatalProviderTransportCode =
  | "GMAIL_DELIVERY_TRANSPORT_UNSETTLED"
  | "GMAIL_OAUTH_TRANSPORT_UNSETTLED"
  | "PROVIDER_TRANSPORT_FATAL";

const FATAL_PROVIDER_TRANSPORT_CODES = new Set<FatalProviderTransportCode>([
  "GMAIL_DELIVERY_TRANSPORT_UNSETTLED",
  "GMAIL_OAUTH_TRANSPORT_UNSETTLED",
  "PROVIDER_TRANSPORT_FATAL",
]);
const FATAL_PROVIDER_TRANSPORT_STATES = new WeakMap<
  FatalProviderTransportError,
  FatalProviderTransportCode
>();

export class FatalProviderTransportError extends Error {
  constructor(code: string) {
    super("Fatal provider transport failure.");
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "FatalProviderTransportError",
      writable: true,
    });
    FATAL_PROVIDER_TRANSPORT_STATES.set(
      this,
      FATAL_PROVIDER_TRANSPORT_CODES.has(code as FatalProviderTransportCode)
        ? (code as FatalProviderTransportCode)
        : "PROVIDER_TRANSPORT_FATAL",
    );
  }
}

export function isFatalProviderTransportError(
  error: unknown,
): error is FatalProviderTransportError {
  return (
    ((typeof error === "object" && error !== null) ||
      typeof error === "function") &&
    FATAL_PROVIDER_TRANSPORT_STATES.has(error as FatalProviderTransportError)
  );
}

export function fatalProviderTransportCode(
  error: FatalProviderTransportError,
): FatalProviderTransportCode {
  return (
    FATAL_PROVIDER_TRANSPORT_STATES.get(error) ?? "PROVIDER_TRANSPORT_FATAL"
  );
}

export const MAIL_DELIVERY_FAILURES = Object.freeze({
  GMAIL_DELIVERY_AMBIGUOUS: Object.freeze({
    kind: "ambiguous" as const,
    code: "GMAIL_DELIVERY_AMBIGUOUS" as const,
  }),
  GMAIL_DELIVERY_REJECTED: Object.freeze({
    kind: "definitely-rejected" as const,
    code: "GMAIL_DELIVERY_REJECTED" as const,
  }),
  GMAIL_DELIVERY_TRANSPORT_UNSETTLED: Object.freeze({
    kind: "fatal" as const,
    code: "GMAIL_DELIVERY_TRANSPORT_UNSETTLED" as const,
  }),
  GMAIL_OAUTH_FAILED: Object.freeze({
    kind: "definitely-rejected" as const,
    code: "GMAIL_OAUTH_FAILED" as const,
  }),
  GMAIL_OAUTH_TRANSPORT_UNSETTLED: Object.freeze({
    kind: "fatal" as const,
    code: "GMAIL_OAUTH_TRANSPORT_UNSETTLED" as const,
  }),
  MAIL_PRE_SEND_REJECTED: Object.freeze({
    kind: "definitely-rejected" as const,
    code: "MAIL_PRE_SEND_REJECTED" as const,
  }),
  PAYLOAD_DIGEST_MISMATCH: Object.freeze({
    kind: "definitely-rejected" as const,
    code: "PAYLOAD_DIGEST_MISMATCH" as const,
  }),
  PROVIDER_OUTCOME_AMBIGUOUS: Object.freeze({
    kind: "ambiguous" as const,
    code: "PROVIDER_OUTCOME_AMBIGUOUS" as const,
  }),
  PROVIDER_OUTCOME_INVALID: Object.freeze({
    kind: "ambiguous" as const,
    code: "PROVIDER_OUTCOME_INVALID" as const,
  }),
  PROVIDER_OUTCOME_UNKNOWN: Object.freeze({
    kind: "ambiguous" as const,
    code: "PROVIDER_OUTCOME_UNKNOWN" as const,
  }),
});

export type MailDeliveryFailureCode = keyof typeof MAIL_DELIVERY_FAILURES;
export type MailDeliveryFailure =
  (typeof MAIL_DELIVERY_FAILURES)[MailDeliveryFailureCode];

const MAIL_DELIVERY_ERROR_STATES = new WeakMap<
  MailDeliveryError,
  MailDeliveryFailure
>();

export class MailDeliveryError extends Error {
  constructor(code: MailDeliveryFailureCode) {
    super("Mail provider operation failed.");
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "MailDeliveryError",
      writable: true,
    });
    const canonicalCode =
      typeof code === "string" && Object.hasOwn(MAIL_DELIVERY_FAILURES, code)
        ? code
        : "PROVIDER_OUTCOME_UNKNOWN";
    MAIL_DELIVERY_ERROR_STATES.set(this, MAIL_DELIVERY_FAILURES[canonicalCode]);
  }
}

export function classifyMailDeliveryError(error: unknown): MailDeliveryFailure {
  return error instanceof MailDeliveryError
    ? (MAIL_DELIVERY_ERROR_STATES.get(error) ??
        MAIL_DELIVERY_FAILURES.PROVIDER_OUTCOME_UNKNOWN)
    : MAIL_DELIVERY_FAILURES.PROVIDER_OUTCOME_UNKNOWN;
}
