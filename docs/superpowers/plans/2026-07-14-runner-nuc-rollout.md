# Codestead KVM Runner and NUC Power-Recovery Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision the isolated two-slot KVM runner, make the trusted Codestead stack and runner recover automatically after reboot or sudden AC loss, preserve every acknowledged durable record, and produce auditable same-NUC deployment evidence without changing existing NUC services.

**Architecture:** The libvirt `default` network (`192.168.122.0/24`) on bridge `virbr0` carries a reviewed DHCP reservation for the fixed-address Ubuntu runner guest at `192.168.122.12`; learner jobs remain network-disabled containers inside that guest. The trusted Compose project uses immutable prebuilt images, explicit PostgreSQL durability settings, persistent bind mounts, bounded shutdown budgets, and restart policies. Systemd orders mount validation, libvirt/firewall, Docker, Compose startup, and a bounded recovery monitor; BIOS AC-restore plus libvirt/domain autostart completes the power-return chain. Repository automation gathers privacy-safe evidence, while the one physical AC-cut action remains administrator-supervised.

**Tech Stack:** Ubuntu Server 24.04, libvirt/KVM/QEMU, qcow2, cloud-init, nftables, Docker Engine 29, Docker Compose 5, systemd, Bash, Node.js runner, PostgreSQL 17, Cloudflare Tunnel.

## Global Constraints

- The trusted NUC is Ubuntu 24.04.4 LTS on an i7-1165G7 with 32 GB RAM; `/dev/kvm` is available.
- The runner guest is exactly 4 vCPU, 8 GiB RAM, and a 100 GiB thin-provisioned qcow2 disk.
- The runner accepts exactly two concurrent jobs and queues excess work with bounded depth.
- Untrusted code never runs on the trusted host or in the trusted application Compose project.
- The runner guest receives only its runner HMAC secret; it receives no database, application auth, AI-provider, OAuth, Gmail, Cloudflare, backup, or credential-master-key secret.
- No Codestead container or runner service publishes a public host port.
- Existing portfolio, email-service, Watchtower, roadmap-tracker, Nginx, host cloudflared, Tailscale, networks, and ports are not modified by rollout or rollback.
- Every Codestead long-running container uses `restart: unless-stopped`; one-shot services use `restart: "no"`; all have Watchtower opt-out.
- Normal boot starts already reviewed images with `--no-build --pull never`; build, migration, seed, bootstrap, and release mutation are separate operator actions.
- PostgreSQL retains data checksums and enforces `fsync=on`, `synchronous_commit=on`, and `full_page_writes=on`.
- PostgreSQL receives 120 seconds and app/workers 60 seconds for graceful controlled shutdown.
- Public readiness target after power restoration is 15 minutes under pilot load.
- BIOS **Restore on AC Power Loss: Power On**, one real offsite restore drill, one controlled reboot, and one supervised AC-loss rehearsal are release gates.
- The backup/recovery implementation plan must pass before the AC-loss rehearsal.
- “No loss” applies to server records acknowledged as `Saved to Codestead`; browser-durable work marked `Saved locally` survives browser close and resynchronizes. No claim covers a final keystroke not yet locally persisted, an unacknowledged request, falsely durable hardware, or physical disk destruction.

---

## File Structure

- Create `infra/runner-vm/codestead-runner-network.xml`: canonical libvirt default NAT topology, stable MAC, and additive DHCP reservation.
- Create cloud-init metadata/user-data templates under `infra/runner-vm/cloud-init/`.
- Create `infra/runner-vm/provision-host.sh`: checksum-verified, non-destructive VM/network provisioning.
- Create `infra/runner-vm/install-guest.sh`: pinned runner dependency and service installation inside the guest.
- Create `infra/runner-vm/host-runner.nft`: narrowly scoped host-to-runner firewall policy.
- Create `infra/systemd/learncoding-runner-firewall.service`.
- Modify runner service/env/launcher documentation and tests.
- Modify `compose.yaml`: durability, shutdown, fixed runner-egress, restart policy, and image-only boot compatibility.
- Modify `infra/ops/validate-runtime.sh`: PostgreSQL durability/network/runner preflight.
- Modify `infra/systemd/learncoding-compose.service`: mount-aware immutable boot recovery.
- Create `infra/ops/check-recovery.sh` and `infra/systemd/learncoding-recovery-check.{service,timer}`.
- Create `infra/ops/capture-recovery-evidence.sh`: privacy-safe pre/post recovery evidence.
- Modify `infra/ops/install-systemd.sh`.
- Create runner provisioning, systemd, recovery, and power-evidence tests.
- Create `docs/runbooks/power-loss-recovery.md`; update runner, deployment, monitoring, rollback, and feature-status documentation.

