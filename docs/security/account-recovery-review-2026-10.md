# Account recovery and password flows: security review (2026-10)

- Reviewer: Opus 8 (Claude Code), 2026-10-21
- Base: `origin/main` @ `1f66c072`, Better Auth `1.7.6`
- Scope: forgot password, reset callback and reset, password change (voluntary and forced), MFA recovery (backup codes, lost-device), session revocation after reset/change, auth rate limits, reset email outbox.
- Starting points: PR #187 (`af0e8d63`), PR #150, PR #133/#130 (breached passwords), `src/lib/auth.ts`, `src/app/api/auth/[...all]`, `src/app/api/security/*`, `src/app/api/lost-device/*`, `src/lib/security/{auth-rate-limit,rate-limit,password-change}.ts`, `src/lib/notifications/{revocable-source-authority,templates}.ts`, `node_modules/better-auth/dist/api/routes/password.mjs`.
- Method: code reading only. Nothing was run against a live deployment, and no timing was measured.

## Summary

| ID | Severity | Title |
|----|----------|-------|
| M1 | Medium | Reset-request timing reveals which emails have accounts |
| M2 | Medium | Reset request is limited per IP only; no per-email budget, and a shared `unavailable` bucket |
| M3 | Medium | Successful password reset writes no audit event and sends no "password changed" notice |
| L1 | Low | Reset tokens stored in plaintext in `verification` |
| L2 | Low | Reset token stays in the page URL and browser history |
| L3 | Low | Reset goes to any account state and silently adds a password to Google-only accounts |
| L4 | Low | Password change shares one bucket with forced change and needs no fresh MFA |
| I1 | Info | Trusted-device (24h) records are not explicitly cleared on reset/change (needs check) |

**No High or Critical findings.** Email-only compromise cannot take over an MFA account: reset revokes sessions, but sign-in still requires TOTP or a backup code, and lost-device recovery only opens an admin review.

## What is already solid

- **Raw Better Auth surface is default-deny** (`src/lib/security/better-auth-management-policy.ts:7-58`). `/two-factor/disable`, `/generate-backup-codes`, `/change-email`, `/update-user`, `/change-password` and the rest return 403 at the raw route, so recovery cannot be used to strip MFA or change the email. No email-change flow exists.
- **Reset token**: `generateId(24)` (about 143 bits), 1h default expiry, consumed atomically through `consumeVerificationValue` (in-process lock, transaction, `consumeOne`), so two concurrent `/reset-password` calls cannot both succeed (`password.mjs:150-152`).
- **Redirects**: `originCheck` covers `redirectTo` and `callbackURL` (`password.mjs:49,96`) against `trustedOrigins = [APP_URL]` (`auth.ts:87`). The reset email URL is checked again before enqueue: exact origin, exact path, only `callbackURL`, no userinfo or fragment (`revocable-source-authority.ts:224-240`). No open redirect found.
- **Session revocation**: `revokeSessionsOnPasswordReset: true` (`auth.ts:98`), session cookie cache disabled (`auth.ts:169-174`), and `changePassword` is called with `revokeOtherSessions: true` (`password-change.ts:33`). The forced change clears the session cookies (`forced-password-change/route.ts:42-50`).
- **No error oracle**: a failing `sendResetPassword` is caught by `runInBackgroundOrAwait` and logged, so the response is still the neutral success. The UI copy is identical for known and unknown emails (`password-recovery-forms.tsx:68-69`). Lost-device keeps a byte-identical neutral response even on failure (`lost-device/request/route.ts:46-55`).
- **Leakage controls**: `Referrer-Policy: strict-origin-when-cross-origin` (`next.config.ts:49`). Error monitoring strips query strings and long path segments (`error-monitoring.ts:30-52`). The reset email is bound to a revocable verification id (`auth.ts:100-121`).
- **Backup codes**: the raw sign-in path has a 6/min per-IP limit, and step-up `verify-backup-code` has a per-user limit (`fresh_mfa_user` 10/15min) and audits every outcome (`verify-backup-code/route.ts:21-65`).

