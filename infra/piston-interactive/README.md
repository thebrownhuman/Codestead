# Interactive Piston image (PR 1a)

This is an optional, separate Kata service. It does not replace or modify the
batch Piston image, the application, the legacy runner gateway, or any existing
homelab service. It has no public port and no application/broker connection in
this PR. Authentication and grants belong to PR 1b; terminal UI belongs to PR 2.

This image exposes WebSocket execution and read-only inventory. REST execution
and package mutations return 404, so they cannot bypass the fixed interactive
CPU/memory/byte policy. The existing batch image retains its REST API unchanged.

The Compose addon stays off unless explicitly merged into the deployment model
and its `piston-interactive` profile is selected. Only the owner deploys it.
No command below targets the NUC. Run image tests only on a disposable Docker
Desktop or CI VM; their privileged/private-cgroup harness is never a production
configuration. Production requires `io.containerd.kata.v2`.

## Resource contract

Two interactive slots; service cgroup limits of **2 GiB RAM, 2 CPUs, 128 PIDs**.
The existing host Kata configuration is unchanged; its guest-memory ceiling can
be lower than the service limit and remains an owner-controlled deployment
setting. Per run: 128 MiB memory, 3 seconds CPU, 5 minutes wall time. Compilation
keeps 10 seconds CPU/wall and 512 MiB. Combined compile/run stdout + stderr is
limited to 65,536 raw and forwarded UTF-8 bytes. Stdin is capped at 16,384 UTF-8
bytes. Compression is disabled; oversized, binary and malformed messages are
rejected. An explicit `eof` message closes run stdin without discarding buffered
input. Stop/Ctrl+C cancel the sandbox instead of delivering a catchable signal
to the learner process.

PR 1b adds authenticated admission and the 60-second input-idle deadline; this
image already supplies the independent hard CPU/wall/output/input boundaries.

## Reproducible offline build

The parent uses the unchanged `infra/piston/image-inputs.lock.json`: pinned
Debian snapshot, toolchains, Piston commit, isolate commit, and every downloaded
archive/dependency digest. This variant binds the locally built parent's manifest,
config digest and embedded source manifest before patching. The patch refuses
upstream source bytes different from its reviewed SHA-256 values. Every variant
build input is hashed, embedded and checked inside the image.

Use Docker's containerd image store and the Docker driver on the active Docker
context, both locally and in CI. The build explicitly selects that context's
builder and rejects a separate `docker-container` builder, which cannot see the
daemon's loaded images. No registry publication is needed: an explicit named
build context maps the immutable `FROM codestead-piston@sha256:...` to
`docker-image://<verified-local-batch-tag>`, with `--pull=false`. Before that
mapping is used, the local image digest, config and embedded input manifest must
match the batch build metadata and reviewed sources.

CI builds the batch parent twice in the same job, verifies identical digests,
and additionally requires its manifest to equal
`sha256:6dc2d85a7b5b5fa15f1fae8f1232b43837eb912831bc23fc24c0dc0e0b5b0e3a`
before building the interactive variant. The local Docker Desktop reference
builder produces parent
`sha256:2fc2e55122fbdc25c6100a0ee7d8f29a31282b9e0202655e206b644985ed8ef6`;
that different builder's reference digest is recorded in the committed handoff.
The CI pin never falls back to the local reference digest or to a registry pull.

```sh
node infra/piston/prepare.mjs
node infra/piston/build.mjs codestead-piston:interactive-base
node --test infra/piston-interactive/*.test.mjs
node infra/piston-interactive/build.mjs codestead-piston-interactive:review codestead-piston:interactive-base
cp infra/piston-interactive/build-metadata.json first-interactive-build.json
node infra/piston-interactive/build.mjs --no-cache codestead-piston-interactive:review codestead-piston:interactive-base
node infra/piston/verify-digest.mjs first-interactive-build.json infra/piston-interactive/build-metadata.json
node infra/piston-interactive/test-image.mjs codestead-piston-interactive:review
```

Builds use `--network=none`, immutable parent references, the locked
`SOURCE_DATE_EPOCH`, fixed COPY modes and rewritten timestamps. The same builder
must produce identical manifest/config digests with and without cache. As for
the batch image, different BuildKit versions can produce different digests.
The handoff records a reference build, not an exam/runtime publication pin.

## Interactive lifecycle

The variant fixes the pinned upstream signal-event mismatch by cancelling the
isolate supervisor directly. The pinned isolate handles SIGTERM by killing its
sandbox process group and cgroup; signal-ignoring or detached learner descendants
cannot survive cancellation. Disconnect, Stop, Ctrl+C, protocol errors and byte
caps all use this path. Cancellation also removes queued jobs. Slots are released
only after awaited sandbox cleanup; cleanup failure quarantines capacity. Active
box IDs remain reserved through metadata removal, preventing ID wraparound from
reusing a long-lived terminal's sandbox. A 1,100-allocation regression covers it.

C/C++ use unbuffered standard I/O via the already-pinned coreutils `stdbuf`;
Python uses `-u`. Java and Node retain their existing runtime flags. This supports
live line-input programs over pipes. It does not add a shell or unrestricted PTY.

Live tests require prompt-before-input in all five languages, aggregate output
and UTF-8 input caps, the unchanged CPU cap, cancellation of detached descendants,
and repeated two-slot reuse without interrupting another terminal. Successful
commands write no application/program logs; failures emit bounded diagnostics.

The owner-approved image/evidence hash table is a required STOP before publishing
this PR. Root dependencies and the web lockfile evidence chain are unchanged.
