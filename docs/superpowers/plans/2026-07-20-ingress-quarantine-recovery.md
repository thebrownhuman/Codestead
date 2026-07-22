# Fail-Closed Ingress Quarantine and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Codestead public ingress can start after boot, reload, daemon recovery, release, or rollback only after authenticated preparation and both internal and public readiness checks succeed.

**Architecture:** A small root-only Python control-state program owns durable quarantine and bounded-recovery state. A single Bash transaction owns the release lock, installs its fail-closed cleanup trap before any fallible operation, stops ingress, validates and prepares the internal stack, proves internal readiness, starts only `cloudflared`, and proves public readiness. Release, rollback, systemd, and a bounded recovery timer all use this same authority boundary.

**Tech Stack:** Python 3.12 standard library, Bash 5, Docker Compose, systemd, Node.js test runner, Python `unittest`, shell adversarial harnesses

## Global Constraints

- `cloudflared` must use exactly `restart: on-failure:5` as a bounded consecutive-crash guard; internal pilot services retain `unless-stopped`, and only the guarded start/timer may authorize ingress.
- Production control state lives only at `/var/lib/learncoding/ingress-control`, owned `root:root`, mode `0700`.
- State files are one-link regular non-symlinks owned `root:root`, mode `0600`; every ancestor is root-owned and not group/world writable.
- Release quarantine is distinct from recovery state and contains exactly `codestead-release-quarantine-v1\n`.
- Automatic recovery gets five eligible attempts with 30, 60, 120, and 240 second backoff; Docker unavailability and active release quarantine consume no attempt.
- A recovery attempt has a 60-second worst-case transaction budget plus at most 10 seconds of EXIT cleanup inside a 90-second systemd deadline; exhaustion is terminal until a root-only explicit reset.
- Ordinary start, reload, and recovery never clear release quarantine.
- The cleanup trap is installed immediately after lock acquisition and stops ingress before every fallible validation or preparation step.
- A recovery fast path must prove internal and public readiness; `cloudflared` container health alone never authorizes success.
- All root-executed scripts, binaries, and control paths require canonical owner, mode, link, ancestry, and fixed-PATH verification.
- Repository tests may not claim physical NUC AC-cut, live Cloudflare, or live Docker-daemon evidence.

---

### Task 1: Durable ingress-control state

**Files:**
- Create: `infra/ops/ingress-control.py`
- Create: `infra/tests/ingress-control.test.py`

**Interfaces:**
- Produces CLI commands `status`, `quarantine-create`, `quarantine-clear`, `record-failure`, `record-success`, and `reset-recovery`.
- `status --now EPOCH` prints one canonical token: `clear`, `release-quarantined`, `recovery-ready:N`, `recovery-wait:SECONDS`, or `recovery-exhausted`.
- `record-failure --now EPOCH` atomically writes canonical `recovery-state.env`; failure five atomically publishes `recovery-exhausted`.
- `--test-harness-root ABSOLUTE_0700_DIRECTORY` is the only path override and is rejected in production mode.

- [ ] **Step 1: Write failing state-contract tests**

```python
def test_quarantine_is_exact_and_durable(self):
    result = self.run_cli("quarantine-create")
    self.assertEqual(result.returncode, 0)
    marker = self.control / "release-quarantine"
    self.assertEqual(marker.read_bytes(), b"codestead-release-quarantine-v1\n")
    self.assertEqual(stat.S_IMODE(marker.stat().st_mode), 0o600)

def test_fifth_failure_exhausts_and_requires_explicit_reset(self):
    for now in (100, 131, 192, 313, 554):
        self.assertEqual(self.run_cli("record-failure", "--now", str(now)).returncode, 0)
    self.assertEqual(self.run_cli("status", "--now", "1000").stdout.strip(), "recovery-exhausted")
    self.assertNotEqual(self.run_cli("record-success").returncode, 0)
    self.assertEqual(self.run_cli("reset-recovery").returncode, 0)
```

Add cases for malformed bytes, stale schema, negative epochs, symlink, hard link, wrong owner, wrong mode, writable ancestor, crash injection before rename, quarantine idempotence, and reset preserving release quarantine.