## Findings

### M1 (Medium): reset-request timing reveals which emails have accounts

- **Where:** `node_modules/better-auth/dist/api/routes/password.mjs:59-88`; `src/lib/auth.ts:99-123`
- **Issue:** for an unknown email, Better Auth makes one dummy `findVerificationValue` read and returns. For a known email it creates the verification row, then **awaits** `sendResetPassword`: `loadResetPasswordVerificationSource` (another query) plus `enqueueEmail` (an outbox insert). No `advanced.backgroundTasks.handler` is set, so `runInBackgroundOrAwait` awaits all of it in the request.
- **Exploit:** an attacker sends `POST /api/auth/request-password-reset` for a list of candidate emails and compares median latency (several samples per email from rotated IPs; the IP budget is 3 per 10 min). Known pilot accounts answer measurably slower (two or three extra DB round trips). That leaks who is in the private pilot, which helps targeted phishing.
- **Fix:** take the work off the response path. Set `advanced.backgroundTasks.handler` (for example a tracked `void promise` with error logging), or enqueue to the outbox only from a deferred job. Alternatively pad both branches to a fixed floor (for example 400 ms plus jitter) in a `hooks.before`/`after` for `/request-password-reset`. Add a test that runs both branches through the same code path.

### M2 (Medium): reset request is limited per IP only

- **Where:** `src/lib/security/auth-rate-limit.ts:8-10, 29-34`
- **Issue:** `/request-password-reset` has only `auth_reset_request_ip` (3 per 10 min). There is no per-email budget, unlike lost-device (`lost_device_request_email`, 3/day, `lost-device/request/route.ts:40-44`). When `cf-connecting-ip` is missing or invalid, every request shares one `"unavailable"` bucket.
- **Exploit:** (a) Email flooding: with rotating IPs an attacker can send unlimited reset emails to one learner, which buries a real alert and burns outbox and provider reputation. Each request also creates a new live token, so more valid tokens exist at once. (b) If the origin is ever reachable without Cloudflare (for example a tunnel misconfig or a direct LAN/NUC port), requests without the header all share `"unavailable"`, and 3 requests lock password recovery for everyone for 10 minutes.
- **Fix:** add `auth_reset_request_email` (for example 3 per 24h, keyed by lowercased email, applied even when the user does not exist so the limit does not leak existence). Return the same neutral 200 when this budget is exhausted, not 429, so the limit cannot become an oracle. Optionally invalidate earlier reset tokens for the user when a new one is issued. Treat a missing client IP as a server misconfiguration: fail closed with a 503 and log it, instead of using a shared bucket.

### M3 (Medium): successful reset writes no audit event and sends no notice

- **Where:** `src/lib/auth.ts:93-124` (no `onPasswordReset`); compare `password-change.ts:22-55`, which audits every outcome
- **Issue:** the only trace of a reset is the `password_reset` end reason on archived sessions (`auth.ts:372-373`). Nothing goes to `audit_event`, and the user gets no "your password was changed" email. Voluntary and forced change also send no notice.
- **Exploit:** an attacker with temporary mailbox access (a shared inbox, or a forwarding rule) resets the password and deletes the reset email. The learner sees only "signed out", and the admin has no audit row for incident review. MFA still blocks sign-in, but the reset itself (forced sign-out, password known to the attacker for any later TOTP phishing) goes undetected.
- **Fix:** add `emailAndPassword.onPasswordReset` that writes `writeAuditEvent({ action: "account.password_reset", outcome: "success", ... })` and enqueues a new `password-changed` template (no link, with a "contact the administrator" lead). Send the same notice after a successful `changeAccountPassword` and forced change. Also audit invalid or expired token use on `/reset-password` (hooks.after on an error status) without logging the token.

### L1 (Low): reset tokens stored in plaintext

