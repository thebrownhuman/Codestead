import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AssessmentBank, CodeAssessmentItem, CourseManifest } from "../src/lib/content";

type Language = "c" | "cpp" | "java" | "python";
type CasePair = readonly [visibleInput: string, visibleOutput: string, hiddenInput: string, hiddenOutput: string];

const root = process.cwd();
const contentRoot = path.join(root, "content");
const languages: readonly Language[] = ["c", "cpp", "java", "python"];
const expectedModules = [
  "dsa.entry-analysis", "dsa.arrays-strings", "dsa.linked-lists", "dsa.linear-adts",
  "dsa.hashing", "dsa.search-sort", "dsa.recursion-divide", "dsa.trees", "dsa.heaps",
  "dsa.graphs-core", "dsa.graphs-advanced", "dsa.disjoint-set", "dsa.strategies",
  "dsa.problem-patterns", "dsa.transfer-quality",
] as const;

const contracts: readonly (readonly string[])[] = [
  ["Read n integers and print their sum through a named solve function.", "Read n integers and print how many are positive while maintaining a processed-prefix count invariant.", "Read n integers and print the first index whose predecessor is greater, or -1 when no inversion exists.", "Read n and print the exact number of unordered index pairs, n(n-1)/2."],
  ["Read n, a valid deletion index, and n integers; print the array after stable deletion.", "Read rows, columns, and a row-major rectangular matrix; print the main-diagonal sum through min(rows, columns).", "Read n integer symbols and print 1 when the sequence is a palindrome, otherwise 0.", "Read n, inclusive bounds l and r, and n integers; print the bounded range sum."],
  ["Build a singly linked chain from n integers and print its traversal sum.", "Read n, insertion index/value, deletion index, and n values; insert then delete while preserving link order and print the result.", "Model a doubly linked traversal and print forward and reverse position-weighted checksums.", "Read a next-index representation from node zero and print 1 when slow/fast traversal finds a cycle, otherwise 0."],
  ["Apply push for nonzero values and pop for zero values; print the final stack top or -999 when empty.", "Apply enqueue for nonzero values and dequeue for zero values; print final queue front/back or -999 -999 when empty.", "Read a deque value sequence and print whether its two-ended traversal is a palindrome.", "Treat +1 as an opening token and -1 as a closing token; print whether every prefix and the final balance are valid."],
  ["Read key/hash pairs and print whether every repeated equal key has the same hash.", "Insert keys into a fixed linear-probing table and print the number of occupied slots probed past.", "Read capacity and item count; double capacity until load is at most three quarters, then print it.", "Read n keys and print the smallest key among those with maximum frequency."],
  ["Read a sorted range and target; print the first matching index using lower-bound updates, or -1.", "Read n integers, sort them with an elementary stable insertion-style contract, and print ascending output.", "Read n integers, produce ascending divide-and-conquer-equivalent output, and preserve duplicates.", "Read n, zero-based k, and n integers; print the kth value in sorted order."],
  ["Read two integers and print their greatest common divisor using a shrinking recursive-equivalent problem.", "Read recursive countdown size n and print the number of simultaneously described frames including the base frame.", "Read n and print the nth Fibonacci value for F(0)=0 and F(1)=1.", "Read n integers and print their maximum using a divide-and-combine reduction contract."],
  ["Read a level-order tree using -999 as null and print its height.", "Read the same tree encoding and print preorder traversal.", "Read the same tree encoding and print whether it satisfies strict binary-search-tree bounds.", "Read n, a decimal prefix, and n nonnegative keys; print how many keys begin with that prefix."],
  ["Read an array-backed candidate max heap and print whether every parent dominates its children.", "Read n values, perform bottom-up max-heap construction, and print the deterministic heap array.", "Read n, k, and n values; print the k greatest values in descending priority order.", "Read n values and print ascending heapsort-equivalent output."],
  ["Read n, m, and m directed edges; print the declared vertex and edge counts.", "Read an undirected edge list and print vertex degrees in index order.", "Read an undirected edge list and print BFS distance from vertex zero, using -1 for unreachable vertices.", "Read an undirected edge list and print component count and redundant-cycle-edge count."],
  ["Read a directed graph and print its lexicographically smallest topological order, or 'cycle'.", "Read a directed weighted graph plus source/target and print shortest distance or -1.", "Read an undirected weighted graph and print minimum spanning-tree weight or -1 when disconnected.", "Read a directed weighted graph plus source/target and print the Floyd-Warshall distance or -1."],
  ["Read n and union pairs; print the final number of disjoint components.", "Read n and union pairs; print the largest resulting set size.", "Read n and union pairs; compress finds and print whether any non-root path remains represented by one edge.", "Read n and union pairs; print how many edges connected vertices already in the same set."],
  ["Read intervals and print the maximum compatible count using earliest-finish greedy selection.", "Read n, target, and positive values; print whether a subset reaches the target.", "Read n and print Fibonacci using a cached-state-equivalent recurrence.", "Read coin values and a target; print the minimum coin count or -1 when unreachable."],
  ["Read n, target, and n values; print whether two distinct positions sum to target.", "Read n, window size k, and n values; print the greatest fixed-window sum.", "Read n values and print the first greater value to the right of each, or -1.", "Read intervals and print the number remaining after sorting and merging touching overlaps."],
  ["Map n values to an idiomatic frequency table and print the smallest maximum-frequency value.", "Run the same queue command contract used to diagnose syntax/library transfer after a language switch.", "Read n values and print sorted, duplicate, minimum, and maximum adversarial-case flags.", "Solve the weighted shortest-path capstone contract and print source-to-target distance or -1."],
];

