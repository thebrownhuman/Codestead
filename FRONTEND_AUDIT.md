# Frontend production-readiness audit

Audited revision: 73951e68a3307a9967589358c5646bd3a61c402c
Branch at audit start: main
Audit date: 2026-07-22
Disposition: REQUEST CHANGES

## Scope and method

This was a read-only static audit of the React/Next.js frontend, CSS, accessibility behavior, browser durability, authentication and onboarding, upload-disabled pilot behavior, formal exams, CodeLab, tutor/chat, and associated unit and browser-test source.

The approved NUC deployment design, assessment policy, requirements matrix, release audit, and UI/accessibility rubric were treated as authoritative. No source files were changed by the audit lane, no server was started, and no test result is claimed by this report. All findings refer to the exact audited Git object above, not later working-tree edits.

No P0 issue was found. The audited revision is not ready for learner invitations or production formal exams.

## P1 release blockers

### EXM-RECOVERY-ID-001 — Recovered autosaves can reuse an idempotency ID with changed input

- Evidence: src/lib/exams/use-durable-exam-outbox.ts:1206-1210 retains clientMutationId while rebasing, and :1364-1370 can change the base revision of a recovered record. src/app/api/exams/_lib/service.ts:1241-1251 rejects the same ID with a different revision or body.
- Impact: after response loss, a crash, and a later save from another tab, reopening can produce AUTOSAVE_IDEMPOTENCY_MISMATCH and block submission instead of presenting a conflict.
- Required fix: replay recovered requests byte-identically. If authoritative state has advanced incompatibly, create a conflict; Keep local must issue a fresh UUID against the current revision.
- Proving test: persist mutation M at revision 0, retain its original receipt, advance the server to revision 2, reopen, and prove no altered M is sent. The conflict choice must send a new ID.

### EXM-LOCK-FAILOPEN-001 — Closed-book assistance remains available while exam state is unknown

- Evidence: src/components/shell/exam-lockdown-overlay.tsx:94-102 maps malformed/failed reads to unavailable; :152-179 returns without establishing a lock; :188-239 renders no boundary when lock state is absent. The current unit test at src/components/shell/__tests__/exam-lockdown-overlay.test.tsx:204-218 explicitly permits an initially unlocked 503.
- Impact: a lesson, tutor, visualizer, or practice page already open in another tab remains usable whenever exam status cannot be verified.
- Required fix: model checking, verified-unlocked, and verified-locked states separately. Assistance must be inert while status is unknown, but drafts must not be purged until an active exam is authoritatively confirmed.
- Proving test: pending/503 shows a cannot-verify boundary and inert content without deletion; later no-active unlocks; active purges the scoped local data and remains locked.

### AUTH-ENROLL-GOOGLE-MISSING — Approved Google enrollment is absent

- Evidence: docs/requirements-matrix.md:19-22 and docs/ux-flows.md:85-89 describe invitation-bound Google or password enrollment. src/components/auth/activation-form.tsx:31-75 implements only name/password. src/components/auth/login-form.tsx:139-150,199-200 always presents Google even if the provider is disabled.
- Impact: the claimed enrollment path is unavailable, while an unconfigured provider produces a dead control.
- Required fix: either implement an invitation-token-bound OAuth enrollment whose verified email matches the invitation, or explicitly defer Google for the pilot and capability-gate every Google control and claim.

### AUTH-VERIFY-RESEND-MISSING — Expired or lost verification mail strands an activated account

- Evidence: src/lib/auth.ts:69-80 gives the verification link a one-hour lifetime and sends only during signup. src/components/auth/activation-form.tsx:63-65 consumes the invitation and provides no resend. src/components/auth/login-form.tsx:117-123 has no recovery action for unverified login.
- Impact: a delayed, suppressed, or deleted message permanently blocks the activated account.
- Required fix: add an enumeration-safe, rate-limited resend action in activation-success and unverified-login states.

### AUTH-MFA-LOST-FACTOR-NO-RECOVERY — No executable recovery exists after both factors are lost

- Evidence: src/components/auth/two-factor-form.tsx:85-95 offers only TOTP or a saved recovery code plus unactionable administrator text. src/app/lost-device/page.tsx:8-10 explicitly does not reset MFA. docs/release-audit.md:62,77 records the gap.
- Impact: a learner or the sole administrator can become permanently locked out.
- Required fix: an audited identity-confirmation workflow must revoke the old factor and sessions, require fresh administrator MFA and a reason, notify the learner, and force new enrollment.

