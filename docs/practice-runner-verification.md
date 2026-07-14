# Practice runner verification

CodeLab is a visible-practice surface, not an assessment or mastery surface. Its request goes to the application server; browser code never talks directly to the runner and never supplies limits, tests, runtime versions, entrypoints, user identity, attempts, scores, or evidence decisions.

## Request and execution boundary

`POST /api/code/run` accepts only:

- `language`: C, C++, Java, Python, or JavaScript;
- bounded `source` and optional bounded `stdin`;
- optional `skillId` as practice context;
- `mode`: `compile` or `quick_run`;
- optional UUID `clientRequestId` for runner idempotency.

The strict schema rejects additional properties. Authentication, the server-authoritative closed-book capability gate, and the per-user minute/hour limit run before source persistence. Current server-execution consent is required. The server selects the runtime, entrypoint, execution mode, and fixed wall/memory/CPU/PID/output/file limits.

Source and its `runner_job` are admitted atomically before the signed remote request as a practice `code_submission` without `attemptId`, `activityId`, or `testBundleId`. Exact request-ID retries reuse that pair and changed-payload reuse is rejected. Practice work remains outside the one-active-official-job learner slot. A signed runner response may update only this operational pair; this route does not write attempts, assessment responses, mastery evidence, achievements, or leaderboard state.

## Browser safety and queue status

The CodeLab banner and console always state that the run cannot award mastery, badges, exam credit, or leaderboard points. While a request is pending, the live output region says it is waiting for one of two isolated slots in a bounded queue. The server response includes only the runner's initial queue state and bounded numeric position for display.

The UI allowlists normalized practice statuses. An injected response such as `status: "mastered"`, `masteryAwarded: true`, or `officialMasteryEvidence: true` is displayed only as `practice_result`; mastery-shaped fields are ignored and trigger no second request or persistence action.

## Verification

Run:

```powershell
npx.cmd vitest run src/app/api/code/run/__tests__/route.test.ts src/components/lesson/__tests__/code-lab-runner.test.tsx src/components/lesson/__tests__/lesson-workspace-interactions.test.tsx
```

The route suite covers anonymous and timed-exam denial, seven strict tamper classes, consent withdrawal, exact Python request construction, unconfigured/throwing/terminal-failure paths, direct completion, queued-to-completed persistence, and the absence of mastery linkage. Component tests cover exact Python request construction, interim/final queue visibility, response tampering, configuration failure, and offline draft preservation.

Machine-readable evidence is in [`docs/evidence/run-002-practice-runner-2026-07-12.json`](evidence/run-002-practice-runner-2026-07-12.json).

## Deliberate limits

- The local tests mock the signed runner client. A deployed browser-to-Next.js-to-runner Python journey is still required.
- Runner response-signature verification is independently unit-tested in `src/lib/runner/__tests__/client.test.ts`, but RUN-002 has no hostile production proxy test.
- Practice output remains saved operational evidence only. Promoting it to assessment or mastery evidence would require a new reviewed server workflow; it must never be inferred from this response.
