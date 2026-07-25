export function parkMailDispatchUntilKilled(): never {
  const blocker = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    Atomics.wait(blocker, 0, 0);
  }
}

export function terminateMailDispatchImmediately(): never {
  try {
    process.exit(1);
  } catch {
    // A patched or throwing exit must never unwind retained mail authority.
  }
  return parkMailDispatchUntilKilled();
}
