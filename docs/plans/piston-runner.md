# Piston code runner: Phase A spike results and plan

Status: Phase A spike done on 2026-10-01 (local Docker Desktop, Windows host, WSL2 kernel, cgroup v2).
**Decision (owner, 2026-10-01): Piston runs under Kata Containers** on the NUC, without
`--privileged`. See "Decision: Kata Containers" below; the VM and gVisor options were dropped.

## What was tested

- Piston image `ghcr.io/engineer-man/piston@sha256:2f66b7456189c4d713aa986d98eccd0b6ee16d26c7ec5f21b30e942756fd127a`
  (the newest published build, created 2025-02-08). Runtimes from the official package repo:
  gcc 10.2.0 (c, c++), java 15.0.2, python 3.12.0.
- Our runner: `DockerJobExecutor` from `services/runner` called directly (no HTTP/HMAC/queue overhead),
  using runtime images built from `services/runner/runtime/Dockerfile` with the pins in `images.env`
  (GCC 14.2.0, Java 21.0.12, Python 3.14.7). Limits for both: 256 MB memory, 1 CPU, 32 pids (ours) /
  64 processes (Piston default), 5 s job wall time (ours) / 3 s run + 10 s compile (Piston).
- Same seven programs per language: hello world, CPU loop, stdin echo, compile error, infinite loop,
  memory bomb, and fork bomb (a thread bomb for Java). Hello and echo ran 10 times; the rest ran twice.

## Benchmark (milliseconds, end-to-end client latency)

`first` is the first call in the series. Our runner is always cold: it starts a fresh container for
compile and another for run. Piston started from a restarted container answered Python in 258 ms
and Java in 479 ms, so its cold start is close to warm.

| Lang | Program | Ours first / p50 / p95 | Piston first / p50 / p95 | Ours result | Piston result |
|---|---|---|---|---|---|
| C | hello | 1127 / 877 / 1290 | 146 / 93 / 146 | ACCEPTED, exit 0 | OK, exit 0 |
| C | cpu loop | 1037 | 210 / 221 | ACCEPTED | OK |
| C | stdin echo | 857 / 907 / 1147 | 122 / 83 / 122 | ACCEPTED | OK |
| C | compile error | 432 / 504 | 67 | COMPILE_ERROR | compile stage code 1 |
| C | infinite loop | 5244 / 5467 | 3296 | TIMEOUT | status TO (wall clock) |
| C | memory bomb | 958 / 984 | 206 / 226 | MEMORY_LIMIT, 137 | code 137, status null |
| C | fork bomb | 888 / 931 | 132 | contained (exit 4) | contained, status OL (output cap) |
| C++ | hello | 1356 / 1360 / 1406 | 263 / 232 / 274 | ACCEPTED | OK |
| C++ | cpu loop | 2417 | 321 / 379 | ACCEPTED | OK |
| C++ | stdin echo | 1451 / 1421 / 1638 | 296 / 251 / 521 | ACCEPTED | OK |
| C++ | compile error | 439 | 76 | COMPILE_ERROR | compile stage code 1 |
| C++ | infinite loop | 5243 | 3191 / 3202 | TIMEOUT | TO |
| C++ | memory bomb | 1330 | 308 | MEMORY_LIMIT | code 137 |
| C++ | fork bomb | 943 | 136 | contained | contained |
| Java | hello | 1599 / 1838 / 1920 | 312 / 288 / 563 | ACCEPTED | OK |
| Java | cpu loop | 1956 | 456 / 558 | ACCEPTED | OK |
| Java | stdin echo | 1809 / 1863 / 1948 | 280 / 286 / 404 | ACCEPTED | OK |
| Java | compile error | 851 | 282 | COMPILE_ERROR | **run stage RE, code 1** (no compile stage) |
| Java | infinite loop | 5241 / 5248 | 2718 / 2814 | TIMEOUT | TO |
| Java | memory bomb | 1854 / 1872 | 452 | RUNTIME_ERROR (OutOfMemoryError, exit 1) | code 137 |
| Java | thread bomb | 2043 | 379 / 434 | contained | contained |
| Python | hello | 1187 / 1702 / 2132 | 82 / 36 / 91 | ACCEPTED | OK |
| Python | cpu loop | 4070 / 4363 | 1822 / 2121 | ACCEPTED | OK |
| Python | stdin echo | 1561 / 1125 / 1621 | 56 / 18 / 56 | ACCEPTED | OK |
| Python | syntax error | 585 | 36 | COMPILE_ERROR | run stage RE, code 1 |
| Python | infinite loop | 5337 | 3113 | TIMEOUT | TO |
| Python | memory bomb | 1169 | 149 | MEMORY_LIMIT, 137 | code 137 |
| Python | fork bomb | 1160 | 70 | contained (29 forks) | contained (62 forks) |

