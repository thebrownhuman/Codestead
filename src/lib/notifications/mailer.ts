/**
 * Public, provider-safe mail preparation surface.
 *
 * Receipt-free OAuth and physical-send primitives live in the explicitly
 * internal transport module. Production imports of that module are restricted
 * to the committed prepared-dispatch implementation.
 */
export {
  classifyMailDeliveryError,
  MailDeliveryError,
} from "./mailer-transport-internal";
export type {
  MailDeliveryFailure,
} from "./mailer-transport-internal";

export {
  dispatchBinding,
  prepareEmail,
  preparedEmailBindingMatches,
} from "./prepared-dispatch";
export type {
  AuthoritativeOutgoingEmail,
  AuthoritySealSha256,
  CompatibilityMailDispatchAuthority,
  CompatibilitySourceAuthoritySha256,
  DispatchBinding,
  MailAdapter,
  MailDispatchAuthority,
  MailPreparationContext,
  MailProviderContext,
  OutgoingEmail,
  PreparedConsoleEmail,
  PreparedEmail,
  PreparedGmailEmail,