### Task 1: Failing KVM, systemd, and recovery contract tests

**Files:**
- Create: `infra/tests/runner-vm-provision.test.sh`
- Create: `infra/tests/systemd-recovery.test.sh`
- Create: `infra/tests/power-recovery-check.test.sh`
- Create: `infra/tests/power-evidence.test.sh`
- Modify: `infra/tests/runner-reconciliation.test.sh`
- Modify: `infra/tests/validate-compose.mjs`
- Modify: `infra/tests/validate-static.mjs`
- Modify: `infra/tests/runtime-config.test.sh`

**Interfaces:**
- Produces test contracts for `provision-host.sh`, `check-recovery.sh`, `capture-recovery-evidence.sh`, Compose durability, and recovery systemd units.
- Consumes no production credentials, host libvirt state, or external network.

- [ ] **Step 1: Write the provisioning test with fake host commands**

Place fake `virsh`, `qemu-img`, `cloud-localds`, `virt-install`, `sha256sum`, `install`, and `systemctl` in a temporary `PATH`. Record arguments and assert:

```bash
grep -Fq 'net-update' "$events"
grep -Fq 'net-autostart' "$events"
grep -Fq 'autostart codestead-runner' "$events"
grep -Fq 'resize' "$events"
grep -Fq '100G' "$events"
grep -Fq -- '--vcpus 4' "$events"
grep -Fq -- '--memory 8192' "$events"
grep -Fq -- '--network network=default,mac=52:54:00:20:00:12' "$events"
! grep -Eq -- '--network (bridge|direct)=|br0|wlo1' "$events"
```

Test wrong base-image SHA, existing domain, existing final disk, missing KVM, and a second idempotent inspection run. Destructive replacement must be rejected.

- [ ] **Step 2: Write static systemd/Compose assertions**

Assert the Compose unit has `RequiresMountsFor`, explicit env/Compose paths, `--no-build`, `--pull never`, restart backoff, `OnFailure`, and no `--build`. Assert PostgreSQL durability flags and stop budget, app/worker stop budgets, Watchtower opt-out, fixed runner-egress subnet/bridge, no published ports, and `restart: "no"` on one-shots.

- [ ] **Step 3: Write recovery monitor/evidence tests**

Fake systemctl, virsh, docker, curl, journalctl, findmnt, smartctl, and date. Cover delayed success, 15-minute timeout, failed public HTTPS, stopped pre-existing container, runner VM down, unhealthy PostgreSQL, malformed status, and privacy checks. Output must contain booleans/counts/versions only and must not contain HTTP bodies, secret values, learner identifiers, source, stdin, or runner journal content.

- [ ] **Step 4: Run tests and confirm expected failures**

```bash
bash infra/tests/runner-vm-provision.test.sh
bash infra/tests/systemd-recovery.test.sh
bash infra/tests/power-recovery-check.test.sh
bash infra/tests/power-evidence.test.sh
node infra/tests/validate-compose.mjs
```

Expected: the four new tests fail on missing assets/behavior; the existing Compose validator may expose the already-known semantic service-inventory defect, which must be repaired before extending it.

- [ ] **Step 5: Commit tests**

```bash
git add infra/tests/runner-vm-provision.test.sh infra/tests/systemd-recovery.test.sh \
  infra/tests/power-recovery-check.test.sh infra/tests/power-evidence.test.sh \
  infra/tests/runner-reconciliation.test.sh infra/tests/validate-compose.mjs \
  infra/tests/validate-static.mjs infra/tests/runtime-config.test.sh
git commit -m "test(ops): define runner and power recovery contract"
```

### Task 2: Canonical libvirt default NAT and non-destructive runner VM provisioning

**Files:**
- Create: `infra/runner-vm/codestead-runner-network.xml`
- Create: `infra/runner-vm/cloud-init/meta-data`
- Create: `infra/runner-vm/cloud-init/user-data.template`
- Create: `infra/runner-vm/provision-host.sh`
- Modify: `infra/tests/runner-vm-provision.test.sh`

