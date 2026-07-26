#!/usr/bin/env node

const HARNESS_FAILURE =
  "mail_quarantine_redaction_0068_error=HARNESS_FAILED\n";

try {
  const { main } =
    await import("./mail-quarantine-redaction-0068.impl.mjs");
  await main();
} catch {
  process.exitCode = 1;
  try {
    process.stderr.write(HARNESS_FAILURE);
  } catch {
    // The process is already failed; no secondary diagnostic is safe.
  }
}
