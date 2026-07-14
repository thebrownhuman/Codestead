# Security policy

## Supported status

This repository is a private beta under active development. Only the newest reviewed deployment is supported. The project is not ready for untrusted public registration or public code execution.

## Reporting

Report a suspected vulnerability privately to the repository owner. Do not include live API keys, passwords, MFA seeds, recovery codes, session tokens, learner data, database dumps, or exploit payloads containing personal information. Include the affected component, reproduction with synthetic data, impact, and a safe mitigation if known.

Do not test against real learners or production data without explicit authorization. Stop immediately if testing exposes another learner's information, a credential, host access, or runner escape.

## Immediate response

- Revoke any credential exposed in chat, source, logs, screenshots, CI output, or artifacts.
- Isolate a suspected runner or host compromise before collecting evidence.
- Preserve redacted audit identifiers and timestamps; never copy secrets into incident notes.
- Follow [the incident-response runbook](docs/runbooks/incident-response.md).

## Baseline boundaries

The web application must not execute learner code. Code runs only through the authenticated runner boundary on a separate VM, inside disposable no-network containers with immutable reviewed images. Production authentication is fail-closed, provider credentials are envelope-encrypted, plaintext key reveal is recent-MFA/reason/audit/notification gated, uploads remain unavailable until clean scanning, and no service port is published through the home router.
