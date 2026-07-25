export class DisposableIntegrationLifecycleError extends Error {
  readonly code: string;

  constructor(code: string);
}

export function disposableIntegrationFailure(
  code: string,
): DisposableIntegrationLifecycleError;
