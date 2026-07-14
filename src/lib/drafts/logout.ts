import { clearDraftCaches } from "./browser-cache";

/**
 * End the authoritative session first. If sign-out fails (for example while
 * offline), preserve the learner's only unsynced local copy. Once sign-out is
 * confirmed, cache removal is synchronous and completes before navigation.
 */
export async function signOutWithDraftCleanup({
  storage,
  signOut,
  navigate,
}: {
  storage: Storage;
  signOut(): Promise<unknown>;
  navigate(destination: string): void;
}) {
  await signOut();
  let cleared = 0;
  try { cleared = clearDraftCaches(storage); } catch { /* durable sign-out already succeeded */ }
  navigate("/login");
  return cleared;
}
