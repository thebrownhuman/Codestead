export const LIMITS: Readonly<{ slots: number; grantMs: number; idleMs: number; wallMs: number;
  sourceBytes: number; stdinBytes: number; outputBytes: number; frameBytes: number;
  bufferedBytes: number; cancellationMs: number }>;
export const SOCKET_PROTOCOL: string;
export const SOCKET_PATH: RegExp;
export function canonicalOrigin(value: string | undefined, production?: boolean): string | null;
export function sameOrigin(headers: Headers | Record<string, unknown>, origin: string | null): boolean;
export function brokerSecret(env?: { INTERACTIVE_BROKER_SECRET_FILE?: string; INTERACTIVE_BROKER_SECRET?: string }): string;
export function bodyHash(value: string | Uint8Array): string;
export function signEnvelope(secret: string, purpose: string, payload: Record<string, unknown>, now?: number): string;
export function verifyEnvelope(secret: string, purpose: string, token: string | undefined | null, now?: number): Record<string, unknown>;
export function practiceInput(value: unknown, runtimes: Record<string, { version: string }>): {
  type: string; language: string; version: string; files: { name: string; content: string }[];
};