- **Where:** `src/lib/auth.ts` (no `verification.storeIdentifier`); `password.mjs:75-78` stores `identifier: "reset-password:<token>"`
- **Exploit:** anyone with read access to the DB, a restic snapshot, or a log of SQL parameters can use a live reset token within its 1h window and set the victim's password. (MFA still blocks sign-in, so the impact is forced sign-out and a known password.)
- **Fix:** set `verification: { storeIdentifier: "hashed" }` (Better Auth 1.7 supports it; `consumeVerificationValue` already tries the hashed and plain forms, which covers migration). Check that `loadResetPasswordVerificationSource` matches the hashed identifier, and update its test.

### L2 (Low): reset token stays in the page URL

- **Where:** `password.mjs:127` redirects to `/reset-password?token=…`; `src/app/reset-password/page.tsx:17-24` reads it from `searchParams`
- **Exploit:** the token sits in browser history, sync, and any screenshot or screen share until the reset is used or expires. Same-origin navigations from the page send the full URL as Referer (cross-origin gets only the origin). It is single-use and 1h, so the window is small.
- **Fix:** after hydration, `history.replaceState(null, "", "/reset-password")` and keep the token in component state. Mark the page `noindex` and send `Cache-Control: no-store`. Optionally set `Referrer-Policy: no-referrer` for `/reset-password`.

### L3 (Low): reset ignores account state and adds a password to Google-only accounts

- **Where:** `password.mjs:59` (`findUserByEmail`, no status filter), `password.mjs:155-160` (`createAccount` when there is no credential account); conflicts with `password-change.ts:24-27` ("Signed in with Google; manage your password at Google")
- **Issue:** pending or suspended users still get reset mail. For a Google-only learner, a reset quietly creates a credential password, which adds a second, email-controlled way in that policy elsewhere says does not exist. The form copy ("If that approved account exists") suggests a status filter that is not there.
- **Fix:** in `sendResetPassword`, skip the enqueue (but keep timing neutral, see M1) unless `status === "active"` and a credential account exists. Optionally block `/reset-password` in a `hooks.before` when the user has no credential account.

### L4 (Low): password change bucket and step-up

- **Where:** `src/app/api/security/change-password/route.ts:19`, `forced-password-change/route.ts:25` (both use `forced_password_change_user` at 6/min); `password-change.ts:30-33`
- **Issue:** someone holding the session can guess `currentPassword` 6 times a minute (about 8.6k a day) with no lockout, and no fresh MFA is required to rotate the password and revoke other sessions. The two flows also share one budget.
- **Fix:** give voluntary change its own policy (for example 5 per 15 min per user, plus a daily cap), audit repeated `denied` outcomes, and consider requiring fresh MFA (`mfaVerifiedAt` within 5 min, like the `fresh-mfa` route) before `changePassword`.

### I1 (Info): trusted-device records after reset/change

- **Where:** `auth.ts:386-388` (`trustDeviceMaxAge` 24h); Better Auth twoFactor trust-device records
- **Note:** `deleteUserSessions` and `revokeOtherSessions` remove sessions. It was not confirmed that the twoFactor trust-device record or cookie is invalidated too. If it is not, a device that held a stolen trust cookie skips TOTP for up to 24h after a reset, but only if it also has the new password. Check this with a test, and if the records survive, delete them in `onPasswordReset` and after a password change.

## Not found / not applicable

- No email-change, MFA-disable, or backup-code-regeneration endpoint is reachable (raw routes denied).
- No race on token consumption (atomic consume).
- No reset token found in application logs: Better Auth logs "User not found" without the email; error monitoring scrubs the query and path. Infra access logs (Cloudflare tunnel, reverse proxy) will record `GET /api/auth/reset-password/<token>` paths; keep their retention short.

## Suggested follow-up order

M2 (per-email budget and the shared bucket), then M3 (audit and notice), then M1 (timing), then L1, L2, L3, L4, then the I1 test. Each is a small, separate PR.
