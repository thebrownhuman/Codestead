/**
 * Shared administrator step-up. Privileged admin routes answer 403
 * FRESH_MFA_REQUIRED when the session's authenticator verification is older
 * than the short admin window. Instead of each page showing a dead-end error,
 * admin requests go through withStepUp: it asks the mounted
 * <AdminStepUpDialog> for a code, verifies it via /api/security/fresh-mfa and
 * retries the original request once. Server checks and windows are unchanged.
 */
type Prompter = () => Promise<boolean>;

let prompter: Prompter | null = null;
let generation = 0;
let pending: { generation: number; promise: Promise<boolean>; settle: (value: boolean) => void } | null = null;

export function registerStepUpPrompter(next: Prompter | null) {
  pending?.settle(false);
  pending = null;
  const owner = ++generation;
  prompter = next;
  return () => {
    if (generation === owner) registerStepUpPrompter(null);
  };
}

async function requestStepUp(): Promise<boolean> {
  if (!prompter) return false;
  // Parallel requests share one dialog.
  if (pending?.generation === generation) return pending.promise;
  let settle: (value: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((resolve) => { settle = resolve; });
  const slot = { generation, promise, settle };
  pending = slot;
  const complete = (value: boolean) => {
    slot.settle(value);
    if (pending === slot) pending = null;
  };
  try { void prompter().then(complete, () => complete(false)); }
  catch { complete(false); }
  return promise;
}

export async function isFreshMfaRequired(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const body = (await response.clone().json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  return body?.error === "FRESH_MFA_REQUIRED" || body?.code === "FRESH_MFA_REQUIRED";
}

export async function withStepUp(run: () => Promise<Response>): Promise<Response> {
  const response = await run();
  if (!(await isFreshMfaRequired(response))) return response;
  return (await requestStepUp()) ? run() : response;
}
