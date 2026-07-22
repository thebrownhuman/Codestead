const INDEX_RECORD = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t([^\0]+)$/u;

export function parseGitIndexModes(output) {
  const modes = new Map();
  for (const record of output.split("\0")) {
    if (record.length === 0) continue;

    const match = INDEX_RECORD.exec(record);
    if (!match || match[3] !== "0") {
      throw new Error("unexpected Git index record");
    }

    const [, mode, , , relative] = match;
    if (modes.has(relative)) {
      throw new Error("duplicate Git index record");
    }
    modes.set(relative, mode);
  }
  return modes;
}

export function validateProductionExecutableModes({
  requiredPaths,
  indexModes,
  worktreeRegularFiles,
}) {
  const failures = [];
  for (const relative of requiredPaths) {
    if (!worktreeRegularFiles.has(relative)) {
      failures.push(`production executable is missing or not a regular file: ${relative}`);
      continue;
    }

    const mode = indexModes.get(relative);
    if (!mode) {
      failures.push(`production executable is not tracked in the Git index: ${relative}`);
      continue;
    }
    if (mode !== "100755") {
      failures.push(`production executable has Git index mode ${mode}; expected 100755: ${relative}`);
    }
  }
  return failures;
}