### AUTH-ACCESS-FRESH-MFA-DEAD-END — Access decisions cannot recover from an expired MFA window

- Evidence: approval/rejection routes require fresh MFA at src/app/api/admin/access-requests/[id]/approve/route.ts:23-35 and reject/route.ts:25-37. src/components/admin/access-request-queue.tsx:65-126 only displays the denial.
- Impact: a normal long-lived administrator session cannot approve invited learners without an undocumented re-login workaround.
- Required fix: preserve the pending decision, collect a TOTP, call /api/security/fresh-mfa, then submit the action.

### ONB-COMPLETED-STATE-DEAD-END — Completed setup can still demand another provider secret

- Evidence: src/components/onboarding/onboarding-wizard.tsx:160-180 ignores nimActive when selecting the step. The key becomes active before the separately fallible completion request at :411-420, while :541-550 always requires a new key.
- Impact: a lost completion response or reload can force unnecessary secret replacement.
- Required fix: if all requirements already hold, present a key-free idempotent completion retry or complete automatically.

### ONB-MFA-MANUAL-KEY-MISSING — Mandatory MFA promises but does not render manual setup

- Evidence: src/components/onboarding/onboarding-wizard.tsx:189-194 treats QR generation failure as terminal. The instructions mention manual entry, but :532-537 renders only QR/spinner states.
- Impact: users unable to scan the QR, including users relying on nonvisual workflows, cannot finish mandatory setup.
- Required fix: expose a keyboard-accessible, copyable manual URI/key with secret-handling guidance and a QR retry.

### FE-A11Y-FOCUS-001 — Component CSS defeats the shared keyboard focus indicator

- Evidence: src/components/projects/module-projects.module.css:13-15 sets outline:0. Auth and onboarding use very low-alpha rings at src/components/auth/auth.module.css:116-117 and src/components/onboarding/onboarding.module.css:25-27, overriding src/app/globals.css:260-263.
- Impact: keyboard and low-vision users can lose position in core enrollment and learning controls.
- Required fix: remove outline suppression and use opaque theme-aware focus tokens with at least 3:1 adjacent contrast.

### FE-A11Y-EXAM-MODAL-002 — Exam cleanup overlay has broken focus containment

- Evidence: src/components/shell/exam-lockdown-overlay.tsx:124-150 retains the same exam identity across pending/ready states, but the focus effect at :188-192 does not depend on cleanup state. Pending/error surfaces are not focusable, and :194-215,241-293 does not inert every external focus target.
- Impact: focus can remain in inert content or escape the closed-book modal.
- Required fix: use the shared ModalDialog or implement equivalent focus, trapping, state-transition refocus, sibling inerting, Escape behavior, and restoration.

## P2 significant issues