const cases: readonly (readonly CasePair[])[] = [
  [["5 1 2 3 4 5\n","15\n","4 -2 5 0 7\n","10\n"],["5 1 2 3 4 5\n","5\n","4 3 -1 3 0\n","2\n"],["5 1 2 3 4 5\n","-1\n","4 3 -1 3 0\n","1\n"],["5\n","10\n","4\n","6\n"]],
  [["5 2 10 20 30 40 50\n","10 20 40 50\n","3 0 7 8 9\n","8 9\n"],["2 3 1 2 3 4 5 6\n","6\n","3 2 1 2 3 4 5 6\n","5\n"],["5 1 2 3 2 1\n","1\n","4 1 2 3 1\n","0\n"],["5 1 3 1 2 3 4 5\n","9\n","4 0 0 -2 5 7 1\n","-2\n"]],
  [["4 1 2 3 4\n","10\n","3 -2 5 7\n","10\n"],["3 1 9 3 1 2 3\n","1 9 2\n","2 0 5 1 7 8\n","5 8\n"],["3 1 2 4\n","17 11\n","2 5 1\n","7 11\n"],["4 1 2 3 -1\n","0\n","4 1 2 1 -1\n","1\n"]],
  [["5 3 4 0 7 0\n","3\n","3 5 0 0\n","-999\n"],["5 3 4 0 7 8\n","4 8\n","4 1 0 2 0\n","-999 -999\n"],["5 1 2 3 2 1\n","1\n","4 1 2 3 1\n","0\n"],["4 1 1 -1 -1\n","1\n","3 1 -1 -1\n","0\n"]],
  [["3 1 7 2 4 1 7\n","1\n","2 1 7 1 8\n","0\n"],["5 3 1 6 11\n","3\n","7 3 1 2 3\n","0\n"],["4 4\n","8\n","8 6\n","8\n"],["6 2 1 2 3 2 1\n","2\n","4 5 4 5 4\n","4\n"]],
  [["5 3 1 3 3 8 10\n","1\n","4 2 1 3 5 7\n","-1\n"],["5 4 1 3 2 5\n","1 2 3 4 5\n","3 -1 -3 0\n","-3 -1 0\n"],["5 5 1 5 3 2\n","1 2 3 5 5\n","4 0 -2 8 3\n","-2 0 3 8\n"],["5 2 9 1 7 3 5\n","5\n","4 0 -2 8 3 1\n","-2\n"]],
  [["48 18\n","6\n","-27 9\n","9\n"],["4\n","5\n","0\n","1\n"],["10\n","55\n","0\n","0\n"],["4 3 9 -2 7\n","9\n","1 -5\n","-5\n"]],
  [["7 4 2 6 1 3 5 7\n","3\n","7 4 2 6 -999 3 -999 7\n","3\n"],["7 4 2 6 1 3 5 7\n","4 2 1 3 6 5 7\n","3 2 -999 4\n","2 4\n"],["7 4 2 6 1 3 5 7\n","1\n","3 4 5 3\n","0\n"],["4 12 123 129 45 1200\n","3\n","3 7 70 17 700\n","2\n"]],
  [["7 9 7 8 1 2 3 4\n","1\n","3 5 7 1\n","0\n"],["5 1 5 3 4 2\n","5 4 3 1 2\n","3 2 1 3\n","3 1 2\n"],["5 2 4 9 1 7 3\n","9 7\n","3 3 2 -1 5\n","5 2 -1\n"],["5 4 1 3 2 5\n","1 2 3 4 5\n","3 -1 -3 0\n","-3 -1 0\n"]],
  [["4 3 0 1 1 2 2 3\n","4 3\n","1 0\n","1 0\n"],["4 3 0 1 1 2 2 3\n","1 2 2 1\n","3 3 0 1 1 2 0 2\n","2 2 2\n"],["4 3 0 1 1 2 2 3\n","0 1 2 3\n","4 2 0 1 2 3\n","0 1 -1 -1\n"],["4 3 0 1 1 2 2 3\n","1 0\n","4 3 0 1 1 2 2 0\n","2 1\n"]],
  [["4 3 0 1 0 2 2 3\n","0 1 2 3\n","2 2 0 1 1 0\n","cycle\n"],["4 4 0 1 2 1 3 3 0 2 10 2 3 1 0 3\n","5\n","3 1 0 1 2 0 2\n","-1\n"],["4 5 0 1 1 1 2 2 2 3 1 0 3 10 0 2 4\n","4\n","3 1 0 1 5\n","-1\n"],["3 3 0 1 4 1 2 -2 0 2 10 0 2\n","2\n","2 0 0 1\n","-1\n"]],
  [["5 3 0 1 1 2 3 4\n","2\n","4 0\n","4\n"],["5 3 0 1 1 2 3 4\n","3\n","4 3 0 1 1 2 2 3\n","4\n"],["5 3 0 1 1 2 3 4\n","1\n","3 0\n","0\n"],["3 3 0 1 1 2 2 0\n","1\n","4 3 0 1 1 2 2 3\n","0\n"]],
  [["4 1 3 2 5 4 6 6 7\n","3\n","3 0 2 1 3 2 4\n","2\n"],["4 9 3 34 4 5\n","1\n","3 2 3 4 5\n","0\n"],["10\n","55\n","1\n","1\n"],["3 6 1 3 4\n","2\n","2 7 2 4\n","-1\n"]],
  [["4 9 2 7 11 15\n","1\n","3 10 1 2 3\n","0\n"],["5 3 1 4 2 10 -1\n","16\n","3 1 -5 -2 -3\n","-2\n"],["4 2 1 3 2\n","3 3 -1 -1\n","3 5 4 3\n","-1 -1 -1\n"],["4 1 3 2 5 7 8 8 9\n","2\n","3 0 1 2 3 4 5\n","3\n"]],
  [["6 2 1 2 3 2 1\n","2\n","4 5 4 5 4\n","4\n"],["5 3 4 0 7 8\n","4 8\n","4 1 0 2 0\n","-999 -999\n"],["5 1 2 2 4 7\n","1 1 1 7\n","4 3 -1 8 2\n","0 0 -1 8\n"],["4 4 0 1 2 1 3 3 0 2 10 2 3 1 0 3\n","5\n","3 1 0 1 2 0 2\n","-1\n"]],
];

