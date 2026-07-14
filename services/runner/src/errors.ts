export type RunnerErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "AUTH_EXPIRED"
  | "AUTH_REPLAY"
  | "BAD_REQUEST"
  | "BODY_TOO_LARGE"
  | "IDEMPOTENCY_CONFLICT"
  | "QUEUE_FULL"
  | "NOT_FOUND"
  | "EXECUTION_TIMEOUT"
  | "OUTPUT_LIMIT"
  | "INFRASTRUCTURE_ERROR";

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(
    code: RunnerErrorCode,
    message: string,
    httpStatus: number,
    retryable = false,
  ) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}