| ID | Finding | Key evidence / required direction |
|---|---|---|
| DRAFT-RETRY-TIMEOUT-001 | Blackholed draft GET/PUT can remain pending forever and recovered content stays read-only. | src/lib/drafts/use-synced-draft.ts:333-384,642-654,774-809. Add bounded request timeouts and allow IndexedDB-hydrated editing while reconciliation continues. |
| EXM-SUBMIT-EVENT-FLUSH-001 | Manual submit can purge unacknowledged integrity events. | src/lib/exams/use-durable-exam-outbox.ts:1899-1923,2097-2103,2304 and src/components/exams/timed-exam-client.tsx:400-437. Drain or atomically submit events before terminal purge. |
| EXM-EVENT-TIME-001 | Replayed exam events lose original occurrence time. | use-durable-exam-outbox.ts:750-775,1646-1650; events route:10-14; service.ts:1424-1444. Preserve bounded clientOccurredAt beside authoritative receivedAt. |
| EXM-RECONNECT-STATUS-001 | Connected reflects navigator.onLine, not Codestead reachability. | timed-exam-client.tsx:339,477-510,670-671. Show Checking until an immediate heartbeat succeeds. |
| AUTH-ACCESS-REQUEST-EMAIL-PROOF | Unverified addresses can reach the approvable queue. | access request route:20-67 and access-request-queue.tsx:157-165. Require mailbox proof before approval. |
| AUTH-ONE-DEVICE-ERROR-OPAQUE | Expected second-device denial is rendered as a provider/internal error. | login-form.tsx:117-123,197-202. Translate to the one-device policy with a contextual lost-device action. |
| ACCOUNT-SETTINGS-PLACEHOLDERS | Settings contains a hard-coded profile and inert Save action. | settings-view.tsx:453; authoritative profile editor is in community-view.tsx:56-164. Remove or connect it to real isolated state. |
| UPLOAD-STATE-MODEL-001 | File API failure can display pilot-disabled and loading simultaneously; revision flow ignores uploadsEnabled. | file-library.tsx:41-57,136-166 and project-revision-dialog.tsx:85-104,220-229. Model loading/error/enabled/disabled separately. |
| FE-A11Y-LANDMARK-003 | Skip targets are missing on some public routes and learning routes nest main landmarks. | root layout.tsx:37; certificate-verifier.tsx:13; public-portfolio-view.tsx:12; app-shell.tsx:390; lesson/exam components. Guarantee one main#main-content. |
| FE-MOTION-PREFERENCE-001 | Explicit reduce-motion does not control visualizer autoplay or root smooth scrolling. | accessibility-preferences.ts:116-135; lesson-workspace.tsx:163-182; globals.css:155-163,439-459. Centralize resolved preference. |
| FE-LESSON-FALLBACK-001 | Production-visible draft lesson controls can be inert or unlabeled. | lesson-workspace.tsx:150-198. Wire or truthfully disable analogy controls and label/announce fallback quest state. |
| FE-A11Y-CHAT-LIVE-001 | Loading history can announce the full tutor transcript. | tutor-view.tsx:204-263,566-581. Keep history outside the live region and announce only new replies. |
| FE-A11Y-NOTIFY-004 | Notification dialog lacks initial focus, focusout dismissal, and restoration lifecycle. | notification-menu.tsx:67-83,112-138. Implement a coherent nonmodal-dialog or disclosure pattern. |
| FE-A11Y-CONTRAST-005 | Auth placeholder text is about 3.3:1 in light mode. | auth.module.css:116 and global surface tokens. Use an opaque semantic color with at least 4.5:1. |
| FE-A11Y-TOUCH-006 | Persistent admin/notification actions are 34–36px despite the 44px contract. | globals.css:35; admin.module.css:8-10; app-shell.module.css:443-450. Apply the shared minimum target size. |

## P3 maintainability

### FE-CSS-TOKEN-007 — Undefined semantic tokens silently invalidate declarations

Undefined --shadow-soft, --shadow-strong, --line-strong, and --warning references appear in source.module.css, community-spaces.module.css, learner-dashboard.module.css, product-pages.module.css, and lesson-workspace.module.css. Define them in every theme or replace them with existing tokens, and add a custom-property reference check.

## Confirmed strengths

- The responsive shell uses inert, aria-hidden, focus wrapping, Escape, restoration, landmarks, route-change focus, and safe-area-aware navigation.
- ModalDialog provides reusable trapping, sibling isolation, Escape behavior, and restoration.
- Light, dark, high-contrast, and forced-colors token coverage is broad.
- Route loading, error, not-found, retry, and empty states generally use appropriate semantics.
- CodeLab retains input/source on runner failure and distinguishes local from server acknowledgement.
- IndexedDB writes wait for transaction completion, quarantine malformed records, and use compare-and-delete acknowledgement.
- Normal exam autosave persists before send, reuses stable IDs, exposes conflicts, and delays terminal UI until scoped cleanup.
- Tutor send failure restores the message and preserves a safe explicit-retry identity.
- CI contains a dedicated authenticated browser verifier in addition to the general Playwright matrix.

## Unverified

- No build, lint, unit, integration, Playwright, Axe, or persistent-browser command was executed by this audit lane.
- No manual screen-reader, keyboard-only native browser, 200–400% zoom, switch-control, or physical iOS session was performed.
- Google OAuth, Gmail, secure-cookie, TOTP recovery, one-device, private-mode/quota, blackholed-network, BFCache, multi-tab, and clock-change behavior remain unverified.
- NUC, KVM runner, Cloudflare, PostgreSQL recovery, and real offline/reconnect behavior are outside this static report.