**Interfaces:**
- Produces: an additive reservation on the libvirt `default` network, bridge `virbr0`, NAT `192.168.122.0/24`, host `192.168.122.1`, guest `192.168.122.12`, MAC `52:54:00:20:00:12`.
- Produces: domain `codestead-runner` and `/var/lib/libvirt/images/codestead-runner.qcow2`.
- Consumes: `RUNNER_BASE_IMAGE_PATH`, `RUNNER_BASE_IMAGE_SHA256`, and `RUNNER_ADMIN_SSH_PUBLIC_KEY_FILE`.

- [ ] **Step 1: Add the exact default-network reservation contract**

Validate the libvirt `default` NAT network on bridge `virbr0`, host `192.168.122.1/24`, without replacing unrelated existing XML. Converge only the reviewed host reservation MAC `52:54:00:20:00:12` to `192.168.122.12`. Do not forward a public port.

- [ ] **Step 2: Add secret-free cloud-init templates**

Create hostname `codestead-runner`, an administrator user with the supplied public SSH key, disabled password authentication, qemu-guest-agent, automatic security updates, and no runner/API secret. Cloud-init must not install application dependencies from an unpinned script.

- [ ] **Step 3: Implement fail-closed provisioning**

`provision-host.sh` must:

```text
validate root, /dev/kvm, commands, source regular-file mode, and exact SHA-256
refuse an existing domain or incompatible default-network identity/topology
refuse an existing final disk unless it is already attached to the expected domain
copy/convert the verified image to a temporary qcow2
resize the temporary image to 100G
fsync and atomically rename it into /var/lib/libvirt/images
create cloud-init seed from protected temporary files
converge the reservation and start/autostart the libvirt default network
define the domain with 4 vCPU, 8192 MiB, host-passthrough, virtio, cache=none
autostart/start the domain
remove the seed staging directory on every exit
```

No `virsh undefine`, `destroy`, `vol-delete`, `rm` of an existing final disk, or Wi-Fi bridge operation is permitted.

- [ ] **Step 4: Run provisioning test**

```bash
bash infra/tests/runner-vm-provision.test.sh
```

Expected: pass; every destructive and wrong-checksum fixture exits nonzero before any define/start event.

- [ ] **Step 5: Commit**

```bash
git add infra/runner-vm/codestead-runner-network.xml \
  infra/runner-vm/cloud-init/meta-data infra/runner-vm/cloud-init/user-data.template \
  infra/runner-vm/provision-host.sh infra/tests/runner-vm-provision.test.sh
git commit -m "feat(runner): provision isolated KVM guest"
```

### Task 3: Runner guest installation, autostart, and firewall

**Files:**
- Create: `infra/runner-vm/install-guest.sh`
- Create: `infra/runner-vm/host-runner.nft`
- Create: `infra/systemd/learncoding-runner-firewall.service`
- Modify: `infra/runner/learncoding-runner.service.example`
- Modify: `infra/env/runner.env.example`
- Modify: `infra/runner/run-runner.sh`
- Modify: `infra/tests/runner-reconciliation.test.sh`
- Modify: `docs/runbooks/runner-isolation.md`

**Interfaces:**
- Consumes: reviewed release at `/opt/learncoding`, mode-0440 `/etc/learncoding/runner-shared-secret`, five recorded runtime image digests, and private address `192.168.122.12`.
- Produces: enabled Docker and `learncoding-runner.service` in the guest, exactly two job slots, durable mode-0600 journal, and host firewall allowing only gateway source `172.29.40.2` on `cdst-run0` to guest TCP 4100.

- [ ] **Step 1: Extend launcher/unit tests**

Assert restart recovery still marks QUEUED/RUNNING jobs retryable, the launcher holds the single-writer lock before stale-container cleanup, the unit has `Restart=on-failure`, `RestartSec=5s`, bounded `StartLimitBurst`, `StateDirectoryMode=0700`, `LimitCORE=0`, and no public bind address.

- [ ] **Step 2: Implement guest installer**

