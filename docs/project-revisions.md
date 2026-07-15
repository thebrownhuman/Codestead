# Learner project revisions

Project revisions are learner-authored, append-only checkpoints inside an owned project brief. They are not generated implementations and they do not start AI, code execution, GitHub fetching, or static review.

## Invariants

- Every create, list, and detail read is bound to the authenticated learner and the owned project. A foreign project or revision is returned as not found.
- Creation requires a UUID request id and the expected latest revision sequence. The project row is locked, exact retries replay the committed result, changed reuse is rejected, and a stale sequence returns the current sequence for a deliberate reload.
- At most 20 unique files may be associated. Every file must belong to the learner, be undeleted, use the `user_upload` retention class, and have the `safe` scanner decision.
- Association stores only an immutable name/type/size/SHA-256 snapshot and a nullable reference to the existing object. It creates no `quota_ledger` entry and copies no bytes.
- No update or delete API exists for a revision. A later file erasure makes the download unavailable while retaining historical metadata until the project/account is deleted.
- Revision routes are rate limited, strictly schema validated, and return private no-store responses.

## Lifecycle

Learner export schema 9 includes project revisions and file metadata snapshots but never file bytes. Retention policy `2026-07-14.v4` retains them until administrator account deletion. Account deletion explicitly removes revision-object associations and revisions before removing stored objects and projects.

A newly committed checkpoint is authoritative meaningful learning activity. In the same PostgreSQL transaction it advances the learner's `last_meaningful_activity_at`, closes an older open inactivity episode, and, when an active learning session exists, appends one idempotent `project_milestone` event and advances that session's activity time. Exact request replay returns the existing revision without advancing activity or creating another event.

## Review isolation

The revision workspace only records evidence produced by the learner. The existing repository-review route remains a separate explicit action against a pinned public GitHub commit. A revision file is never submitted to that reviewer, a model provider, or the code runner implicitly.

## Remaining live GitHub gaps

- Launch review supports public repositories only; a private GitHub App installation and token lifecycle are not implemented.
- No production GitHub API, rate-limit, repository-size, force-push, deleted-repository, or network-outage drill is recorded.
- Revision metadata is not automatically reconciled to Git commits, branches, pull requests, or releases.
- Corrected project-review appeals do not automatically perform a new repository analysis; administrator adjudication remains manual.
