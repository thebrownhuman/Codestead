import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AssessmentBank,
  CodeAssessmentItem,
  CourseManifest,
} from "../src/lib/content";
import {
  WEB_BROWSER_TASKS,
  WEB_NEW_NODE_TASKS,
  WEB_NON_CODE_FACETS,
  WEB_RETAINED_NODE_SKILLS,
  type BrowserWebTaskSpec,
  type NodeWebTaskSpec,
  type WebCourseId,
} from "./content-seeds/web-executable-tranche";

interface RuntimeImages {
  readonly records: readonly {
    readonly language: string;
    readonly digest: string;
  }[];
}

const root = process.cwd();
const contentRoot = path.join(root, "content");
const bankRoot = path.join(contentRoot, "authored", "assessment-banks");
const courseIds = ["html", "css", "javascript", "react"] as const;
const retainedNode = new Set<string>(WEB_RETAINED_NODE_SKILLS);

const browserPin = {
  name: "chromium" as const,
  revision: "1228",
  version: "149.0.7827.55",
  playwrightVersion: "1.61.1",
};

function stable(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

async function loadJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function entrypoint(courseId: WebCourseId): string {
  if (courseId === "html") return "index.html";
  if (courseId === "css") return "styles.css";
  if (courseId === "react") return "App.tsx";
  return "main.js";
}

function starter(courseId: WebCourseId): string {
  if (courseId === "html") {
    return "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>TODO</title></head><body><main><!-- TODO --></main></body></html>\n";
  }
  if (courseId === "css") return "/* TODO: implement the declared bounded CSS facet. */\n";
  if (courseId === "react") {
    return "import React from \"react\";\nimport { createRoot } from \"react-dom/client\";\nfunction App(){ return <main><h1>TODO</h1></main>; }\ncreateRoot(document.getElementById(\"root\")!).render(<App/>);\n";
  }
  return "// TODO: implement the declared bounded browser behavior.\n";
}

function draftBase(skillId: string, title: string, prompt: string) {
  return {
    id: `${skillId}.code.verified-facet`,
    skillId,
    title: `${title}: verified implementation facet`,
    kind: "code" as const,
    prompt,
    points: 10,
    evidenceLevel: "apply" as const,
    examEligibility: {
      eligible: false,
      rationale: "AI-assisted authoring draft. Runtime evidence does not replace independent human standards, pedagogy, accessibility, answer-oracle, and formal-exam review.",
    },
    hints: [
      "Implement the smallest artifact that satisfies the declared observable contract, then check the visible case before considering the hidden boundary.",
    ],
    feedback: {
      correct: "The locked authoring verifier observed the declared bounded facet in both visible and hidden cases.",
      incorrect: "At least one deterministic authoring check failed; inspect the exact artifact, interaction state, viewport, and observable result without assuming hidden-case details.",
    },
    rubric: {
      passPoints: 10,
      criteria: [{
        id: "verified-facet",
        description: "Passes the visible and hidden deterministic checks for the declared implementation facet in its pinned authoring environment.",
        points: 10,
        critical: true,
      }],
    },
    privateAuthorNotes: [
      "This code item and its oracle are AI-assisted draft material with reviewer=null and examEligibility=false.",
      "Browser-verifier items are authoring evidence only and must never be routed to the official untrusted-code runner or formal exam pipeline.",
    ],
  };
}

function browserItem(args: {
  readonly courseId: WebCourseId;
  readonly skillId: string;
  readonly title: string;
  readonly description: string;
  readonly spec: BrowserWebTaskSpec;
}): CodeAssessmentItem {
  const { courseId, skillId, title, description, spec } = args;
  return {
    ...draftBase(
      skillId,
      title,
      `${description} Build a bounded artifact demonstrating ${spec.facet}; the locked browser verifier checks observable structure, behavior, or computed presentation.`,
    ),
    starterCode: starter(courseId),
    runtime: {
      engine: "browser-verifier",
      language: courseId,
      version: `${browserPin.name} ${browserPin.version} / Playwright ${browserPin.playwrightVersion}`,
      entrypoint: entrypoint(courseId),
      timeLimitMs: 5_000,
      memoryLimitMb: 256,
      browser: browserPin,
      ...(courseId === "react" ? { bundler: { name: "esbuild" as const, version: "0.25.12" } } : {}),
    },
    tests: [
      {
        id: `${skillId}.browser.visible`,
        visibility: "visible",
        category: "normal",
        stdin: stable(spec.visible),
        expectedStdout: "pass\n",
        comparison: "exact",
        critical: true,
      },
      {
        id: `${skillId}.browser.hidden`,
        visibility: "hidden",
        category: "boundary",
        stdin: stable(spec.hidden),
        expectedStdout: "pass\n",
        comparison: "exact",
        critical: true,
      },
    ],
    answer: {
      referenceSolution: spec.referenceSolution,
      explanation: `The reference is a bounded ${courseId} artifact for ${spec.facet}. Passing proves only the declared observable facet, not holistic mastery or human accessibility approval.`,
    },
  };
}

function nodeItem(args: {
  readonly skillId: string;
  readonly title: string;
  readonly spec: NodeWebTaskSpec;
  readonly javascriptDigest: string;
}): CodeAssessmentItem {
  const { skillId, title, spec, javascriptDigest } = args;
  return {
    ...draftBase(skillId, title, spec.prompt),
    starterCode: spec.starterCode,
    runtime: {
      engine: "isolated-runner",
      language: "javascript",
      version: "Node.js 22.23.1 (ECMAScript 2025)",
      imageDigest: javascriptDigest,
      entrypoint: "main.js",
      timeLimitMs: 2_000,
      memoryLimitMb: 128,
    },
    tests: spec.tests.map((test) => ({
      ...test,
      id: `${skillId}.${test.id}`,
      comparison: "exact" as const,
      critical: true,
    })),
    answer: {
      referenceSolution: spec.referenceSolution,
      explanation: `The reference implements the bounded ${spec.facet} contract with exact output in the digest-pinned Node runtime.`,
    },
  };
}

function retainedNodeItem(item: CodeAssessmentItem, javascriptDigest: string): CodeAssessmentItem {
  if (item.runtime.engine !== "isolated-runner" || item.runtime.language !== "javascript") {
    throw new Error(`${item.id} is not a retained isolated JavaScript item.`);
  }
  return {
    ...item,
    examEligibility: {
      eligible: false,
      rationale: "AI-assisted authoring draft. Digest-pinned runner evidence does not replace independent human technical, pedagogy, accessibility, answer-oracle, and formal-exam review.",
    },
    privateAuthorNotes: Array.from(new Set([
      ...item.privateAuthorNotes,
      "Reference execution is pinned to the reviewed local Node 22.23.1 runner image; the item remains human-unreviewed and exam-ineligible.",
    ])),
    runtime: {
      ...item.runtime,
      version: "Node.js 22.23.1 (ECMAScript 2025)",
      imageDigest: javascriptDigest,
    },
  };
}

async function main(): Promise<void> {
  const [courses, runtimeImages] = await Promise.all([
    Promise.all(courseIds.map((id) => loadJson<CourseManifest>(path.join(contentRoot, "courses", `${id}.json`)))),
    loadJson<RuntimeImages>(path.join(root, "scripts", "curriculum-runtime-pins.json")),
  ]);
  const javascriptDigest = runtimeImages.records.find((record) => record.language === "javascript")?.digest;
  if (!javascriptDigest || !/^sha256:[a-f0-9]{64}$/.test(javascriptDigest)) {
    throw new Error("Missing immutable JavaScript runtime digest.");
  }

  const targets = courses.flatMap((course) => course.modules.flatMap((courseModule) =>
    courseModule.skills.map((skill) => ({ course, courseModule, skill })),
  ));
  const classified = [
    ...Object.keys(WEB_BROWSER_TASKS),
    ...Object.keys(WEB_NEW_NODE_TASKS),
    ...WEB_RETAINED_NODE_SKILLS,
    ...Object.keys(WEB_NON_CODE_FACETS),
  ];
  const duplicates = classified.filter((skillId, index) => classified.indexOf(skillId) !== index);
  const declared = targets.map(({ skill }) => skill.id);
  const missing = declared.filter((skillId) => !classified.includes(skillId));
  const extra = classified.filter((skillId) => !declared.includes(skillId));
  if (duplicates.length || missing.length || extra.length) {
    throw new Error(`Web classification is not closed. duplicates=${duplicates.join(",")} missing=${missing.join(",")} extra=${extra.join(",")}`);
  }

  let changed = 0;
  let browserItems = 0;
  let newNodeItems = 0;
  let retainedNodeItems = 0;
  for (const { course, skill } of targets) {
    const filePath = path.join(bankRoot, `${skill.id}.json`);
    const bank = await loadJson<AssessmentBank>(filePath);
    if (bank.publication.stage !== "draft" || !bank.publication.aiAssisted || bank.publication.reviewer !== null) {
      throw new Error(`${bank.id} is not an AI-assisted, human-unreviewed draft.`);
    }
    if (bank.items.some((item) => item.examEligibility.eligible)) {
      throw new Error(`${bank.id} already contains an exam-eligible item.`);
    }
    const existingCode = bank.items.filter((item): item is CodeAssessmentItem => item.kind === "code");
    let replacement: CodeAssessmentItem | undefined;
    const browserSpec = WEB_BROWSER_TASKS[skill.id as keyof typeof WEB_BROWSER_TASKS];
    const nodeSpec = WEB_NEW_NODE_TASKS[skill.id as keyof typeof WEB_NEW_NODE_TASKS];
    if (browserSpec) {
      if (existingCode.length > 1 || (existingCode[0] && existingCode[0].id !== `${skill.id}.code.verified-facet`)) {
        throw new Error(`${skill.id} has an unexpected pre-existing code item.`);
      }
      replacement = browserItem({
        courseId: course.id as WebCourseId,
        skillId: skill.id,
        title: skill.title,
        description: skill.description,
        spec: browserSpec,
      });
      browserItems += 1;
    } else if (nodeSpec) {
      if (existingCode.length > 1 || (existingCode[0] && existingCode[0].id !== `${skill.id}.code.verified-facet`)) {
        throw new Error(`${skill.id} has an unexpected pre-existing code item.`);
      }
      replacement = nodeItem({ skillId: skill.id, title: skill.title, spec: nodeSpec, javascriptDigest });
      newNodeItems += 1;
    } else if (retainedNode.has(skill.id)) {
      if (existingCode.length !== 1) throw new Error(`${skill.id} must retain exactly one existing Node item.`);
      replacement = retainedNodeItem(existingCode[0]!, javascriptDigest);
      retainedNodeItems += 1;
    } else {
      const reason = WEB_NON_CODE_FACETS[skill.id as keyof typeof WEB_NON_CODE_FACETS];
      if (!reason) throw new Error(`${skill.id} has no classification.`);
      if (existingCode.length !== 0) throw new Error(`${skill.id} has code despite honest non-code classification: ${reason}`);
    }

    const updated: AssessmentBank = {
      ...bank,
      publication: {
        ...bank.publication,
        changeSummary: replacement
          ? `Original misconception and checkpoint items retained; added one AI-assisted, human-unreviewed, exam-ineligible ${replacement.runtime.engine} implementation facet with visible and hidden checks.`
          : `Original misconception and checkpoint items retained; executable evidence is intentionally absent because ${WEB_NON_CODE_FACETS[skill.id as keyof typeof WEB_NON_CODE_FACETS]}`,
      },
      items: [
        ...bank.items.filter((item) => item.kind !== "code"),
        ...(replacement ? [replacement] : []),
      ],
    };
    const before = stable(bank);
    const after = stable(updated);
    if (before !== after) {
      if (process.argv.includes("--apply")) await writeFile(filePath, after, "utf8");
      changed += 1;
    }
  }
  console.log(
    `${process.argv.includes("--apply") ? "Applied" : "Planned"} web executable tranche: ${targets.length} skills; ` +
      `${browserItems} browser, ${newNodeItems} new Node, ${retainedNodeItems} retained Node, ` +
      `${Object.keys(WEB_NON_CODE_FACETS).length} honest non-code; ${changed} banks changed.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
