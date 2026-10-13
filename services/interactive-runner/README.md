# Interactive runner broker (PR 1b)

Default OFF: `INTERACTIVE_RUNNER_ENABLED=true` must be set on both the app and
broker. Otherwise every interactive HTTP route and WebSocket upgrade returns
404. Next remains the existing standalone HTTP server; this separate Node/ws
service owns upgrades. There is no UI, shell, PTY or graded execution here.

`POST /api/code/interactive` accepts only `{mode:"practice",language,source}`.
The app authenticates the durable session/account/MFA state, requires the exact
canonical APP_URL Origin, current server-execution consent, and the existing
10/minute + 120/hour runner rate policies. Source is limited to 131,072 UTF-8
bytes; exam/attempt/grade fields, caller limits and batch stdin are rejected.
It reserves one of two independent interactive slots and returns a 30-second,
single-use grant, sessionId, socketPath and protocol. Pending grants also count
toward the two-slot pool and the one-session-per-user limit.

The future browser opens socketPath at the same origin with subprotocols
`["codestead-interactive-v1","grant." + grant]`. The grant is never a URL query
parameter. Upgrade checks exact Origin/Fetch-Site, cookies, and the grant; then a
short-lived signed private request asks the app's owner-bound authorize route to
re-read the durable session. A grant cannot cross users or login sessions.
The broker sends no browser cookies, grants or auth headers to Piston.

Browser messages: `{type:"data",stream:"stdin",data}`, `{type:"eof"}`,
`{type:"stop"}`, or `{type:"signal",signal:"SIGINT"}`. Stdin Ctrl+C cancels.
Only nonempty accepted run-stage input resets the 60-second idle deadline;
program output, empty input, EOF and WebSocket pings do not. Total reservation
wall time is at most five minutes. Fixed Piston policy keeps 3-second run CPU,
128 MiB run memory, 10-second/512 MiB compilation, 65,536-byte combined output
and 16,384-byte cumulative input. Frame/send queues are bounded and compression
is off. Disconnect/dead-peer/Stop/limits cancel the entire upstream job.

Broker cancellation sends Stop and waits for the patched Piston connection to
close after sandbox cleanup. It does not release a slot or acknowledge an exam
barrier on transport loss or cleanup failure. Ambiguous capacity is quarantined
until operator restart; exam admission fails closed. The app rechecks active or
paused exams and durable auth every ten seconds as a secondary boundary.

Create and upgrade authorization acquire the existing user-authority PostgreSQL
transaction lock. Formal exam and mastery-recheck admission acquire that same
lock before any narrower admission lock, cancel pending/running interactive work,
and require the broker cleanup acknowledgement before committing the active
exam. An exam/upgrade race therefore cannot leave a practice terminal running
inside a closed-book attempt. No migration or durable terminal state is needed;
restart discards grants and closes upstream connections. Batch Piston and its
two slots remain independent.

## Owner-controlled deployment

No command here deploys to the NUC. Build the optional `interactive-runner`
Dockerfile target from the same reviewed source/pinned Node base as the app.
Use the explicit `compose.interactive-runner.yaml` addon together with the
existing image-only `compose.piston-interactive.yaml` addon. Broker limits:
256 MiB RAM, 0.5 CPU, 64 PIDs; interactive Piston remains 2 GiB/2 CPUs/128 PIDs
with two slots and Kata. Existing Compose services and batch network are
unchanged in the base model. The addon adds only app configuration/secret access
and the new broker on frontend + piston-interactive networks; no host ports.

Provision an independent random secret of at least 32 bytes in a file mounted
into app and broker as `/run/secrets/interactive_broker_secret`. Never commit it.
It must be readable by the image's unprivileged node user (UID 1000); keep its
host directory owner-controlled and mount the secret read-only.
Set APP_URL to the exact production HTTPS origin. The private broker URL is
`http://interactive-runner:3100`; the broker revalidates auth via `http://app:3000`.
The example tunnel routing file sends only the same-host socket path to the
broker; all other traffic stays on the app. Do not route `/control` publicly.
Neither broker nor routes log cookies, source, grants, secret bytes or raw errors.

Validation: `npm run test:interactive-runner` exercises the real HTTP upgrade and
WebSocket transport against disposable fake app/Piston peers. Route-unit tests
exercise real handler authorization, flags, consent, exam gates and origin
checks; source contracts pin shared lock/cancellation ordering in both exam
admission paths. Existing image live tests remain mandatory and unchanged.
The Piston image job additionally runs `test-image.mjs` against both actual
images: all five prompt-before-input paths through the broker, trusted batch
execution while both interactive slots are occupied, and disconnect killing a
detached descendant. This harness starts only disposable privileged Docker
containers with private cgroups and cleans up its own containers; production
remains Kata-only. To run locally after both image builds:

```sh
node --import tsx services/interactive-runner/test-image.mjs codestead-piston-interactive:review codestead-piston:interactive-base
```
