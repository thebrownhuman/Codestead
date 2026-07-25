export type PostProviderExit =
  | { readonly kind: "sent"; readonly providerMessageId: string }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "quarantined"; readonly code: string };

export class FatalProviderTransportError extends Error {
  constructor(readonly code: string) {
    super(`Fatal provider transport failure (${code}).`);
    this.name = "FatalProviderTransportError";
  }
}
