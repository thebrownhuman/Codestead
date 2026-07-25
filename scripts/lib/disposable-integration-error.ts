export class DisposableIntegrationLifecycleError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Disposable integration failed: ${code}`);
    this.name = "DisposableIntegrationLifecycleError";
    this.code = code;
  }
}

export function disposableIntegrationFailure(
  code: string,
): DisposableIntegrationLifecycleError {
  return new DisposableIntegrationLifecycleError(code);
}
