#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
probe="$repo_root/scripts/backup/create-credential-probe.ts"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

mkdir -- "$work/output"
chmod 0700 -- "$work/output"
key="$work/credential-master-key"
node -e "process.stdout.write(Buffer.alloc(32, 13).toString('base64'))" >"$key"
chmod 0440 -- "$key"
trace="$work/trace"
preload="$work/fault-preload.mjs"

cat >"$preload" <<'EOF'
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const keyPath = path.resolve(process.env.TEST_PROBE_KEY_PATH);
const tracePath = process.env.TEST_PROBE_TRACE;
const originalOpen = fs.promises.open.bind(fs.promises);
const originalRm = fs.promises.rm.bind(fs.promises);
let bodyFailed = false;

function trace(line) {
  fs.appendFileSync(tracePath, `${line}\n`, { encoding: "utf8" });
}

fs.promises.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (path.resolve(String(args[0])) === keyPath) {
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      await originalClose();
      trace("key-close-rejected");
      throw new Error("secondary-key-close-failure");
    };
  }
  return handle;
};
fs.promises.rename = async () => {
  bodyFailed = true;
  trace("rename-primary-failure");
  throw new Error("primary-rename-failure");
};
fs.promises.rm = async (...args) => {
  trace(`rm:${path.basename(String(args[0]))}`);
  return originalRm(...args);
};

const originalFill = Buffer.prototype.fill;
Buffer.prototype.fill = function (...args) {
  if (bodyFailed && args[0] === 0) trace(`zero:${this.length}`);
  return originalFill.apply(this, args);
};

const originalCatch = Promise.prototype.catch;
Promise.prototype.catch = function (onRejected) {
  return originalCatch.call(this, (reason) => {
    if (reason instanceof Error && /(?:primary-rename|secondary-key-close)-failure/.test(reason.message)) {
      trace(`caught:${reason.message}`);
    }
    return onRejected(reason);
  });
};

syncBuiltinESMExports();
EOF

output="$work/output/credential-probe.json"
node_probe="$probe"
node_preload="$preload"
node_key="$key"
node_output="$output"
node_trace="$trace"
if [[ "${OSTYPE:-}" == msys* ]]; then
  node_probe="$(cygpath -w "$probe")"
  node_preload="file:///$(cygpath -m "$preload")"
  node_key="$(cygpath -w "$key")"
  node_output="$(cygpath -w "$output")"
  node_trace="$(cygpath -w "$trace")"
fi
if TEST_PROBE_KEY_PATH="$node_key" TEST_PROBE_TRACE="$node_trace" \
  node --import "$node_preload" --import tsx "$node_probe" "$node_output" "$node_key" \
  >"$work/stdout" 2>"$work/stderr"; then
  fail "credential probe succeeded after injected rename/key-close failures"
fi
[[ "$(<"$work/stderr")" == credential_probe_failed ]] \
  || fail "credential probe close-failure fixture emitted a noncanonical diagnostic"
grep -Fxq 'rename-primary-failure' "$trace" \
  || fail "credential probe fixture did not inject the primary error"
grep -Fxq 'key-close-rejected' "$trace" \
  || fail "credential probe fixture did not reject key close"
grep -Fxq 'caught:primary-rename-failure' "$trace" \
  || fail "credential probe key-close rejection replaced the primary error"
grep -Eq '^rm:[.]credential-probe[.]json[.]tmp[.][0-9a-f]+$' "$trace" \
  || fail "credential probe key-close rejection skipped temporary cleanup"
[[ "$(grep -c '^zero:' "$trace")" -ge 3 ]] \
  || fail "credential probe key-close rejection skipped sensitive-buffer clearing"
[[ ! -e "$output" ]]
[[ -z "$(find "$work/output" -mindepth 1 -print -quit)" ]] \
  || fail "credential probe key-close rejection left a same-directory temporary"

echo "credential-probe-cleanup-tests-ok"
