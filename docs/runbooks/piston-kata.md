# Piston on Kata Containers (NUC)

Piston runs learner code. It must run under the Kata Containers runtime, which
gives the container its own micro-VM and kernel. The capabilities and cgroup
remount the Piston service needs apply only to that guest kernel. Never start
the `piston` service with the default `runc` runtime, and never add
`privileged: true`.

Plan and measurements: [docs/plans/piston-runner.md](../plans/piston-runner.md).

## Requirements

- Intel VT-x enabled in the NUC BIOS, so `/dev/kvm` exists.
- Docker Engine as installed. Do not change the engine version; Kata plugs in
  through containerd's shim interface and needs no daemon change.
- About 1.5 GB of RAM for the micro-VM. The host RSS measured on a KVM runner
  was about 400 MB idle and 750-900 MB under load (tuned config).

## Install Kata 4.2.0 (one time)

Run on the NUC as root.

```bash
test -c /dev/kvm && echo "KVM ok"
```

```bash
curl -fsSL -o /var/tmp/kata-static-4.2.0-amd64.tar.zst https://github.com/kata-containers/kata-containers/releases/download/4.2.0/kata-static-4.2.0-amd64.tar.zst
```

```bash
echo "b828904fa3f1e49ddd7dc799c72cb1503cd1e772d354c3987c8d4189b2a623a8  /var/tmp/kata-static-4.2.0-amd64.tar.zst" | sha256sum -c -
```

Extracting needs `zstd` (`apt-get install zstd` if it is missing). This
creates `/opt/kata` only.

```bash
zstd -dc /var/tmp/kata-static-4.2.0-amd64.tar.zst | tar -x -C / && rm /var/tmp/kata-static-4.2.0-amd64.tar.zst
```

```bash
ln -sf /opt/kata/runtime-rs/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2
```

Tune the micro-VM. Keep the settings in a copy under `/etc` so a Kata upgrade
does not overwrite them. The values were measured on a KVM runner (see the plan's
tuning table):

- `default_memory = 1536`: a ceiling, not a reservation. 1024 MB was too small
  for Piston to start.
- `default_vcpus = 2`, `default_maxvcpus = 4`: idle vCPUs cost the host nothing.
- `virtio_fs_cache = "always"` and 4 virtiofsd threads: the image is read-only,
  so caching it in the guest is safe. Together with the vCPUs this halved Java
  and cut Python/JavaScript by about 40%.
- `reclaim_guest_freed_memory = true`: balloon free-page reporting. No RSS drop
  was measured within 30 s, but it lets the host take back memory a long idle
  guest has freed.

```bash
install -d /etc/kata-containers/runtime-rs && cp "$(readlink -f /opt/kata/share/defaults/kata-containers/runtime-rs/configuration.toml)" /etc/kata-containers/runtime-rs/configuration.toml
```

```bash
sed -i -E -e 's/^(\s*default_memory\s*=).*/\1 1536/' -e 's/^(\s*default_vcpus\s*=).*/\1 2/' -e 's/^(\s*default_maxvcpus\s*=).*/\1 4/' -e 's/^(\s*virtio_fs_cache\s*=).*/\1 "always"/' -e 's/^(\s*virtio_fs_extra_args\s*=).*/\1 ["--thread-pool-size=4", "-o", "announce_submounts"]/' -e 's/^(\s*reclaim_guest_freed_memory\s*=).*/\1 true/' /etc/kata-containers/runtime-rs/configuration.toml
```

```bash
grep -E '^\s*(default_memory|default_vcpus|default_maxvcpus|virtio_fs_cache|virtio_fs_extra_args|reclaim_guest_freed_memory)\s*=' /etc/kata-containers/runtime-rs/configuration.toml
```

Smoke test. The kernel printed must differ from the host's `uname -r`, and
`nproc` must print `2`. A `1` means Kata did not read the `/etc` copy; in that
case apply the same `sed` to
`/opt/kata/share/defaults/kata-containers/runtime-rs/configuration.toml`.