const runtimeVersions: Readonly<Record<Language, string>> = {
  c: "gcc (Alpine 14.2.0) 14.2.0", cpp: "g++ (Alpine 14.2.0) 14.2.0",
  java: 'openjdk version "21.0.11" 2026-04-21 LTS', python: "Python 3.14.6",
};
const entrypoints: Readonly<Record<Language, string>> = { c: "main.c", cpp: "main.cpp", java: "Main.java", python: "main.py" };

function stableHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function main() {
  const course = JSON.parse(await readFile(path.join(contentRoot, "courses", "dsa.json"), "utf8")) as CourseManifest;
  if (course.modules.map((module) => module.id).join("|") !== expectedModules.join("|")) throw new Error("DSA module order changed; parity contracts require explicit remapping.");
  if (course.modules.some((module) => module.skills.length !== 4)) throw new Error("Every declared DSA module must map exactly four reviewed parity contracts.");
  const runtimeImages = JSON.parse(await readFile(path.join(root, "scripts", "curriculum-runtime-pins.json"), "utf8")) as { records: { language: string; digest: string }[] };
  const digestByLanguage = new Map(runtimeImages.records.map((record) => [record.language, record.digest]));
  const kernelRoot = path.join(root, "scripts", "content-seeds", "dsa-parity-kernels");
  const cKernel = await readFile(path.join(kernelRoot, "c.txt"), "utf8");
  const kernels: Record<Language, string> = {
    c: cKernel,
    cpp: (await readFile(path.join(kernelRoot, "cpp.txt"), "utf8")).replace("__C_KERNEL__", cKernel),
    java: await readFile(path.join(kernelRoot, "java.txt"), "utf8"),
    python: await readFile(path.join(kernelRoot, "python.txt"), "utf8"),
  };
  let itemCount = 0;
  for (const [group, module] of course.modules.entries()) {
    for (const [variant, skill] of module.skills.entries()) {
      const [visibleInput, visibleOutput, hiddenInput, hiddenOutput] = cases[group]![variant]!;
      const contractTests = [
        { visibility: "visible" as const, category: "normal" as const, stdin: visibleInput, expectedStdout: visibleOutput, comparison: "trimmed" as const, critical: true },
        { visibility: "hidden" as const, category: "boundary" as const, stdin: hiddenInput, expectedStdout: hiddenOutput, comparison: "trimmed" as const, critical: true },
      ];
      const contractHash = stableHash(contractTests);
      const bankPath = path.join(contentRoot, "authored", "assessment-banks", `${skill.id}.json`);
      const bank = JSON.parse(await readFile(bankPath, "utf8")) as AssessmentBank;
      const retained = bank.items.filter((item) => !(item.kind === "code" && item.parity?.parityId === `${skill.id}.parity-v1`));
      const parityItems: CodeAssessmentItem[] = languages.map((language) => {
        const digest = digestByLanguage.get(language);
        if (!digest?.match(/^sha256:[a-f0-9]{64}$/)) throw new Error(`Missing pinned local runtime digest for ${language}.`);
        const tests = contractTests.map((test) => ({ ...test, id: `${skill.id}.parity.${test.visibility}` }));
        return {
          id: `${skill.id}.code.${language}.parity-v1`, skillId: skill.id, kind: "code", points: 10,
          title: `${skill.title}: ${language.toUpperCase()} parity contract`,
          prompt: `${contracts[group]![variant]} This is the ${language.toUpperCase()} variant of one language-neutral input/output contract for ${skill.title}.`,
          evidenceLevel: "apply", examEligibility: { eligible: false, rationale: "AI-assisted four-language DSA parity draft; independent algorithm, language-idiom, test-oracle, safety, pedagogy, and accessibility review is required." },
          hints: ["Preserve the exact input/output contract and handle the visible boundary without relying on hidden values."],
          feedback: { correct: "The visible and hidden deterministic parity checks passed.", incorrect: "At least one contract check failed; inspect the invariant, boundary, and exact output without revealing hidden data." },
          rubric: { passPoints: 10, criteria: [{ id: "parity-contract", description: "Passes both equivalent normal and boundary contracts in the pinned language runtime.", points: 10, critical: true }] },
          privateAuthorNotes: ["Generated from a module-scoped numeric parity kernel. Human reviewers must confirm that this executable facet genuinely assesses the named skill and replace non-idiomatic implementation choices before approval."],
          starterCode: language === "c" ? "#include <stdio.h>\nint main(void) { /* Parse the declared numeric contract and implement solve. */ return 0; }\n" : language === "cpp" ? "#include <iostream>\nint main() { // Parse the declared numeric contract and implement solve.\n}\n" : language === "java" ? "public class Main { public static void main(String[] args) { /* Parse the declared numeric contract and implement solve. */ } }\n" : "import sys\n# Parse the declared numeric contract and implement solve.\n",
          runtime: { engine: "isolated-runner", language, version: runtimeVersions[language], imageDigest: digest, entrypoint: entrypoints[language], timeLimitMs: 3000, memoryLimitMb: 128 },
          parity: { parityId: `${skill.id}.parity-v1`, contractVersion: "1.0.0", language, equivalentLanguages: ["c", "cpp", "java", "python"], testContractHash: contractHash, facet: "executable-contract" },
          tests,
          answer: { referenceSolution: kernels[language].replaceAll("__TASK__", String(group * 4 + variant)), explanation: `The pinned ${language} reference executes parity contract ${skill.id}.parity-v1. It is deterministic draft evidence, not proof of pedagogy, idiomatic style, or exam readiness.` },
        };
      });
      const updated: AssessmentBank = {
        ...bank,
        publication: { ...bank.publication, changeSummary: `Added four pinned-runtime executable parity drafts for ${skill.title}; all remain blocked from formal exams pending independent human review.` },
        items: [...retained, ...parityItems],
      };
      if (process.argv.includes("--apply")) await writeFile(bankPath, `${JSON.stringify(updated, null, 2)}\n`);
      itemCount += parityItems.length;
    }
  }
  const declaration = { generatedAt: new Date().toISOString(), courseId: "dsa", courseVersion: course.version, skillCount: 60, languages, parityItemCount: itemCount, visibleTests: itemCount, hiddenTests: itemCount, examEligibleItems: 0, runtimeDigests: Object.fromEntries(languages.map((language) => [language, digestByLanguage.get(language)])), limitation: "AI-assisted module-scoped numeric kernels require independent skill-fit, idiom, oracle, safety, pedagogy, and accessibility review; this artifact is not publication approval." };
  if (process.argv.includes("--apply")) await writeFile(path.join(root, "docs", "evidence", "dsa-parity-declaration-2026-07-12.json"), `${JSON.stringify(declaration, null, 2)}\n`);
  console.log(`DSA parity ${process.argv.includes("--apply") ? "generated" : "validated"}: ${itemCount} draft code items across 60 skills and 4 languages; 0 exam eligible.`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