Every stdout matched between the two runners. Piston is about 5-20x faster for short programs
because it has no container start per job. Timeouts are bounded by each runner's configured limit.

## Isolation

Probe run as a Python submission inside Piston (isolate sandbox):

- uid/gid 60003, effective capabilities `0000000000000000`.
- Network: connect to 1.1.1.1 gave `ENETUNREACH`; DNS failed. The sandbox has its own empty network namespace.
- Filesystem: `/`, `/etc` and `/piston/packages` are not writable. Only `/tmp` and `/box` (the per-job
  directory) are writable. Root contains only bin, box, dev, etc, lib, lib64, piston/packages, proc,
  tmp and usr. No host mounts are visible.
- PID namespace: 2 processes visible. RLIMIT_NPROC 64. Environment has only PATH/HOME-type variables.
- Limits: wall/CPU time, output size (1024 chars by default) and process count are enforced.
  **Memory is unlimited by default** (`PISTON_RUN_MEMORY_LIMIT=-1`); it must be set.
  `PISTON_MAX_CONCURRENT_JOBS` defaults to 64, which is too high for one NUC.

### Blocker: the outer container must be privileged

Piston's isolate sandbox creates cgroup v2 groups, so the API container needs write access to the
cgroup tree. Without `--privileged` it fails at startup with
`mkdir: cannot create directory 'isolate/': Read-only file system`. These were tried and all failed:
`--cap-add SYS_ADMIN --cgroupns private`, the same plus `seccomp=unconfined` and `apparmor=unconfined`,
`--cap-add ALL`, and a writable tmpfs over `/sys/fs/cgroup` (which gave "Cgroup v2 not found").
The container also runs as root with a writable root filesystem.

Honest comparison with our runner:

| | Our runner (services/runner) | Piston |
|---|---|---|
| Per-submission boundary | Fresh unprivileged container: cap-drop ALL, no-new-privileges, uid 65532, read-only root, `--network none`, pids/mem/cpu/fsize limits | isolate: namespaces + cgroup v2, uid 60003, no caps, no network, read-only root |
| Service process | Needs the Docker socket (root-equivalent), so it is meant for a dedicated runner VM; Bubblewrap containment on the VM guest | **Privileged root container**. An isolate escape lands in a privileged container, which is effectively host root |
| Shared NUC without a VM | Not safe either (Docker socket access) | Not safe: an isolate escape = NUC root |
| Languages | GCC 14.2 (C23), G++ 14.2 (C++20), Java 21, Python 3.14, Node 22 (CI 22.23.1, image 22.23.3) | Official repo: gcc 10.2, java 15, python 3.12. Newer versions need our own package builds |
| Latency | ~0.9-1.9 s per run | ~0.05-0.5 s per run |

Both runners need a VM boundary to be safe on the shared NUC. Piston's own inner sandbox is as good
as ours; the difference is that Piston's outer container is privileged, so it must not run directly
on the NUC next to the 31 other containers and the Codestead database.

## Interface mapping and gaps

Ours: `POST /v1/jobs` (HMAC-v2 signed, idempotency key, async queue, `GET /v1/jobs/:id`) with
`RunnerJobRequest` -> `RunnerResult` (`status`, `compile`, `run`, `tests[]`, `totals`, `imageDigest`).
Callers: `src/app/api/code/run/route.ts`, `src/app/api/exams/_lib/service.ts`,
`src/lib/assessment-corrections/*`, through `src/lib/runner/client.ts` and `practice-dispatch.ts`.

Piston: synchronous `POST /api/v2/execute` with `{language, version, files[], stdin, args,
compile_timeout, run_timeout, compile_memory_limit, run_memory_limit}` -> `{compile?, run}`, each
`{stdout, stderr, code, signal, status, message, memory, cpu_time, wall_time}`.