- [ ] **Step 2: Run the focused test and confirm red**

Run: `python -m unittest infra/tests/ingress-control.test.py -v`

Expected: FAIL because `infra/ops/ingress-control.py` does not exist.

- [ ] **Step 3: Implement exact state formats and atomic writes**

```python
QUARANTINE_BYTES = b"codestead-release-quarantine-v1\n"
EXHAUSTED_BYTES = b"codestead-ingress-recovery-exhausted-v1\n"
BACKOFF_SECONDS = (30, 60, 120, 240)
MAX_ATTEMPTS = 5

def atomic_write(control_dir: Path, name: str, payload: bytes) -> None:
    fd = os.open(control_dir / f".{name}.tmp", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(control_dir / f".{name}.tmp", control_dir / name)
    dir_fd = os.open(control_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
```

Validate each component with `lstat`, reject extra fields or bytes, and require EUID zero outside the explicit harness.

- [ ] **Step 4: Run state tests green**

Run: `python -m unittest infra/tests/ingress-control.test.py -v`

Expected: all state, metadata, durability, and reset cases PASS.

### Task 2: Single guarded start transaction

**Files:**
- Create: `infra/ops/start-production-stack.sh`
- Create: `infra/tests/start-production-stack.test.sh`
- Create: `infra/tests/start-production-stack-adversarial.test.sh`
- Modify: `infra/ops/smoke-production.sh`
- Modify: `infra/tests/smoke-production.test.sh`

**Interfaces:**
- Consumes `ingress-control.py status`, `validate-runtime.sh`, both preparers, and `smoke-production.sh --phase internal|public`.
- Produces `start-production-stack.sh [--startup-wait SECONDS] [--lock-timeout SECONDS] [--recover-if-needed] [--test-harness-root ABSOLUTE_PATH]`.
- Returns `EX_TEMPFAIL` (`75`) when another release transaction owns the lock; contention does not stop ingress or consume a recovery attempt.
- Holds the lock through final ingress-state authorization, public smoke, and recovery-success recording.
- Enforces a monotonic 780-second transaction budget plus at most 50 seconds of fail-closed cleanup, below the 900-second systemd deadline.
- Re-authorizes durable ingress state immediately before starting `cloudflared`; `release-quarantined`, waiting, exhausted, malformed, or helper-failure states remain hard blocks.
- Starts the exact internal pilot list: `postgres app runner-egress-gateway mail-worker reward-worker regrade-worker exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker file-erasure-worker`; add `clamav scan-worker` only for the uploads profile.

- [ ] **Step 1: Write failing trace-order tests**

```bash
assert_trace_order \
  'flock:acquired' \
  'docker:compose:stop:cloudflared' \
  'control:status' \
  'validator:pre-privileged' \
  'prepare:objects' \
  'prepare:postgres' \
  'validator:full' \
  'docker:compose:up:internal' \
  'smoke:internal' \
  'control:status:final-pre-exposure' \
  'docker:compose:up:cloudflared:--no-deps' \
  'smoke:public'
```

Add failures at status, each validator/preparer, internal start, internal smoke, tunnel start, and public smoke; each must end with `docker compose stop cloudflared`. Add a recovery fast-path case where healthy tunnel plus failed internal/public smoke still re-enters or fails the transaction.

- [ ] **Step 2: Run the harness and confirm red**

Run: `bash infra/tests/start-production-stack.test.sh`

Expected: FAIL because the guarded script and phased smoke interface do not exist.

- [ ] **Step 3: Implement fail-closed command order**

```bash
secure_core_runtime
acquire_release_lock  # exits 75 on contention before touching ingress
cleanup() { quarantine_public_ingress; stop_compose_tunnel; }
trap cleanup EXIT HUP INT TERM
quarantine_public_ingress
authenticate_all_delegated_inputs
authorize_ingress_state initial
start_and_smoke_internal_services
authorize_ingress_state final-pre-exposure
start_and_smoke_public_ingress
```

