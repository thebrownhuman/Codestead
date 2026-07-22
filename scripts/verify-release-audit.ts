import { access, readFile } from "node:fs/promises";
import path from "node:path";

async function main() {
const root = process.cwd();
const matrixPath = path.join(root, "docs", "requirements-matrix.md");
const auditPath = path.join(root, "docs", "release-audit.md");
const [matrix, audit] = await Promise.all([
  readFile(matrixPath, "utf8"),
  readFile(auditPath, "utf8"),
]);

const requirementRow = /^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3})\s*\|/gm;
const auditRow = /^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3})\s*\|\s*(Implemented|Partial|Missing)\s*\|/gm;
const matrixIds = [...matrix.matchAll(requirementRow)].map((match) => match[1]!);
const rows = [...audit.matchAll(auditRow)].map((match) => ({ id: match[1]!, status: match[2]! }));
const errors: string[] = [];

const forbiddenCurrentSecurityClaims = [
  /Exact current image IDs, SPDX SBOMs and Trivy/i,
  /Six exact local app-family images now have identity assertions, per-image SPDX SBOMs and exact Trivy reports/i,
];
for (const claim of forbiddenCurrentSecurityClaims) {
  if (claim.test(audit)) {
    errors.push(
      `Release audit presents historical image-security evidence as current: ${claim.source}`,
    );
  }
}

if (new Set(matrixIds).size !== matrixIds.length) errors.push("Requirements matrix contains duplicate stable IDs.");
const rowCounts = new Map<string, number>();
for (const row of rows) rowCounts.set(row.id, (rowCounts.get(row.id) ?? 0) + 1);
for (const id of matrixIds) {
  const count = rowCounts.get(id) ?? 0;
  if (count !== 1) errors.push(`Audit must contain '${id}' exactly once; found ${count}.`);
}
for (const id of rowCounts.keys()) {
  if (!matrixIds.includes(id)) errors.push(`Audit contains unknown requirement '${id}'.`);
}

const actual = { Implemented: 0, Partial: 0, Missing: 0 };
for (const row of rows) actual[row.status as keyof typeof actual] += 1;
for (const status of Object.keys(actual) as Array<keyof typeof actual>) {
  const declared = audit.match(new RegExp(`^\\| ${status} \\| (\\d+) \\|`, "m"));
  if (!declared) errors.push(`Verdict table is missing '${status}'.`);
  else if (Number(declared[1]) !== actual[status]) {
    errors.push(`Verdict says ${declared[1]} ${status}, but ${actual[status]} rows were found.`);
  }
}
const declaredTotal = audit.match(/^\| \*\*Total\*\* \| \*\*(\d+)\*\* \|/m);
if (!declaredTotal || Number(declaredTotal[1]) !== matrixIds.length) {
  errors.push(`Verdict total must equal ${matrixIds.length}.`);
}

const localLink = /\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g;
const links = [...audit.matchAll(localLink)].map((match) => match[1]!.split("#")[0]!).filter(Boolean);
for (const link of new Set(links)) {
  const decoded = decodeURIComponent(link.replace(/^<|>$/g, ""));
  const target = path.resolve(path.dirname(auditPath), decoded);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    errors.push(`Audit link escapes the repository: ${link}`);
    continue;
  }
  try {
    await access(target);
  } catch {
    errors.push(`Audit link target does not exist: ${link}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  `Release audit verified: ${matrixIds.length} requirements; ${actual.Implemented} implemented, ${actual.Partial} partial, ${actual.Missing} missing; ${new Set(links).size} local links resolve.`,
);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