| Need | Gap | Fix in the adapter |
|---|---|---|
| Auth | Piston has none | Internal network only; app-side adapter is the only caller |
| COMPILE mode | No compile-only call | Run with a no-op main or ignore the run stage; for C/C++ use the compile result |
| TEST mode with hidden tests | One stdin per call | Adapter loops over tests (one call per test, compile each time), compares output app-side; expected output never leaves the app |
| Java/Python compile errors | Reported as run-stage RE, code 1 | Classify by stderr (`error:` from javac, `SyntaxError`) or add a compile step to our own Java package |
| MEMORY_LIMIT vs RUNTIME_ERROR | Memory kill is code 137 with status null | Map 137 + `memory` near the limit to MEMORY_LIMIT |
| OUTPUT_LIMIT | status `OL` | Map directly |
| TIMEOUT | status `TO` | Map directly |
| Idempotency/async jobs/recovery | Synchronous only | Adapter returns the job result directly; practice/exam code needs a synchronous path behind the flag |
| `imageDigest`/runtime provenance | Only `language`/`version` | Record the Piston image digest + package version from config |
| Error bodies | Malformed JSON returns a Node stack trace | Never expose Piston responses to the browser; adapter sends fixed JSON |
| Language versions | gcc 10.2, java 15, python 3.12 | Custom package builds (Piston `packages/` format) for GCC 14, Java 21, Python 3.14, baked into our image |

## Decision: Kata Containers

Measured on a GitHub-hosted KVM runner (Ubuntu 24.04, host kernel 6.17), Kata 4.2.0 runtime-rs with
QEMU, branch `spike/kata-piston`. Kata could not be tested on the Windows laptop: the WSL2 kernel has
no vsock (`ENOSYS`).

What was tried:

| Isolation | Result |
|---|---|
| gVisor (runsc 20260928.0) | **Fails.** isolate needs cgroup v2 (`--in-sandbox-cgroup=v2` plus `--privileged` gets past that), and gVisor has no `io` controller. It also ignores the setuid isolate binary, and finally `Failed to switch FS UID: Function not implemented` (no `setfsuid`). Would need a patched isolate. |
| Kata, `--privileged` | Fails: Docker passes every host device and Kata cannot map them (`get host path failed`). |
| Kata, SYS_ADMIN + NET_ADMIN + cgroupfs remount | **Works.** The capabilities apply to the micro-VM's kernel only. |
| Dedicated VM | Works, but costs a full VM. Dropped by the owner as too heavy. |

Containment, probed from inside a learner submission under Kata:

- Kernel 6.18.35 (guest) on a 6.17 host. `MemTotal` is the VM's 1.45 GB, not the host's 16 GB.
- `/dev` has only `fd full mqueue null ptmx pts random shm std* tty urandom zero`. Plain Docker
  `--privileged` exposes `kvm`, `loop*`, `fuse`, `dri` and more.
- uid 60003, effective capabilities 0, network unreachable, `/`, `/etc` and the packages read-only,
  2 processes visible.
- Memory bombs are killed (exit 137); fork bombs and infinite loops are contained (TO at 3 s).

Cost (host RSS of qemu + shim + virtiofsd; VM sized at 1536 MB, since 1024 MB did not boot Piston):

| | Plain Docker | Kata |
|---|---|---|
| Idle RSS | 198 MB | 446 MB |
| RSS under 2 concurrent jobs | 291 MB | 881 MB |
| C hello p50 | 114 ms | 403 ms |
| Java hello p50 | 488 ms | 988 ms |
| Python hello p50 | 30 ms | 93 ms |

Even under Kata, Piston is faster than the legacy runner (C 877 ms, Java 1838 ms, Python 1702 ms).
`docker exec` into a Kata container does not work in this release, so health checks and debugging go
through the API and `docker logs`.

## Target architecture

- Piston is a compose service (`piston`, profile `piston`, off by default) with
  `runtime: io.containerd.kata.v2`, on its own `internal` network with no egress, no published ports,
  no mounts and no secrets. Packages are baked into the image at build time. Install steps:
  [docs/runbooks/piston-kata.md](../runbooks/piston-kata.md).
- The app reaches Piston only through a server-side adapter behind `/api/code/run` (existing route),
  with session auth, per-user rate limits, and source/stdin/test size caps. The browser never calls Piston.
- Piston env: `PISTON_RUN_MEMORY_LIMIT=268435456`, `PISTON_COMPILE_MEMORY_LIMIT=536870912`,
  `PISTON_MAX_CONCURRENT_JOBS=2`, `PISTON_OUTPUT_MAX_SIZE=65536`, `PISTON_DISABLE_NETWORKING=true`,
  `PISTON_MAX_PROCESS_COUNT=32`.
- The `RunnerClient` interface stays; a `PistonRunnerClient` implements it and is selected by
  `CODE_RUNNER_PROVIDER=legacy|piston` (default `legacy`).

## Languages and packages

The app supports five languages (`src/app/api/code/run/route.ts`, `services/runner/src/types.ts`).
There is no in-browser runtime in `src/` today: no Pyodide and no browser JavaScript sandbox. The
lesson workspace sends every language, Python and JavaScript included, to `/api/code/run`, so all of
them reach the server runner.