The installer validates Ubuntu 24.04, KVM guest address, reviewed release checksum, pinned Docker/Node package versions, and exact runtime image references. It creates `learncoding-runner`, installs the release and unit, enforces secret/env ownership, runs build/test/typecheck plus runtime build/inspect/test/scan/record, compares recorded image identities with installed env, enables Docker and runner, and prints only aggregate pass booleans.

- [ ] **Step 3: Implement narrow host firewall**

Create an nftables table dedicated to Codestead with an allow from interface `cdst-run0` and fixed gateway source `172.29.40.2` to `192.168.122.12:4100`, then reject every other runner-egress flow to that destination before allowing unrelated established traffic. Policy for unrelated traffic remains accept. The systemd unit validates syntax before replacing only the dedicated table and is ordered after network/libvirt and before Codestead Compose.

- [ ] **Step 4: Run runner tests**

```bash
bash infra/tests/runner-reconciliation.test.sh
npm --prefix services/runner test
npm --prefix services/runner run typecheck
systemd-analyze verify infra/runner/learncoding-runner.service.example \
  infra/systemd/learncoding-runner-firewall.service
```

Expected: all exit zero and systemd reports no errors.

- [ ] **Step 5: Commit**

```bash
git add infra/runner-vm/install-guest.sh infra/runner-vm/host-runner.nft \
  infra/systemd/learncoding-runner-firewall.service \
  infra/runner/learncoding-runner.service.example infra/env/runner.env.example \
  infra/runner/run-runner.sh infra/tests/runner-reconciliation.test.sh \
  docs/runbooks/runner-isolation.md
git commit -m "feat(runner): install restart-safe isolated service"
```

### Task 4: Compose durability and immutable boot behavior

**Files:**
- Modify: `compose.yaml`
- Modify: `infra/env/compose.env.example`
- Modify: `infra/ops/validate-runtime.sh`
- Modify: `infra/tests/validate-compose.mjs`
- Modify: `infra/tests/validate-static.mjs`
- Modify: `infra/tests/runtime-config.test.sh`
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: private runner URL `http://192.168.122.12:4100`, reviewed immutable image references, persistent `/srv/learncoding` roots.
- Produces: PostgreSQL crash durability, controlled-stop budgets, deterministic runner egress, Watchtower exclusion, and a Compose model bootable without builds/pulls.

- [ ] **Step 1: Repair and extend semantic Compose tests**

First correct the expected service inventory to include the existing `reward-worker`. Then assert:

```js
assert.equal(postgres.restart, "unless-stopped");
assert.equal(postgres.stop_grace_period, "2m");
assert.match(postgres.command.join(" "), /fsync=on/);
assert.match(postgres.command.join(" "), /synchronous_commit=on/);
assert.match(postgres.command.join(" "), /full_page_writes=on/);
assert.equal(model.networks["runner-egress"].ipam.config[0].subnet, "172.29.40.0/24");
```

Also assert no service has host `ports`, all long-running services opt out of Watchtower and restart unless-stopped, and each one-shot restarts no.

- [ ] **Step 2: Run validators and confirm failures**

```bash
node infra/tests/validate-compose.mjs
node infra/tests/validate-static.mjs
bash infra/tests/runtime-config.test.sh
```

Expected: tests fail on missing durability/stop/network settings after the inventory repair.

- [ ] **Step 3: Implement Compose durability**

Set PostgreSQL command options to `fsync=on`, `synchronous_commit=on`, and `full_page_writes=on`; retain `POSTGRES_INITDB_ARGS=--data-checksums`. Add `stop_grace_period: 2m` to PostgreSQL, `1m` to app and database-mutating workers, and `30s` to cloudflared. Add separate fixed `runner-client` and `runner-egress` IPAM networks with bridge name `cdst-run0` for egress. Join the app and runner-consuming workers only to `runner-client`; attach the secretless `runner-egress-gateway` to both networks, and make it the only Compose service that joins `runner-egress`. Preserve all persistent bind mounts and the internal data network.

Place `migrate`, `platform-seed`, and `admin-bootstrap` behind the `operations` profile. Change long-running app/worker dependencies to PostgreSQL health rather than migration completion. The release transaction explicitly runs migration, seed, and bootstrap before first startup; ordinary systemd boot only validates the recorded migration state and starts long-running services, so a power return cannot trigger a schema release.

- [ ] **Step 4: Extend runtime validation**

