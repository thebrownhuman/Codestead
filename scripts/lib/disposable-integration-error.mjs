export class DisposableIntegrationLifecycleError extends Error {
  /**
   * @param {string} code
   */
  constructor(code) {
    super(`Disposable integration failed: ${code}`);
    this.name = "DisposableIntegrationLifecycleError";
    this.code = code;
  }
}

/**
 * @param {string} code
 * @returns {DisposableIntegrationLifecycleError}
 */
export function disposableIntegrationFailure(code) {
  return new DisposableIntegrationLifecycleError(code);
}