Authenticate canonical ownership, exact modes, link count, and the root-owned non-writable ancestor chain for every delegated input. Use exact Compose argv, no inherited profiles, and `up -d --no-build --pull never --no-deps cloudflared` for ingress. Disarm the trap only after public smoke and recovery-success recording succeed.

- [ ] **Step 4: Add phased smoke behavior**

`--phase internal` verifies local app/DB/worker readiness without public HTTPS. `--phase public` verifies the configured public HTTPS origin and tunnel state. The default runs both for compatibility.

- [ ] **Step 5: Run transaction and smoke tests green**

Run: `bash infra/tests/start-production-stack.test.sh && bash infra/tests/start-production-stack-adversarial.test.sh && bash infra/tests/smoke-production.test.sh`

Expected: all trace, failure, and phase cases PASS.

### Task 3: Bounded automatic ingress recovery

**Files:**
- Create: `infra/ops/recover-production-ingress.sh`
- Create: `infra/tests/ingress-recovery.test.sh`

**Interfaces:**
- Consumes `ingress-control.py status|record-failure` and `start-production-stack.sh --recover-if-needed --startup-wait 5`; the guarded start records success while it still owns the release lock.
- Produces a timer-safe oneshot: exit zero on backoff, active quarantine, validated healthy readiness, exhaustion, active-lock contention, and guarded-start `75`; Docker unavailability alerts nonzero after safe cleanup but consumes no attempt.
- Fixes Docker authority to `unix:///var/run/docker.sock` and Compose project `learncoding`, removes ambient endpoint/file/project overrides, and requires empty pilot profiles.
- Bounds the forced worst eligible path to 60 seconds and fail-closed EXIT cleanup to 10 seconds under `TimeoutStartSec=90s`.

- [ ] **Step 1: Write failing clock and retry tests**

```bash
run_recovery 100 fail
assert_state 'failure_count=1' 'next_attempt_epoch=130'
run_recovery 110 fail
assert_attempt_count 1
run_recovery 130 fail
assert_state 'failure_count=2' 'next_attempt_epoch=190'
```

Cover transient and persistent discovery/stop uncertainty, five-attempt exhaustion, post-exhaustion no-op, Docker unavailable not consuming an attempt, quarantine not consuming an attempt, malformed state, healthy no-op, exit `75`, concurrent ticks, state-change races, hostile ambient Docker/Compose values, sticky lock ancestry, and the exact worst-path deadline trace.

- [ ] **Step 2: Run the recovery harness and confirm red**

Run: `bash infra/tests/ingress-recovery.test.sh`

Expected: FAIL because the recovery script does not exist.

- [ ] **Step 3: Implement bounded recovery**

```bash
# 2s state + 2s Docker + 7s full readiness + 30s guarded start
# + 19s locked reauthorization/quarantine/persistence = 60s.
# EXIT cleanup has a separate bounded 10s reserve under systemd's 90s limit.
preflight_release_lock_or_exit_neutral
run_guarded_start_or_treat_75_as_neutral
reacquire_lock_recheck_state_probe_quarantine_and_record_once
```

Do not clear exhausted state automatically. Never quarantine outside the release lock, never count contention, and never let ambient Docker/Compose variables redirect discovery or mutation. A supposedly healthy tunnel must pass the combined internal/public smoke; success is persisted by guarded start before it releases the lock.

- [ ] **Step 4: Run recovery tests green**

Run: `bash infra/tests/ingress-recovery.test.sh`

Expected: all retry, backoff, exhaustion, reset, and non-consumption cases PASS.

### Task 4: Docker Compose and systemd authority wiring

**Files:**
- Modify: `compose.yaml`
- Modify: `infra/systemd/learncoding-compose.service`
- Create: `infra/systemd/learncoding-ingress-recovery.service`
- Create: `infra/systemd/learncoding-ingress-recovery.timer`
- Create: `infra/tmpfiles.d/learncoding-ingress-control.conf`
- Modify: `infra/ops/install-systemd.sh`
- Modify: `infra/tests/systemd-recovery.test.sh`
- Modify: `infra/tests/validate-compose.mjs`
- Modify: `infra/tests/validate-static.mjs`