Require the fixed private runner URL/subnet, exact long-running/one-shot restart classes, no host ports, immutable images, and the rendered PostgreSQL command. Add a post-start check that executes:

```sql
SELECT name, setting
FROM pg_settings
WHERE name IN ('fsync', 'synchronous_commit', 'full_page_writes');
```

Accept only `on/on/on`; do not print secret connection material.

- [ ] **Step 5: Run validators**

```bash
node infra/tests/validate-compose.mjs
node infra/tests/validate-static.mjs
bash infra/tests/runtime-config.test.sh
docker compose --env-file infra/env/compose.env.example -f compose.yaml config --quiet
```

Expected: all exit zero with the fixture secrets/images supplied by the tests; rendered model contains no host ports.

- [ ] **Step 6: Commit**

```bash
git add compose.yaml infra/env/compose.env.example infra/ops/validate-runtime.sh \
  infra/tests/validate-compose.mjs infra/tests/validate-static.mjs \
  infra/tests/runtime-config.test.sh docs/deployment.md
git commit -m "feat(ops): enforce crash-durable Compose runtime"
```

### Task 5: Mount-aware automatic startup and bounded recovery monitor

**Files:**
- Modify: `infra/systemd/learncoding-compose.service`
- Create: `infra/ops/check-recovery.sh`
- Create: `infra/systemd/learncoding-recovery-check.service`
- Create: `infra/systemd/learncoding-recovery-check.timer`
- Modify: `infra/ops/install-systemd.sh`
- Modify: `infra/tests/systemd-recovery.test.sh`
- Modify: `infra/tests/power-recovery-check.test.sh`

**Interfaces:**
- Produces: immutable Compose boot after required mounts/Docker/firewall/libvirt, bounded retry/backoff, and 15-minute aggregate recovery decision.
- Consumes: root-owned `/etc/learncoding/existing-containers.txt`, public health URL, private runner health/signing helper, and explicit Compose env/file paths.

- [ ] **Step 1: Implement immutable Compose boot unit**

Add:

```ini
RequiresMountsFor=/opt/learncoding /etc/learncoding /srv/learncoding
After=docker.service network-online.target libvirtd.service learncoding-runner-firewall.service
Wants=network-online.target libvirtd.service learncoding-runner-firewall.service
OnFailure=learncoding-alert@%n.service
StartLimitIntervalSec=15min
StartLimitBurst=5
```

Use `ExecStartPre` runtime validation and:

```ini
ExecStart=/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans
Restart=on-failure
RestartSec=15s
TimeoutStartSec=15min
TimeoutStopSec=5min
```

Keep release migration/seed/bootstrap outside this boot unit.

- [ ] **Step 2: Implement bounded recovery checker**

Poll every 10 seconds until 900 seconds. Require active Docker/libvirt/firewall, active/autostarted runner domain, signed runner health with concurrency two, PostgreSQL healthy plus durability settings, app readiness, expected workers, cloudflared running, public HTTPS correct host/security headers, enabled persistent timers, and every pre-existing container's captured ID, image, configuration, restart policy, health requirement, and strict live state. Emit one final JSON object of booleans/counts/timing only.

- [ ] **Step 3: Add recovery service/timer and installer wiring**

The service runs after the Compose unit but uses `Wants`, not `Requires`, so it records/alerts when Compose fails. The timer uses `OnBootSec=2m`, `OnUnitActiveSec=15m`, and `Persistent=true`. `install-systemd.sh --enable` enables firewall, Compose, recovery timer, and existing backup/retention timers; it never enables the manual restore drill.

- [ ] **Step 4: Run static and behavioral tests**

```bash
bash infra/tests/systemd-recovery.test.sh
bash infra/tests/power-recovery-check.test.sh
systemd-analyze verify infra/systemd/learncoding-compose.service \
  infra/systemd/learncoding-recovery-check.service \
  infra/systemd/learncoding-recovery-check.timer \
  infra/systemd/learncoding-runner-firewall.service
```

Expected: all pass; delayed fake dependencies succeed before 900 seconds and a permanently failed dependency returns nonzero with bounded output.

- [ ] **Step 5: Commit**

