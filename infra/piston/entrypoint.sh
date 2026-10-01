#!/bin/bash
# Piston entrypoint for the Kata Containers runtime.
#
# Under Kata the container runs in its own micro-VM with its own kernel, so the
# cgroup tree and the capabilities granted in compose.yaml belong to that guest
# kernel, not to the host. Docker mounts cgroupfs read-only for unprivileged
# containers; isolate needs to create its own cgroup subtree, so remount the
# guest's cgroupfs read-write first.
#
# Upstream starts the API as the piston user and relies on the setuid isolate
# binary. no-new-privileges blocks setuid, so the API runs as guest root and
# isolate drops every learner job to its own unprivileged uid with no
# capabilities and no network.
set -Eeuo pipefail

mount -o remount,rw /sys/fs/cgroup
cd /sys/fs/cgroup
mkdir isolate
echo 1 > isolate/cgroup.procs
echo '+cpuset +cpu +io +memory +pids' > cgroup.subtree_control
cd isolate
mkdir init
echo 1 > init/cgroup.procs
echo '+cpuset +memory' > cgroup.subtree_control
cd /piston_api
exec node /piston_api/src