**Interfaces:**
- `learncoding-compose.service` uses only the guarded start script for `ExecStart` and `ExecReload`.
- The timer invokes the bounded recovery script every minute and has a bounded oneshot timeout and failure alert.

- [ ] **Step 1: Add failing static/systemd assertions**

```js
assert.equal(compose.services.cloudflared.restart, "on-failure:5");
assert.match(unit, /ExecStart=.*start-production-stack\.sh --startup-wait 600/);
assert.match(unit, /ExecReload=.*start-production-stack\.sh --startup-wait 600/);
assert.doesNotMatch(unit, /ExecStartPost=/);
```

Assert exact PATH wrappers, root ownership/modes in tmpfiles, timer cadence, service timeout, OnFailure, install enablement, exact internal inventory, and `--no-deps` tunnel start.

- [ ] **Step 2: Run relevant static tests and confirm red**

Run: `node infra/tests/validate-compose.mjs && node infra/tests/validate-static.mjs && bash infra/tests/systemd-recovery.test.sh`

Expected: FAIL on current tunnel restart and direct Compose systemd start.

- [ ] **Step 3: Wire the guarded authority**

Set `cloudflared.restart` to exactly `on-failure:5`, documenting that it bounds consecutive process failures but does not authorize ingress or guarantee daemon-restart activation. Replace multiple start/reload commands with fixed-PATH guarded-script calls. Install and enable the recovery timer and create `/var/lib/learncoding/ingress-control` through tmpfiles without changing unrelated units.

- [ ] **Step 4: Run static/systemd tests green**

Run: `node infra/tests/validate-compose.mjs && node infra/tests/validate-static.mjs && bash infra/tests/systemd-recovery.test.sh`

Expected: all ingress authority and restart-policy checks PASS.

### Task 5: Persistent release and rollback quarantine

**Files:**
- Modify: `infra/ops/release-production.sh`
- Modify: `infra/ops/rollback-production.sh`
- Modify: `infra/tests/release-production.test.sh`
- Modify: `infra/tests/rollback-production.test.sh`

**Interfaces:**
- Both transactions call `ingress-control.py quarantine-create` before candidate/restored-runtime mutation.
- Release clears quarantine only after its durable commit point and public smoke; rollback clears only after restored internal and public smoke.

- [ ] **Step 1: Add failing durable-marker scenarios**

```bash
assert_trace_order 'control:quarantine-create' 'candidate:mutation' 'smoke:internal' 'smoke:public' 'control:quarantine-clear'
run_release_with_failpoint after_quarantine
assert_marker_exact
run_release_failure public_smoke
assert_marker_exact
```

Add successful release/rollback, crash immediately after marker creation, internal/public failure, forged marker, clear failure, and reboot-style guarded-start refusal while the marker persists.

- [ ] **Step 2: Run release harnesses and confirm red**

Run: `bash infra/tests/release-production.test.sh && bash infra/tests/rollback-production.test.sh`

Expected: FAIL because release quarantine is not yet persistent.

- [ ] **Step 3: Integrate marker lifecycle**

Authenticate the control helper like every other trusted release artifact. Create the marker immediately after acquiring the release lock and before mutation. Leave the cleanup trap armed and marker present on every failure. Clear it as the final fallible durability operation after all successful evidence and public smoke operations.

- [ ] **Step 4: Run release harnesses green**

Run: `bash infra/tests/release-production.test.sh && bash infra/tests/rollback-production.test.sh`

Expected: all success, rollback, crash, and persistence cases PASS.

### Task 6: Runtime validator and authoritative fake harness reconciliation

**Files:**
- Modify: `infra/ops/validate-runtime.sh`
- Modify: `infra/tests/runtime-config.test.sh`
- Modify: `infra/tests/runtime-validator-harness-contract.test.mjs`
- Modify: `infra/tests/runtime-validator-structure.test.mjs`
- Modify: `infra/tests/runtime-validator-network-fixture.test.sh`

**Interfaces:**
- The fake Docker harness supports strict image inspect/getent identity, `--profile operations compose config`, the exact seven one-shot operations services, custom PostgreSQL socket argv, both preparer hashes, and bootstrap-secret matrices.