```bash
git add infra/systemd/learncoding-compose.service infra/ops/check-recovery.sh \
  infra/systemd/learncoding-recovery-check.service \
  infra/systemd/learncoding-recovery-check.timer infra/ops/install-systemd.sh \
  infra/tests/systemd-recovery.test.sh infra/tests/power-recovery-check.test.sh
git commit -m "feat(ops): recover Codestead automatically after boot"
```

### Task 6: Privacy-safe power recovery evidence and runbook

**Files:**
- Create: `infra/ops/capture-recovery-evidence.sh`
- Create: `docs/runbooks/power-loss-recovery.md`
- Modify: `infra/tests/power-evidence.test.sh`
- Modify: `docs/runbooks/logs-and-monitoring.md`
- Modify: `docs/runbooks/updates-and-rollback.md`
- Modify: `docs/feature-status.md`
- Modify: `docs/deployment.md`

**Interfaces:**
- Produces: `capture-recovery-evidence.sh pre PATH` and `capture-recovery-evidence.sh post PATH POWER_RESTORED_UTC PUBLIC_READY_UTC`, writing mode-0600 JSON/checksum with versions, status booleans/counts, boot ID, uptime, filesystem/SMART summary, VM state, backup ID, and recovery elapsed time.
- Consumes: no learner data, HTTP bodies, runner journal, database row content, or secrets.

- [ ] **Step 1: Implement evidence collector**

Allow only `pre` or `post` and an absolute destination beneath `/var/lib/learncoding/recovery-evidence`. Reject symlinks/non-root ownership. Collect exact Git commit/image IDs, boot ID, service states, container names/status/restart counts, VM/network autostart/state, `findmnt` source/options, PostgreSQL durability/checksum state, SMART overall-health and error counts, backup marker IDs, timer states, public readiness boolean, and UTC timestamps. Hash and atomically publish the JSON; never copy production logs into it.

- [ ] **Step 2: Complete evidence privacy tests**

Seed fake command outputs with canary secrets, source, learner email, and runner journal values. Assert none appear in JSON and only approved schema keys exist. Assert destination traversal and symlinks fail.

- [ ] **Step 3: Write exact recovery runbook**

Document:

1. Photograph/record BIOS **Restore on AC Power Loss: Power On**.
2. Use stable UUIDs; optional backup disk line:

Generate the stable mount line from the already mounted disk rather than typing a device name:

```bash
backup_uuid="$(findmnt -no UUID /mnt/learncoding-backups)"
test -n "$backup_uuid"
printf 'UUID=%s /mnt/learncoding-backups ext4 nofail,x-systemd.automount,x-systemd.device-timeout=10s,nodev,nosuid,noexec 0 2\n' "$backup_uuid"
```

3. Enable Docker, libvirt, the default network, domain autostart, runner guest service, Codestead systemd unit, firewall, timers, and external uptime monitor.
4. Capture known markers: server-saved draft, progress, audit, queued mail, two runner jobs, and browser-durable offline lesson/exam entries.
5. Capture pre evidence and finish a verified offsite restore drill.
6. Remove AC once without graceful shutdown; restore AC and perform no manual start.
7. Verify automatic host, existing containers, Docker, libvirt network/guest, runner, PostgreSQL recovery, app/workers/tunnel, timers, and public HTTPS recovery under 15 minutes.
8. Verify every acknowledged marker, browser-outbox exactly-once sync, runner retryable reconciliation, and no duplicate XP/mail/evidence.
9. Run immediate backup/object reconciliation/SMART checks and capture post evidence.
10. A failed item blocks invitations; later releases use crash simulations and controlled reboot rather than repeated physical power cuts.

- [ ] **Step 4: Run evidence and documentation tests**

```bash
bash infra/tests/power-evidence.test.sh
rg -n "Restore on AC Power Loss|Saved to Codestead|Saved locally|15 minutes|blocks invitations" \
  docs/runbooks/power-loss-recovery.md
```

Expected: evidence test passes and every required phrase is present.

- [ ] **Step 5: Commit**

```bash
git add infra/ops/capture-recovery-evidence.sh infra/tests/power-evidence.test.sh \
  docs/runbooks/power-loss-recovery.md docs/runbooks/logs-and-monitoring.md \
  docs/runbooks/updates-and-rollback.md docs/feature-status.md docs/deployment.md
git commit -m "docs(ops): define supervised power recovery gate"
```

### Task 7: Complete repository verification

