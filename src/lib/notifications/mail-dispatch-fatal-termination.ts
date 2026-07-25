const MAIL_DISPATCH_FAILURE_EXIT_CODE = 1;

let mailDispatchParkWord: Int32Array | undefined;
try {
  mailDispatchParkWord = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
} catch {
  // A tight loop remains the allocation-free non-returning fallback.
}

export function parkMailDispatchUntilKilled(): never {
  let waitWord = mailDispatchParkWord;

  for (;;) {
    if (!waitWord) continue;
    try {
      Atomics.wait(waitWord, 0, 0);
    } catch {
      waitWord = undefined;
    }
  }
}

export function terminateMailDispatchImmediately(): never {
  try {
    process.exit(MAIL_DISPATCH_FAILURE_EXIT_CODE);
  } catch {
    // A patched or failed exit must still never resume cleanup or unlock TX2.
  }
  return parkMailDispatchUntilKilled();
}
