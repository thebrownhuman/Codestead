# Codestead mentor context policy

Codestead prompt `buddy-tutor-v3` uses context policy `tutor-context-v2`. PostgreSQL remains authoritative. Context is assembled for the authenticated learner and current skill at request time; the model cannot write mastery, misconceptions, summaries, or thread history.

## Included categories and provenance

| Category | Source and owner boundary | Hard cap |
|---|---|---:|
| Goals and preferences | The authenticated learner's `learner_profile`: display name, learning goals, selected tracks, session/weekly-goal preferences, analogy preference, and confirmed interests | 8 goals × 240 characters; 12 tracks; 5 interests × 160 characters |
| Current-skill mastery | Latest `concept_mastery` row for the authenticated learner, selected concept, and preferred language facet; an absent row is explicitly represented as unseen with zero mastery/confidence | One concept row |
| Active misconception tags | At most the newest valid deterministic/verified `mastery_evidence` rows for that exact learner/enrollment/concept/language facet; the deterministic remediation engine decides which tags remain active | 40 evidence rows; 8 tags × 64 characters |
| Weekly summary | Latest stored `email_outbox` `weekly-summary` text for the authenticated learner | 2,000 characters |
| Resumed-thread tail | User/assistant messages from the selected thread only when it belongs to the learner and is active | At most 6 messages; 1,200 characters each; 4,800 characters total |
| Curriculum grounding | Server-selected authored course version, lesson, objective, and current concept | Current course/lesson only |

A new thread receives no raw thread messages. A resumed thread receives only the small selected-thread tail above; Codestead never loads every conversation or a cross-owner/archived thread. Archive/reopen and the tutor append transaction independently enforce the same owner/status boundary.

All stored learner, summary, interest, goal, and chat strings are redacted for common provider/AWS/Slack/JWT/generic credential and hidden-evidence patterns, length-bounded, JSON encoded, and placed in one `user`-role `UNTRUSTED_CONTEXT_DATA` envelope. The system prompt tells the model to treat every field as data rather than instructions. Stored assistant text is not replayed as an assistant-role instruction. The immediate learner message is separately user-role, sanitized once before both provider transmission and persistence, and the UI replaces its optimistic copy with the accepted sanitized value. A visible notice tells the learner when redaction occurred.

Every successful model call stores a content-free manifest containing the exact included category names, reviewed provenance labels, hard caps, prompt/context versions, and exclusions. Learners can inspect that safe manifest and provider/model/credential source on the response. The manifest never stores raw context values.

Explicit exclusions are email address, provider credentials or credential IDs, hidden tests/reference answers/grading keys, other learners, unbounded chat history, and administrator mentor evidence. Formal-exam capability gates run before tutor request parsing or memory access.

## Provider-call replay safety

Every tutor POST requires a client-generated UUID. After the current learner message is sanitized, the server hashes a canonical projection of course, skill, sanitized message, and selected thread. PostgreSQL then claims one receipt scoped to the authenticated learner, `tutor.post`, and that UUID before rate-limiting or provider work.

- An exact first request performs the provider call and application writes once, stores the final safe JSON status/body, and only then returns HTTP.
- An exact concurrent retry waits for the first receipt and receives the same stored response. A retry after a lost HTTP response also receives that response without another provider call, fallback-token reservation, model-call row, thread, or message pair.
- Reusing the UUID with a different canonical payload returns `409 IDEMPOTENCY_KEY_REUSED` before curriculum, credential, or provider work.
- A receipt left in `processing` by an indeterminate process/database failure never authorizes an automatic duplicate provider call. Exact retries eventually receive a retryable `503` and require operator diagnosis.

The receipt contains no credential or unsanitized request value. Its tutor response copy follows the same 12-calendar-month purge boundary as raw tutor chat. The client retries only an indeterminate transport failure, once, with the byte-equivalent payload and UUID; provider/application error responses are not blindly retried.

## Current summary limitation

Launch 1 does not yet have a dedicated, versioned per-thread or per-skill summary-generation worker. Codestead uses the latest already-stored weekly-summary text when one exists; otherwise the summary category is omitted. Therefore summary freshness and topic specificity are not guaranteed. Deterministic mastery/misconception rows and the bounded selected-thread tail still work without a summary or any AI provider.
