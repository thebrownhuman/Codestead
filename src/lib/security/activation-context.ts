import { AsyncLocalStorage } from "node:async_hooks";

export interface ActivationAuthorization {
  readonly invitationId: string;
  readonly email: string;
}

const activationStorage = new AsyncLocalStorage<ActivationAuthorization>();
const bootstrapStorage = new AsyncLocalStorage<string>();

export function runAuthorizedActivation<T>(
  authorization: ActivationAuthorization,
  operation: () => T,
) {
  return activationStorage.run(
    { ...authorization, email: authorization.email.trim().toLowerCase() },
    operation,
  );
}

export function currentActivationAuthorization() {
  return activationStorage.getStore() ?? null;
}

export function runAuthorizedBootstrap<T>(email: string, operation: () => T) {
  return bootstrapStorage.run(email.trim().toLowerCase(), operation);
}

export function currentBootstrapAuthorization() {
  return bootstrapStorage.getStore() ?? null;
}
