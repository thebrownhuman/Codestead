# Authoritative learner draft sync

`learner_draft` is the authoritative copy of a bounded code or lesson draft. Browser `sessionStorage` is only a warm-session working cache; it is neither primary storage nor a backup.

## Protocol

1. The authenticated app layout derives an opaque HMAC namespace from the durable user and session IDs. Raw identity values never enter a cache key.
2. CodeLab reads only that namespace, then `GET /api/drafts` restores the session user's PostgreSQL copy. A missing/evicted cache therefore cannot remove server-synced work.
3. Every local edit gets a UUID request ID, the last known `rowVersion`, and an explicit `local`, `offline`, or `syncing` label. The same request ID is reused after an ambiguous transport failure.
4. `PUT /api/drafts` re-reads the durable session, enforces the closed-book learning gate, derives `userId` from that session, and compares `expectedRowVersion` in a transaction.
5. An accepted mutation creates a durable `learner_draft_mutation` receipt. Replaying that request after later edits returns the receipt's committed version plus the current draft without reapplying or overwriting anything.
6. A stale distinct mutation gets `409 DRAFT_VERSION_CONFLICT` and the current server copy. CodeLab preserves local text until the learner explicitly chooses the server copy or rebases the local copy.
7. A revoked/expired session or active closed-book exam purges the current browser namespace, removes editor assistance, and cannot sync.

The API is `private, no-store`, validates exact key/body fields and UTF-8 byte bounds, applies a per-user mutation rate limit, and has no client-supplied user, score, mastery, exam, or evidence field.

## Lifecycle

- Retention policy `2026-07-12.v3` keeps drafts and idempotency receipts until administrator account deletion.
- Learner export schema 9 includes draft content and content-free receipt history.
- Account deletion explicitly deletes receipts before drafts; the user foreign key also cascades as a second database guard.
- Normal logout clears all Codestead draft entries from the browser session cache before durable sign-out.
- A disconnected server cannot execute JavaScript to erase `sessionStorage`. Account deletion still revokes server access, future denied requests purge the current namespace, and shared-device users must sign out or clear site data.

## Deliberate limitation

This release remains a normal responsive website. It has no web-app manifest, service worker, install prompt, background sync, or cold offline launch. Offline draft behavior works only in a page/browser session that is already open. Unsynced local-only text can be lost on eviction; the UI says so. Server-synced work is restored on any authenticated device.

Verification lives in:

- `src/lib/drafts/__tests__/browser-cache.test.ts`
- `src/lib/drafts/__tests__/repository.test.ts`
- `src/app/api/drafts/__tests__/route.test.ts`
- `src/components/lesson/__tests__/code-lab-draft-sync.test.tsx`
- `integration/learner-drafts.integration.test.ts`
- `docs/evidence/ses-004-dat-003-draft-sync-2026-07-12.json`
