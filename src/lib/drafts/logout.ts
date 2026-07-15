import {
  openBrowserOutbox,
  type BrowserOutboxRepository,
} from "@/lib/browser-durability/indexed-db";
import { purgeBrowserRecoveryData } from "@/lib/browser-durability/lifecycle";

function signOutWasRejected(result: unknown) {
  if (result instanceof Response) return !result.ok;
  return Boolean(result
    && typeof result === "object"
    && "error" in result
    && (result as { error?: unknown }).error);
}

/**
 * Ends the authoritative session before publishing a browser recovery
 * boundary. A failed authority operation preserves the learner's only local
 * copy. Once the server confirms sign-out, navigation cannot be rolled back
 * merely because best-effort browser cleanup was partial.
 */
export async function signOutWithBrowserDurabilityCleanup({
  namespace,
  sessionStorage,
  localStorage,
  signOut,
  navigate,
  openRepository = openBrowserOutbox,
}: {
  namespace: string;
  sessionStorage: Storage;
  localStorage: Storage;
  signOut(): Promise<unknown>;
  navigate(destination: string): void;
  openRepository?: () => Promise<BrowserOutboxRepository>;
}) {
  const result = await signOut();
  if (signOutWasRejected(result)) {
    throw new Error("Sign-out could not be confirmed.");
  }

  let repository: BrowserOutboxRepository | null = null;
  let cleanupSucceeded = false;
  try {
    try {
      repository = await openRepository();
    } catch {
      repository = {
        clearNamespace: async () => {
          throw new Error("Browser recovery storage is unavailable.");
        },
      } as unknown as BrowserOutboxRepository;
    }
    await purgeBrowserRecoveryData({
      namespace,
      sessionStorage,
      localStorage,
      repository,
    });
    cleanupSucceeded = true;
  } catch {
    // The server session has already ended. The anonymous login gate retries
    // global cleanup before credentials are exposed.
  } finally {
    repository?.close?.();
  }

  navigate("/login");
  return { cleanupSucceeded } as const;
}