**Files:**
- Modify only when a verification failure identifies a defect in files already listed in Tasks 1–6.

**Interfaces:**
- Consumes: all runner and recovery implementation outputs plus the completed backup/recovery plan.
- Produces: deployable artifacts and green gates; it does not claim real NUC or AC-loss evidence.

- [ ] **Step 1: Run runner and infrastructure gates**

```bash
bash infra/tests/runner-vm-provision.test.sh
bash infra/tests/runner-reconciliation.test.sh
bash infra/tests/systemd-recovery.test.sh
bash infra/tests/power-recovery-check.test.sh
bash infra/tests/power-evidence.test.sh
bash infra/tests/runtime-config.test.sh
node infra/tests/validate-compose.mjs
node infra/tests/validate-static.mjs
npm --prefix services/runner test
npm --prefix services/runner run typecheck
```

Expected: all exit zero.

- [ ] **Step 2: Run full application gates**

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: all exit zero.

- [ ] **Step 3: Render all deployment inputs**

```bash
docker compose --env-file infra/env/compose.env.example -f compose.yaml config --quiet
systemd-analyze verify infra/systemd/*.service infra/systemd/*.timer \
  infra/runner/learncoding-runner.service.example
xmllint --noout infra/runner-vm/codestead-runner-network.xml
nft --check --file infra/runner-vm/host-runner.nft
```

Expected: all parsers report success; Compose has no published ports.

- [ ] **Step 4: Inspect changes and scan for incomplete text or secrets**

```bash
git diff --check
rg -n "FIXME|XXX|nvapi-|sk-ant-|sk-proj-|AGE-SECRET-KEY-" \
  infra/runner-vm infra/systemd infra/ops docs/runbooks/power-loss-recovery.md
```

Expected: clean diff and no incomplete markers or credentials. A documented literal age key-format pattern in validation code must be reviewed rather than blindly accepted.

- [ ] **Step 5: Commit verification corrections if required**

```bash
git add compose.yaml infra docs package.json
git commit -m "test(ops): close NUC recovery implementation gate"
```

If there is no corrective diff, do not create an empty commit.

### Task 8: Same-NUC production rollout and evidence

**Files:**
- Create on the NUC, outside Git: `/etc/learncoding/existing-containers.txt`
- Create outside Git: production env/secrets, libvirt disk/seed, backup keys/config, and evidence under `/var/lib/learncoding/recovery-evidence`.
- Do not edit existing NUC service definitions or existing tunnel configuration.

**Interfaces:**
- Consumes: reviewed Git commit/images, completed backup plan, fresh production credentials, runner base image plus verified SHA-256, Cloudflare hostname/tunnel, Gmail credentials, mounted 2 TB disk.
- Produces: running private pilot and signed evidence for KVM isolation, backup recovery, reboot, rollback, and AC-loss recovery.

- [ ] **Step 1: Record and protect the pre-existing NUC baseline**

```bash
sudo /usr/bin/python3 -B /opt/learncoding/infra/ops/capture-existing-containers.py
sudo test -s /etc/learncoding/existing-containers.txt
sudo stat -c '%U:%G %a %n' /etc/learncoding/existing-containers.txt
sudo /opt/learncoding/infra/ops/check-recovery.sh
sudo systemctl is-active docker cloudflared tailscaled
sudo systemctl --failed --no-legend
```

Expected: capture prints only `capturedExistingContainers=5`; the canonical schema-v2 baseline is `root:root` mode `0600`; recovery binds the exact five container instances and their reviewed runtime state; Docker/cloudflared/Tailscale are active; and the failed-unit list is empty.

- [ ] **Step 2: Install libvirt tooling and provision the guest**

```bash
sudo apt install --yes qemu-kvm libvirt-daemon-system libvirt-clients virtinst cloud-image-utils nftables
sudo systemctl enable --now libvirtd.service
read -r RUNNER_BASE_IMAGE_SHA256 _ </etc/learncoding/runner-base-image.sha256
sudo RUNNER_BASE_IMAGE_PATH=/var/cache/codestead/ubuntu-24.04-server-cloudimg-amd64.img \
  RUNNER_BASE_IMAGE_SHA256="$RUNNER_BASE_IMAGE_SHA256" \
  RUNNER_ADMIN_SSH_PUBLIC_KEY_FILE=/etc/learncoding/runner-admin.pub \
  bash /opt/learncoding/infra/runner-vm/provision-host.sh
sudo virsh net-info default
sudo virsh dominfo codestead-runner
```