- [ ] **Step 1: Refresh the harness contract checksum only after freezing the validator**

```bash
sha256sum infra/ops/validate-runtime.sh
```

Copy the lowercase digest into `runtime-validator-harness-contract.test.mjs`; do not weaken the hash gate.

- [ ] **Step 2: Complete fake runtime behavior**

Implement fake Docker handlers for image identity and `getent`, emit all three operations database services under `--profile operations`, add PostgreSQL UID/GID and preparer fixtures, and move the wrong-runner-client-url case outside loops. Cover bootstrap flag values `false`/`true`, absent/present/short/valid secret, and nonliteral rejection.

- [ ] **Step 3: Run the validator suites green**

Run: `node --test infra/tests/runtime-validator-harness-contract.test.mjs infra/tests/runtime-validator-structure.test.mjs && bash infra/tests/runtime-config.test.sh && bash infra/tests/runtime-validator-network-fixture.test.sh`

Expected: all runtime validator contract, syntax, metadata, operations-profile, socket, and bootstrap cases PASS.

### Task 7: Operator documentation and evidence boundaries

**Files:**
- Modify: `docs/deployment.md`
- Modify: `docs/runbooks/power-loss-recovery.md`
- Modify: `docs/runbooks/updates-and-rollback.md`
- Modify: `docs/release-audit.md`

**Interfaces:**
- Documents exact boot/reload/recovery sequence, quarantine inspection, recovery reset command, timer state, and external-evidence blockers.

- [ ] **Step 1: Update commands and claims**

Document:

```bash
sudo systemctl status learncoding-compose.service learncoding-ingress-recovery.timer
sudo python3.12 /opt/learncoding/infra/ops/ingress-control.py status --now "$(date +%s)"
sudo python3.12 /opt/learncoding/infra/ops/ingress-control.py reset-recovery
```

State that reset never removes release quarantine. Remove claims that Docker restart policy alone restores public ingress. Describe exact preparer identity/UID/GID checks and do not claim physical AC-cut or live Cloudflare proof without captured host evidence.

- [ ] **Step 2: Run documentation/static checks**

Run: `git diff --check && node infra/tests/validate-static.mjs`

Expected: no whitespace errors or stale unsafe claims.

### Task 8: Integrated verification and frozen handoff

**Files:**
- Modify only failing files within this plan's scope.

**Interfaces:**
- Produces exact fresh command evidence and final SHA-256 identities for the validator, guarded scripts, state helper, units, Compose file, and harnesses.

- [ ] **Step 1: Run focused suites**

```bash
python -m unittest infra/tests/ingress-control.test.py -v
bash infra/tests/start-production-stack.test.sh
bash infra/tests/ingress-recovery.test.sh
bash infra/tests/release-production.test.sh
bash infra/tests/rollback-production.test.sh
bash infra/tests/systemd-recovery.test.sh
node --test infra/tests/runtime-validator-harness-contract.test.mjs infra/tests/runtime-validator-structure.test.mjs
bash infra/tests/runtime-config.test.sh
node infra/tests/validate-compose.mjs
node infra/tests/validate-static.mjs
```

Expected: every command exits zero.

- [ ] **Step 2: Run broad repository verification**

Run package-provided lint, typecheck, unit, integration, and build commands individually with their required local prerequisites. Classify any unavailable real Docker, PostgreSQL, Cloudflare, or NUC evidence as an explicit external blocker instead of fabricating success.

- [ ] **Step 3: Freeze evidence**

Run: `git diff --check && sha256sum infra/ops/validate-runtime.sh infra/ops/ingress-control.py infra/ops/start-production-stack.sh infra/ops/recover-production-ingress.sh compose.yaml infra/systemd/learncoding-compose.service infra/systemd/learncoding-ingress-recovery.service infra/systemd/learncoding-ingress-recovery.timer`

Expected: clean diff check and lowercase SHA-256 digests recorded in the handoff.

- [ ] **Step 4: Report honestly**

Report repository-proven scenarios separately from unresolved physical AC-cut, live Cloudflare, and live Docker-daemon checks. Do not mark production deployment complete until each external release blocker has real NUC evidence.
