# Browser Task 2 final-review remediation

## Scope

This remediation addresses the three requested changes in
`browser-task-2-final-review.md`:

1. bind every accepted PUT conflict copy and every subsequent PUT authorization
   to the mounted browser `cacheNamespace`;
2. keep acknowledgement/Use-server compare-delete uncertainty blocked until the
   current durable winner has been reread and adopted; and
3. remove the prior `src/app/api/drafts/**` test hunk from the cumulative Task 2
   change set.

No production API route, schema, storage, backup, or exam-autosave file is part
of this remediation.

## RED evidence

Command:

```text
npx.cmd vitest run src/components/lesson/__tests__/code-lab-draft-sync.test.tsx -t "response namespace|another namespace|route-shaped|cleanup loses|conditional deletion rejects"
```

Before the production fix: **9 failed, 39 skipped**. The failures demonstrated:

- acknowledgement cleanup false plus a failed reread became editable
  `unavailable` instead of blocked recovery;
- idempotency and quota actions sent another PUT without a new GET;
- idempotency, quota, and unknown-409 recovery resent after a recovery GET
  returned another namespace;
- missing and mismatched conflict namespaces exposed an untrusted server copy;
- rejected Use-server cleanup returned to ordinary conflict and exposed stale
  Keep.

## GREEN evidence

Targeted protocol regressions:

```text
npx.cmd vitest run src/components/lesson/__tests__/code-lab-draft-sync.test.tsx -t "response namespace|another namespace|route-shaped|cleanup loses|conditional deletion rejects"
```

Result: **1 file, 9 passed, 39 skipped**.

Full authorized draft/browser matrix:

```text
npx.cmd vitest run src/lib/browser-durability/__tests__/indexed-db.test.ts src/lib/drafts/__tests__/browser-cache.test.ts src/lib/drafts/__tests__/repository.test.ts src/components/lesson/__tests__/code-lab-draft-sync.test.tsx
```

Result: **4 files, 86/86 passed** (16 IndexedDB, 8 browser cache, 14 draft
repository, 48 synchronization component tests).

The reverted route-test file was also verified independently:

```text
npx.cmd vitest run src/app/api/drafts/__tests__/route.test.ts
```

Result: **1 file, 10/10 passed**.

Static and security gates:

- `npm.cmd run typecheck`: passed.
- `npx.cmd eslint src/lib/drafts/use-synced-draft.ts src/lib/drafts/browser-cache.ts src/lib/drafts/__tests__/browser-cache.test.ts src/components/lesson/lesson-workspace.tsx src/components/lesson/__tests__/code-lab-draft-sync.test.tsx`: passed.
- `npm.cmd run security:secrets`: passed; no recognized plaintext credential
  canaries.
- `git diff --check`: passed.
- `git diff a96be8a^ -- src/app/api/drafts/__tests__/route.test.ts`: empty,
  proving the cumulative Task 2 route-test change has been removed.

## Self-review

- A version-conflict server copy is accepted only when its response namespace
  exactly matches the mounted runtime namespace and its draft shape/key is
  valid.
- Idempotency, quota, and unknown/wrong/missing-namespace 409 responses revoke
  PUT authorization. Recovery obtains a matching GET context before another
  PUT; a different namespace causes no PUT, no conditional delete, and no
  durable-record replacement.
- Idempotency renewal creates and persists the fresh request identity only after
  the matching recovery GET. Quota and fallback retries retain the exact durable
  mutation.
- A false compare-delete with an unreadable winner and a rejected Use-server
  cleanup preserve the mutation and server copy in `conflict-recovery`. That
  state blocks editing/running and hides stale Keep/Use choices.
- Retrying recovery rereads the exact durable key and adopts a valid external
  winner before conflict choices become available again.
- Existing stale-response, deferred local-write, backoff, single-active-PUT,
  denial, and warm-cache durability tests remain green.
- The unrelated modified evidence JSON files were neither edited nor included.