| Language | Legacy runner | Newest in Piston's package index | Baked in PR1 |
|---|---|---|---|
| C | GCC 14.2 (C23) | gcc 10.2.0 | gcc 10.2.0 |
| C++ | G++ 14.2 (C++20) | gcc 10.2.0 | gcc 10.2.0 |
| Java | Java 21.0.12 | java 15.0.2 | java 15.0.2 |
| Python | Python 3.14.7 | python 3.12.0 | python 3.12.0 |
| JavaScript | Node 22 (CI 22.23.1, image 22.23.3) | node 20.11.1 | node 20.11.1 |

PR1 ships the official packages so the service can be measured. Matching the lessons needs our own
packages (PR5). Plan:

- **Own Piston image on a current base.** The upstream image is Debian buster (EOL, glibc 2.28), so
  modern toolchains cannot run on it. Build the Piston API and isolate from a pinned upstream commit on
  a pinned `debian:trixie-slim` digest instead. Toolchains installed in the image root are visible inside
  isolate boxes, so each Piston package becomes a thin `compile`/`run`/`environment` wrapper.
- **C/C++:** `gcc-14`/`g++-14` from Debian trixie, pinned through `snapshot.debian.org`.
- **Java 21:** the Eclipse Temurin 21 JDK tarball (sha256-pinned). Split into a real `javac` compile
  step and a `java -cp` run, so compile errors are reported as COMPILE_ERROR (gap in the table above).
  Add an AppCDS archive built at image build time (`-XX:ArchiveClassesAtExit` over a javac + hello
  run, then `-XX:SharedArchiveFile` for both javac and java) to cut JVM start-up.
- **Python 3.14:** the python-build-standalone `install_only` tarball (sha256-pinned).
- **Node 22 (CI 22.23.1, image 22.23.3):** the official nodejs.org linux-x64 tarball (sha256-pinned).

## Speed and resources

Measured on a GitHub KVM runner (run 36905595755). Every variant starts from zero Kata VMs, and the
guest's vCPU count is printed to prove the setting applied. Latency is the p50 of 10 warm runs
(stdin echo + print) in ms. RSS is the host RSS of qemu + shim + virtiofsd in MB.

| Variant | Cold start | C | C++ | Java | Python | JS | RSS idle | RSS load | RSS +30 s |
|---|---|---|---|---|---|---|---|---|---|
| Job dirs on virtio-fs (before) | 3162 | 347 | 679 | 1045 | 79 | 116 | 396 | 692 | 831 |
| Job dirs on guest tmpfs (PR1 compose) | 3192 | 320 | 664 | 1014 | 71 | 102 | 397 | 695 | 831 |
| + 2 vCPUs (max 4) | 3097 | 410 | 770 | 626 | 88 | 137 | 411 | 941 | 958 |
| + virtio-fs cache `always`, 4 virtiofsd threads | 3095 | 296 | 612 | 547 | 48 | 60 | 396 | 761 | 849 |
| + free-page reporting (**adopted**) | 3150 | 292 | 616 | 552 | 50 | 58 | 406 | 818 | 900 |

Before → adopted: C -16%, C++ -9%, Java -47%, Python -37%, JS -50%. Cold start (container up → first
successful run) is about 3.1 s in every variant. Free-page reporting returned no memory within 30 s,
but it is kept for long idle periods. Shared-runner noise is roughly ±15%; one earlier run measured
every variant about 30% faster.

What each item does:

1. Per-job directories (`/piston/jobs`, isolate's box root `/var/local/lib/isolate`, `/tmp`) are tmpfs
   inside the guest, so compiling and running never round-trips through virtio-fs.
2. 2 vCPUs by default, up to 4 (idle vCPUs cost the host nothing). The 1536 MB ceiling stays, with
   balloon free-page reporting (`reclaim_guest_freed_memory`) so freed guest RAM returns to the host.
   virtio-fs read cache `always` is safe because the image is read-only.
3. Java AppCDS (PR5, above).
4. Warm by default. An optional idle stop (`PISTON_IDLE_STOP_MINUTES`, off by default) lets the app stop
   Piston after N idle minutes and start it on the next run, at the measured cold-start cost.

## Migration (small PRs, each behind the flag)

1. Kata-only Piston compose service with a pinned digest, baked packages, limits and no egress,
   compose validator checks, and the NUC install runbook.
2. `PistonRunnerClient` adapter + status mapping + unit tests from the table above (no callers changed).
3. Wire `/api/code/run` (practice RUN/COMPILE) to the provider flag.
4. Wire exam TEST runs, assessment corrections and persisted practice recovery to the flag through
   the shared runner factory (default legacy, invalid configuration fails closed, no fallback).
   Keep exam runtime/image pins, test manifests and critical-test scoring unchanged. Provider parity
   tests compare all five languages' verdicts and scores using injected process/HTTP outcomes;
   live toolchain equivalence still depends on step 5. Project reviews stay bounded static analysis
   (`repositoryExecution: none`) with provider-independent findings and scores.
5. Own Piston image on Debian trixie with GCC 14, Java 21 (+ AppCDS), Python 3.14 and Node 22 (CI 22.23.1, image 22.23.3).
   The reviewed inputs and offline build live in `infra/piston`; live tests cover all five
   languages, modern syntax and isolate containment. `infra/piston/pr4b-runtime-handoff.json`
   records the tested image manifest and exact runtime labels for the separate PR4b publication
   migration. This step does not rewrite existing exam snapshots or deploy to the NUC.
   Optional idle stop remains a separate follow-up.
6. After a week on `piston` with no regressions AND no legacy-pinned attempt/correction/recheck
   lineages requiring execution: separately review deletion of `services/runner`, `infra/runner*`,
   the runtime image release tooling, and their evidence files. The rollout flag does not
   authorize retiring a provider still required by an immutable exam snapshot.

Rollback: set `CODE_RUNNER_PROVIDER=legacy` and restart the app. Nothing is deleted until step 6.
Already-created Piston exam attempts still require Piston after rollback; legacy attempts
always require legacy. Keep both providers configured while either pinned lineage remains.

### PR4b: reviewed publication pin revision

`infra/piston/pr4b-publication-pins.json` records revision `piston-pr4b-v1`, the reviewed
legacy version/digest allowlist and PR5 image reference. The image reference is a reference-build record, not a deployment pin. The target labels come directly
from `infra/piston/pr4b-runtime-handoff.json`; changes outside those exact pin pairs fail
closed. Runtime label drift or a different configured image manifest blocks new Piston forms.

When `CODE_RUNNER_PROVIDER=piston`, new formal forms from independently reviewed,
pointer-selected database publications receive the handoff labels and image manifest
before their immutable snapshots are inserted. With the default `legacy`, publication
pins remain legacy. Draft/filesystem content cannot opt into this revision. The change
copies only runtime pins: authored content, tests, hidden answers, scoring, eligibility,
policy version and persisted publication/review/release records remain unchanged.
No schema or persisted-artifact mutation is needed, so reviewed migration 0070 and its
latest-migration pins remain current.

Application runtime: Node 22 (CI 22.23.1, image 22.23.3). The table preserves exact immutable runtime labels, including `Node.js 22.23.3 (Piston)` from the handoff.

| Language | Reviewed legacy label | New form label |
| --- | --- | --- |
| C | C23 / GCC 14.2.0 | C23 / GCC 14.2.0 (Piston) |
| C++ | C++20 / G++ 14.2.0 | C++20 / G++ 14.2.0 (Piston) |
| Java | Java 21 or authored Java SE 21 | Java 21.0.12.1+1 / Temurin (Piston) |
| Python | Python 3.14 | Python 3.14.8 (Piston) |
| JavaScript | Node.js 22 | Node.js 22.23.3 (Piston) |

Every new Piston pin uses the manifest digest of the deployed, digest-pinned
`PISTON_IMAGE`, derived at runtime and failing closed. The `build.mjs` build is
reproducible per builder but not across BuildKit versions.
The existing legacy manifest digests are recorded verbatim in the reviewed revision.
This PR does not publish the image, deploy to the NUC or switch the production flag.
Before rollout, verify the deployed image manifest and labels against the PR5 handoff,
configure `PISTON_URL` and `PISTON_IMAGE`, and retain legacy endpoint/secret/runtime images.

Submission and correction dispatch use the attempt's pinned runtime label, including
recovery of a queued remote job. Exact response version/image and test-manifest checks
still run; unavailable selected providers fail without fallback. Stored snapshots are
never re-pinned. Equivalent retakes/mastery rechecks retain the source lineage's exact
reviewed pins before the unchanged full parity validator runs; arbitrary pin, content,
point, policy or duration changes cannot use this revision to bypass parity.

Publication-to-submission regression tests cover all five languages' accepted/wrong
answer/runtime error/timeout/memory/output verdicts and scores with real legacy grading
and Piston adapters using injected execution outcomes. They also check immutable source
banks/legacy snapshots, exact digest rejection, rollout rollback and retained lineage
parity. PR5's separate live image tests establish the toolchain/build contract; these
caller tests do not claim exhaustive live equivalence for arbitrary learner programs.
