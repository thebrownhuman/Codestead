import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const directory = new URL("../systemd/", import.meta.url);
const units = readdirSync(directory).filter((name) => /\.(service|timer)$/u.test(name));
assert.ok(units.length > 0, "No systemd units found");

for (const name of units) {
  const content = readFileSync(new URL(name, directory), "utf8").replace(/\\\r?\n/gu, " ");
  for (const line of content.split(/\r?\n/u)) {
    const documentation = line.match(/^\s*Documentation\s*=\s*(.*)$/u);
    if (!documentation) continue;
    // An empty assignment resets the list; every nonempty URL needs a scheme.
    for (const value of documentation[1].trim().split(/\s+/u).filter(Boolean)) {
      const url = value.replace(/^["']|["']$/gu, "");
      assert.match(url, /^[a-z][a-z0-9+.-]*:/iu, `${name}: Documentation= value lacks a URI scheme: ${value}`);
    }
  }
}