```bash
docker run --rm --runtime io.containerd.kata.v2 alpine:3.22@sha256:3e9b4b680bfc9fb5269227cffbd6d42be39fbf7c0b908123913864aa4447e764 sh -c 'uname -r; nproc'
```

## Build and start Piston

Every change below goes through `/etc/learncoding/compose.env` and then
`infra/ops/redeploy-nuc.sh <git-sha>` with the currently deployed commit (the NUC
has no `learncoding-compose.service`). Re-running it with the deployed sha
rebuilds the same reproducible app images, restarts the app, workers and (when
the profile lists it) `piston`, and waits for `/health/ready`. The runtime
validator accepts `COMPOSE_PROFILES` of exactly empty, `uploads`, `piston`, or
`uploads,piston`, requires a digest-pinned
`PISTON_IMAGE` when `piston` is listed, and rejects `CODE_RUNNER_PROVIDER=piston`
without the profile. The app is always attached to the internal `piston`
network and reads `PISTON_URL=http://piston:2000` from `compose.yaml`.

1. Check that Docker uses the containerd image store. Only that store gives a
   local build a `RepoDigests` entry, which `PISTON_IMAGE` must pin. The output
   must include `io.containerd.snapshotter.v1`; if it does not, stop here.

   ```bash
   docker info --format '{{json .DriverStatus}}'
   ```

2. Build from the deployed checkout. The image bakes in checksum-verified
   language packages, so the running container never needs the network.

   ```bash
   cd /opt/learncoding
   node infra/piston/prepare.mjs
   node infra/piston/build.mjs codestead-piston:$(git rev-parse --short HEAD)
   docker image inspect --format '{{json .RepoDigests}}' codestead-piston:$(git -C /opt/learncoding rev-parse --short HEAD)
   ```

   The second command must print one `codestead-piston@sha256:<64 hex>` entry.
   New exam forms pin whatever digest `PISTON_IMAGE` names, so set it to exactly
   this value. Publication fails closed if `PISTON_IMAGE` is unset or not
   digest-pinned. Rebuilding with a different Docker/BuildKit version can change
   the digest. Existing Piston-pinned attempts then reject the new image, so
   rebuild only between exam windows.

3. Edit `/etc/learncoding/compose.env`: set `PISTON_IMAGE` to that exact
   `codestead-piston@sha256:<64 hex>` value, add the token (`COMPOSE_PROFILES=piston`,
   or `uploads,piston` when uploads are on), and keep `CODE_RUNNER_PROVIDER=legacy`.
   Then redeploy the running commit, which now also starts `piston`:

   ```bash
   sudo bash /opt/learncoding/infra/ops/redeploy-nuc.sh --no-scan "$(git -C /opt/learncoding rev-parse HEAD)"
   ```

4. Kata cannot run Docker healthchecks (no exec into the guest), so check the
   API from a throwaway container on the `piston` network. Within about a
   minute it should print `{"run":{...,"stdout":"42
",...`.

   ```bash
   docker run --rm --network learncoding_piston alpine:3.22@sha256:3e9b4b680bfc9fb5269227cffbd6d42be39fbf7c0b908123913864aa4447e764 wget -qO- --header content-type:application/json --post-data '{"language":"python","version":"3.14.8","files":[{"content":"print(6*7)"}]}' http://piston:2000/api/v2/execute
   ```

5. Flag flip (owner approval): set `CODE_RUNNER_PROVIDER=piston` in
   `/etc/learncoding/compose.env` and run the same `redeploy-nuc.sh` command
   again so the app is recreated with it. Practice and newly published formal exam forms
   select Piston; existing exams and grading corrections select the provider recorded in
   the attempt's immutable runtime label. The implemented PR4b publication revision uses
   the exact labels in `infra/piston/pr4b-runtime-handoff.json` and the deployed
   digest-pinned `PISTON_IMAGE`; the handoff's reference-build digest is a record, not a
   deployment pin. Keep legacy available for legacy-pinned attempts and their corrections;
   no fallback or snapshot rewriting is permitted.
   See [the image build and PR4b handoff](../../infra/piston/README.md).

