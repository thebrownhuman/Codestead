/**
 * Public, provider-safe mail failure surface.
 *
 * Preparation bytes, dispatch authority, OAuth, and physical-send primitives
 * remain behind the committed prepared-dispatch boundary.
 */
export {
  classifyMailDeliveryError,
  MailDeliveryError,
} from "./provider-dispatch-contract";
export type {
  MailDeliveryFailure,
} from "./provider-dispatch-contract";