Expected: the `default` network and `codestead-runner` domain are active and autostarted; the network uses bridge `virbr0`, the domain reports 4 vCPU and 8 GiB, and the guest lease is `192.168.122.12`. `/etc/learncoding/runner-base-image.sha256` is installed from the reviewed release manifest before execution.

- [ ] **Step 3: Install and verify the guest runner**

Transfer the reviewed release archive and runner secret through the documented protected admin channel, run `install-guest.sh` inside the guest, then:

```bash
sudo systemctl is-enabled docker learncoding-runner.service
sudo systemctl is-active docker learncoding-runner.service
curl --fail --silent http://192.168.122.12:4100/healthz | jq -e \
  '.status == "ok" and .concurrency == 2 and .activeJobs == 0'
```

Expected: enabled/active and health expression true. Complete hostile network/PID/memory/output/timeout fixtures from the runner runbook before enabling code execution.

- [ ] **Step 4: Install trusted stack and systemd units**

Run the production validator, release migration/seed/bootstrap transaction, install systemd units, and start pilot without the uploads profile. Then:

```bash
sudo systemctl enable --now learncoding-runner-firewall.service
sudo REPO_ROOT=/opt/learncoding bash /opt/learncoding/infra/ops/install-systemd.sh --enable
sudo systemctl status learncoding-compose.service learncoding-recovery-check.timer --no-pager
sudo docker compose --env-file /etc/learncoding/compose.env \
  -f /opt/learncoding/compose.yaml ps
```

Expected: trusted services healthy, no Codestead host port, uploads absent, Watchtower labels false.

- [ ] **Step 5: Complete backup, offsite, and restore evidence**

Follow the backup plan handoff and require success before reboot testing.

- [ ] **Step 6: Controlled reboot recovery**

Run `sudo reboot`, reconnect without starting services manually, and run:

```bash
sudo systemctl --failed --no-legend
sudo systemctl start learncoding-recovery-check.service
sudo /opt/learncoding/infra/ops/check-recovery.sh
```

Expected: no failed units; existing containers, runner VM, trusted stack, tunnel, timers, and public HTTPS recovered under 15 minutes. Do not invoke the post evidence collector for this software reboot: its two timing arguments are reserved for the operator-observed physical restoration and public readiness in step 8.

- [ ] **Step 7: Rehearse image rollback**

Switch only Codestead image references to the recorded previous immutable release, recreate Codestead services, run smoke checks, then restore the current release. Do not include existing containers or `docker compose down -v` in any command.

Expected: both previous and current compatible releases reach readiness; persistent data remains.

- [ ] **Step 8: Supervised AC-loss rehearsal**

After BIOS evidence and preconditions, create the runbook markers, capture pre evidence, remove AC once, restore AC, and perform no manual start. Verify all runbook checks, immediate backup/reconciliation/SMART status, post evidence, no duplicate evidence, and public readiness under 15 minutes.

Expected: every accepted marker remains, browser local entries sync exactly once, ambiguous runner jobs become retryable without mastery, existing services recover, and the post evidence checksum validates. Any failure blocks learner invitations.

- [ ] **Step 9: Final deployment record**

Record Git commit, immutable image IDs, host/guest versions, domain/network XML hashes, test outputs, Cloudflare/Gmail booleans, backup/offsite/restore report IDs, reboot/AC recovery time, SMART summary, rollback result, and remaining risk that no UPS is installed. Never commit production evidence containing internal identifiers or secrets to the public repository.

## Rollback Boundary

- Application rollback changes only Codestead pinned image references and recreates only Codestead services.
- Runner rollback stops the runner VM or installs the previous reviewed runner release; code execution becomes unavailable, while learning/auth/progress remain usable.
- Cloudflare rollback disables only the new Codestead tunnel route.
- Schema rollback uses a verified recovery point when migrations are not backward-compatible; never issue ad hoc destructive SQL.
- Existing host containers/services are never named in a stop/remove/rollback command except read-only verification.
- Never use `docker compose down -v`, `virsh undefine --remove-all-storage`, `git reset --hard`, or deletion of `/srv/learncoding` during rollout or rollback.