`docker exec` into a Kata container is not supported by this Kata release.

For ongoing monitoring, configure Uptime Kuma to check
**https://code.shivanshmishra.in/health/runner** every 60 seconds, expecting HTTP
200 with a 10-second timeout. The app probes the internal runtime inventory,
shares concurrent probes, caches both outcomes for 30 seconds, and returns
generic 503 on failure. See [health endpoint semantics](logs-and-monitoring.md#health-endpoint-semantics)
for its request limit and execution-health limitation.
Debug with `docker logs learncoding-piston-1` instead. Later deploys with
`infra/ops/redeploy-nuc.sh` restart `piston` with the app while the profile is
listed; they never build or pull it, so rebuild (steps 2-3) to change it.

## What protects the host

- Kata micro-VM: own kernel, own memory, only basic devices. A learner probe saw
  kernel 6.18 on a 6.17 host, the VM's 1.45 GB of memory, and only
  null/zero/random/tty/pts devices.
- isolate, inside the VM: each job runs as its own uid with no capabilities, no
  network, a read-only root, and memory/time/process/output limits.
- Compose: the `piston` network is `internal`, so nothing in it can reach the
  internet or the homelab LAN. No ports are published, and there are no host
  mounts or secrets.

## Capacity comparison: two versus four jobs

From the deployed checkout, run this one command in an owner-selected quiet
maintenance window, with no active exams or learner runs:

```bash
sudo bash /opt/learncoding/scripts/piston-capacity.sh 2
```

The argument is an owner-reported **label**, not a configuration change. Confirm
the actual slot setting before labelling a run. The script uses a digest-pinned
`grafana/k6:2.3.0` throwaway container on `learncoding_piston`, a read-only root,
no capabilities, no Docker socket, no account credentials, and only two read-only
file mounts. It never loads `compose.env`; Docker pulls the tool image on the
host only if it is missing. Production defaults are unchanged.

It preflights the installed versions against the existing Piston image lock,
warms all five programs, then rotates equally through Python print, about 200 ms
of Python CPU time, Node, C++ compile/run and Java compile/run. One VU issues
one request at a time with 200 ms think time: this is a closed-loop load test,
not a promised arrival rate. The 180-second profile is 30 seconds at 1 VU,
45 seconds ramping to 10, 30 seconds at 10, 45 seconds ramping to 20, then
30 seconds at 20. Allow up to 46 seconds to drain, plus preflight time.
Requests use 3,000 ms run / 10,000 ms compile limits and the existing 256 MiB
run / 512 MiB compile memory limits. The HTTP timeout is 45 seconds, including
time queued before execution; the execution limits do not cap queue residence.

Only a short summary is printed: request count, p50/p95 milliseconds and error
percentage overall, by workload and by ramp/hold phase, plus jobs/second.
HTTP failures, timeouts, compile/run errors, signals and incorrect output count
as errors; a missing workload/phase or error rate of 1% or more exits nonzero.
Keep failing summaries too. The slot label does not prove actual server config.

Piston exposes compile/run `wall_time` in milliseconds but no queue timestamp.
Queue wait is therefore reported as unavailable. The separately labelled
residual is request duration minus both successful stage wall times, and includes
queueing, sandbox setup/cleanup and transport. It is **not measured queue wait**.
Missing stage timings produce no residual sample, not a zero estimate. See the
[pinned Piston implementation](https://github.com/engineer-man/piston/blob/de2b365ac759670a3a0d13ea208a0869a92c7e64/api/src/job.js)
and [k6 custom summaries](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/).

### Controlled four-slot experiment

Keep the deployed Piston image and all time/memory/process limits unchanged.
Record the deployed SHA, image digest, Kata settings, load summary and host
memory/CPU before each run. Run two-slot baseline tests three times before
changing anything. Monitor `docker stats --no-stream` and host `free -m` in a
second terminal; check Piston logs for OOMs, timeouts and compilation failures.
This benchmark bypasses app authentication/rate limits and does not establish
end-to-end learner capacity. Its k6 generator is capped at 0.5 host CPU and
256 MiB; a throttled generator or competing host work invalidates comparison.

1. Back up `/etc/kata-containers/runtime-rs/configuration.toml`. Set only
   `default_vcpus = 4`; retain `default_maxvcpus = 4` and `default_memory = 1536`.
   Check the effective file as in the installation section. Test a new throwaway
   Kata guest with the existing pinned Alpine smoke command; `nproc` must be 4.
   Merely changing max vCPUs does not add CPUs to an already-running guest.
2. For this temporary experiment create an owner-local Compose override; do not
   edit the repository's production defaults:

   ```yaml
   # /etc/learncoding/piston-capacity.override.yaml
   services:
     piston:
       environment:
         PISTON_MAX_CONCURRENT_JOBS: "4"
   ```

   Recreate only Piston during the maintenance window, retaining Kata and the
   existing image. This temporary override intentionally applies outside the
   normal whole-app redeploy; the next normal redeploy restores the canonical
   two-slot Compose setting:

   ```bash
   sudo docker compose -p learncoding --env-file /etc/learncoding/compose.env \
     -f /opt/learncoding/compose.yaml \
     -f /etc/learncoding/piston-capacity.override.yaml --profile piston \
     up -d --no-deps --force-recreate --pull never piston
   ```

3. Verify HTTP readiness with the existing smoke command (Kata cannot exec
   healthchecks). Confirm the container's `PISTON_MAX_CONCURRENT_JOBS` setting
   is 4 with Docker inspect; do not print the whole Compose environment. Then
   run `sudo bash /opt/learncoding/scripts/piston-capacity.sh 4` three times and
   send the summaries alongside the corresponding two-slot results. Keep host
   conditions and the image constant. A timed-out client does not prove its
   queued server job was cancelled: wait for the queue to drain before another
   run or service recreation.
4. Restore the saved Kata configuration and recreate only Piston using the
   same command **without** the override file. Remove the temporary override,
   verify the smoke test, and leave production at two slots unless a separately
   reviewed deployment change authorizes four.

### What would justify four slots?

Keep two slots until measurements support a change. A proposed acceptance rule
is at least 20% lower steady-20-VU p95 and higher throughput across all three
paired runs, with no workload p95 regression greater than 10%, no compile/run
failures, no OOMs or accumulating swap, and errors below 1% in every workload
and phase (preferably zero). The host should retain at least 20% available RAM
and avoid sustained CPU starvation of the app and other services. Check that
the steady-1-VU latency remains comparable; a changed baseline invalidates a
simple concurrency comparison.

Four compile slots can demand up to four 512 MiB budgets, exceeding a 1,536 MiB
guest if fully used. More slots or vCPUs alone do not add memory. If four is
unstable, roll back to two; do not raise memory/time limits or rebuild the exam
image as part of this experiment. Fast print-program results alone do not
justify four: Java and C++ results, host headroom and learner latency matter.
The summaries will support a recommendation after the owner runs both settings;
this PR makes no NUC throughput or four-slot safety claim.

## Rollback

1. Back to the legacy runner: set `CODE_RUNNER_PROVIDER=legacy` and run
   `redeploy-nuc.sh` with the deployed SHA. This changes the default provider for
   practice and newly published forms; Piston must remain available for existing
   Piston-pinned attempts and their corrections.
2. Only when no immutable Piston-pinned attempt or correction still needs it, stop Piston: remove the `piston` token from `COMPOSE_PROFILES` (leave
   `PISTON_IMAGE` or clear it), redeploy as above, then remove the container:

   ```bash
   docker compose -p learncoding --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml --profile piston rm -sf piston
   ```

To remove Kata entirely: delete `/usr/local/bin/containerd-shim-kata-v2`,
`/etc/kata-containers` and `/opt/kata`.
