# Learner guide

Codestead is an invite-only learning workspace. Its authored lessons, deterministic assessments, progress, and code execution continue to work when the optional AI mentor is unavailable.

## Join and secure the account

1. Request access with the email address the administrator knows.
2. Open the single-use approval link, verify the email, and create a password or link the approved Google account.
3. Set up TOTP MFA and save recovery codes offline.
4. Complete the learning profile, review every required disclosure, confirm how your free-text interests were categorized, and choose whether analogies and cohort sharing are enabled.
5. Add and test your own NVIDIA NIM key. The app masks it after saving and never places it in browser storage, chat, exports, or logs.

## Learn

- The roadmap enforces prerequisites. You can add tracks later; changing the DSA implementation language keeps conceptual evidence but retests syntax-specific skills.
- Lessons use a canonical technical explanation first. Confirmed-interest analogies are optional and always include their limits.
- Learn and Practice modes allow unlimited fresh attempts. **Show next help** reveals one server-recorded hint, alternate explanation, or example at a time; a reviewed solution is always the final recorded help step.
- Help is saved before it appears. Revealed or assisted answers help you learn but do not prove mastery, even if a browser request falsely claims no help was used.
- **I don’t know** is a valid saved response and leads to deterministic feedback/remediation. Incorrect attempts remain private history; **Try a fresh question** retries without erasing them.
- Topic quests are replayable and server-checked, but replay does not farm mastery, badges, exam credit, or unlimited XP.
- The visualizer provides a text/state representation plus step, play/pause, and restart controls. Reduced-motion preferences are respected.

## Assessments and exams

- Formal coding exams require desktop or tablet. The server owns the timer, autosave, form, hidden tests, and final result.
- Compile/Run shows raw compiler/runtime output. Hidden tests run only on Submit.
- Closed-book exams disable the tutor, notes, documentation, web help, games, and visualizer. Focus/paste/fullscreen events may be logged for human review but do not automatically mean misconduct.
- A score below 80%, or below 70% in a critical cluster, requires remediation. Scores from 80–94% pass; 95% plus every critical coding requirement earns mastery.
- If the connection drops, the timer continues and the latest autosave is preserved. Report a material outage to request an equivalent re-exam.

## Projects, profiles, and disputes

- The project coach may help with ideas, PRDs, architecture, milestones, rubrics, tests, and Socratic hints. It must not complete a project for you.
- Launch review supports public GitHub repositories pinned to an exact commit. Never upload secrets.
- Cohort profile, leaderboard, badges, and selected projects are opt-in/visibility-controlled; exam failures, raw hours, private scores, code, chat, and hint dependency are not public.
- Codestead mentor conversations are stored on the server under your account. You can resume, archive, or reopen them from the conversation list. Archived threads are read-only until reopened, and each assistant message identifies the provider, model, key source, and exact safe context categories/provenance/caps used. A new conversation receives no raw history; a resumed conversation may use only the last six messages from that selected active thread. Conversation state and API keys are never stored in browser storage. See [Codestead mentor context policy](tutor-context.md).
- If a stored project review appears wrong, use **Appeal review** beside that exact commit. The app preserves the original commit, analyzer, and findings; one appeal can remain open per review. The administrator decides, no AI decides the claim, and submission never runs or rewrites the repository automatically.

## Sessions, privacy, and help

- One browser profile can be active at a time, with multiple tabs allowed. If a device is lost, submit a revocation request and contact the administrator for identity confirmation.
- Privacy settings let you withdraw future provider routing, fallback, cohort, or leaderboard consent. Withdrawal does not rewrite legitimate historical evidence.
- Use the data controls to request an export. Only the administrator can delete the account; primary data is removed and backup expiry is reported truthfully under the retention schedule.
- If a key was ever pasted into chat, a screenshot, or source code, revoke it at the provider and add a new one. See [troubleshooting](troubleshooting.md) for safe recovery steps.
