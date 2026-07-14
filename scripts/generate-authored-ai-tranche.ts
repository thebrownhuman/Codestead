import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AssessmentBank, AuthoredLesson, AtomicSkill, CourseManifest, CourseModule } from "../src/lib/content";
import {
  applyBeginnerQualityTemplate,
  createBeginnerQualityContext,
} from "../src/lib/content/beginner-quality";
import { AI_CODE_TASKS } from "./content-seeds/ai-code-tasks";
import { AI_TRANCHE_SEEDS, type AiTeachingSeed } from "./content-seeds/ai-tranche";
import type { JavaPythonCodeTask } from "./content-seeds/java-python-code-tasks";
import { PINNED_CURRICULUM_RUNTIMES } from "./pinned-curriculum-runtime";

const contentRoot = path.join(process.cwd(), "content");
const lessonRoot = path.join(contentRoot, "authored", "lessons");
const bankRoot = path.join(contentRoot, "authored", "assessment-banks");
const PYTHON_RUNNER_IMAGE_DIGEST = PINNED_CURRICULUM_RUNTIMES.python.imageDigest;

interface ModuleProfile {
  readonly frame: string;
  readonly usefulFor: string;
  readonly limitation: string;
}

const MODULE_PROFILES: Readonly<Record<string, ModuleProfile>> = {
  "ai.foundations": { frame: "a map that labels what an automated system observes, claims, chooses, and cannot establish", usefulFor: "separating techniques, environments, agents, evidence, and historical limits", limitation: "maps simplify contested intelligence concepts and cannot turn benchmark evidence into general capability" },
  "ai.search": { frame: "a route planner that tracks states, legal moves, accumulated cost, estimates, and an ordered frontier", usefulFor: "state-space representation, frontier policies, heuristics, and adversarial backup", limitation: "real environments can be continuous, stochastic, changing, partially observed, or too large for the simplified route model" },
  "ai.knowledge-uncertainty": { frame: "an evidence board that distinguishes explicit facts, supported rule chains, missing knowledge, probabilities, and dependency assumptions", usefulFor: "symbolic representation, inference, Bayesian updating, and graphical dependencies", limitation: "encoded facts can be incomplete or inconsistent and probabilistic edges do not automatically establish causation" },
  "ai.planning-decision": { frame: "a bounded operations desk that checks action preconditions, resource constraints, uncertain outcomes, and proxy rewards before acting", usefulFor: "planning, constraints, expected utility, and sequential decisions", limitation: "real preferences, uncertainty, stakeholders, safety constraints, and dynamics exceed one plan or reward score" },
  "ai.data-workflow": { frame: "a provenance-controlled laboratory that defines the decision, inspects samples and labels, derives transformations, and seals evaluation partitions", usefulFor: "problem framing, data quality, preprocessing, and leakage control", limitation: "clean procedures cannot recover absent populations, authorize data, or make a harmful target appropriate" },
  "ai.supervised": { frame: "a measured prediction workshop that compares a simple baseline with several fitted rules on held-out outcomes", usefulFor: "regression, classification, model assumptions, and generalization", limitation: "prediction evidence does not establish causation, fairness, or unchanged performance after deployment" },
  "ai.unsupervised": { frame: "an exploratory sorting table whose representation, distance, projection, reference population, and exposure policy determine visible patterns", usefulFor: "clustering, dimensionality reduction, anomaly scoring, and recommendation", limitation: "algorithmic groups and outliers are parameter-dependent summaries rather than discovered human categories or harms" },
  "ai.neural": { frame: "a layered numeric circuit whose weights, biases, activations, loss, and updates can be traced on a tiny example", usefulFor: "forward passes, gradient updates, regularization evidence, and architectural roles", limitation: "a toy circuit does not explain large-network representations, training data, emergent behavior, or deployment safety" },
  "ai.applications": { frame: "a sensing-and-decision pipeline that names modality inputs, task outputs, affected populations, operating conditions, and fallback paths", usefulFor: "NLP, vision, robotics, and multimodal evaluation", limitation: "more modalities or fluent outputs do not establish understanding, truth, physical safety, or universal coverage" },
  "ai.generative": { frame: "a bounded document desk that predicts tokens, validates structured drafts, retrieves cited passages, and exposes only authorized tools", usefulFor: "language-model context, output validation, RAG stages, and API/tool security", limitation: "generation, retrieval, prompting, and provider trust remain fallible and cannot receive secrets or autonomous authority" },
  "ai.evaluation-risk": { frame: "an evidence and risk register linking metrics, stress cases, affected slices, accountable owners, controls, monitors, and stop decisions", usefulFor: "evaluation, robustness, fairness, explanations, and lifecycle governance", limitation: "no metric suite or framework checklist certifies safety, fairness, causality, or future robustness" },
  "ai.project": { frame: "a reviewable experiment package containing scope, baseline, data/version manifests, evaluation, model card, risk register, and reproduction commands", usefulFor: "project design, reproducibility, oversight documentation, and capstone defense", limitation: "documentation and a polished demo are bounded evidence, not production authorization or proof of safe capability" },
};

const SOURCE_SECTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "cs2023-ai": {
    "ai.foundations": "AI Knowledge Area: fundamental issues, intelligent agents, history, and societal context",
    "ai.search": "Fundamental Issues and Basic Search Strategies: state spaces, uninformed/informed, and adversarial search",
    "ai.knowledge-uncertainty": "Knowledge Representation and Reasoning plus Reasoning Under Uncertainty",
    "ai.planning-decision": "Planning Systems, Constraint Satisfaction, Decision Making, and Reinforcement Learning foundations",
    "ai.data-workflow": "Machine Learning foundations: problem formulation, data, representation, and evaluation",
    "ai.supervised": "Machine Learning: supervised methods, model families, validation, and generalization",
    "ai.unsupervised": "Machine Learning: unsupervised methods, clustering, dimensionality, and recommendation concepts",
    "ai.neural": "Machine Learning and Neural Networks: units, optimization, generalization, and architecture families",
    "ai.applications": "Perception and application areas: language, vision, robotics, and integrated systems",
    "ai.generative": "Natural Language Processing and contemporary generative-system foundations as bounded by the 2023 curriculum",
    "ai.evaluation-risk": "AI ethics, societal impact, evaluation, and responsible-system learning outcomes",
    "ai.project": "Integrated AI project, evaluation, and professional-practice outcomes",
  },
  "cs2023-msf": { "ai.knowledge-uncertainty": "Probability, conditional probability, Bayes theorem, logic, relations, and graphical-model mathematical foundations" },
  "nist-ai-rmf": {
    "ai.foundations": "AI RMF 1.0 sections 1-4: risk framing, audience, effectiveness, and trustworthy characteristics",
    "ai.planning-decision": "AI RMF Map and Measure outcomes for context, impacts, human values, and risk tolerances",
    "ai.data-workflow": "AI RMF Map/Measure outcomes for context, data, affected populations, validity, and measurement",
    "ai.unsupervised": "AI RMF Map/Measure outcomes for context, harmful bias, feedback, monitoring, and affected stakeholders",
    "ai.neural": "AI RMF Measure outcomes for validity, reliability, reproducibility, robustness, and uncertainty",
    "ai.applications": "AI RMF Map/Measure/Manage outcomes for sociotechnical context, testing conditions, safety, and fallback",
    "ai.generative": "AI RMF Govern/Map/Measure/Manage outcomes applied to provider, data, tool, and deployment boundaries",
    "ai.evaluation-risk": "AI RMF Core: Govern, Map, Measure, and Manage functions and trustworthiness characteristics",
    "ai.project": "AI RMF lifecycle profiles, documentation, accountability, monitoring, residual risk, and management outcomes",
  },
  "nist-genai": {
    "ai.applications": "NIST AI 600-1 Generative AI Profile: multimodal, provenance, confabulation, and human-AI configuration risks",
    "ai.generative": "NIST AI 600-1 risk sections and suggested actions for confabulation, information integrity, security, privacy, and misuse",
    "ai.evaluation-risk": "NIST AI 600-1 measurement, red-teaming, incident, content provenance, and monitoring suggested actions",
    "ai.project": "NIST AI 600-1 governance, documentation, measurement, human oversight, and deployment risk actions",
  },
  sklearn: {
    "ai.data-workflow": "User Guide sections 3 and 7: model selection, pipelines, preprocessing, imputation, and leakage-safe evaluation",
    "ai.supervised": "User Guide sections 1 and 3: supervised estimators, validation, thresholding, metrics, and learning curves",
    "ai.unsupervised": "User Guide sections 2, 3.4.7, and 7.5: clustering, novelty/outlier detection, decomposition, and evaluation",
    "ai.evaluation-risk": "User Guide sections 3 and 5: metrics, scoring, cross-validation, inspection, uncertainty, and baselines",
    "ai.project": "Getting Started plus User Guide sections 3 and 7: pipelines, reproducible estimator configuration, and evaluation",
  },
  transformers: {
    "ai.neural": "Transformers documentation: attention-based architecture roles, model inputs, finite context, and compute trade-offs",
    "ai.applications": "Transformers Tasks and Tokenizer documentation for bounded NLP, vision, audio, and multimodal application workflows",
    "ai.generative": "Transformers Tokenizers and Text Generation documentation: tokens, context inputs, decoding, and retrieval-related components",
  },
  "rag-paper": { "ai.generative": "Lewis et al. (2020), abstract and method sections: parametric plus non-parametric memory, retrieval, generation, and provenance motivation" },
};

function publication(summary: string) {
  return {
    stage: "draft" as const,
    author: { id: "codex-assisted-ai", displayName: "Codex-assisted AI Foundations tranche", kind: "ai-assisted" as const },
    authoredAt: "2026-07-12T09:30:00.000Z",
    aiAssisted: true,
    reviewer: null,
    changeSummary: summary,
  };
}

async function loadCourse(): Promise<CourseManifest> {
  return JSON.parse(await readFile(path.join(contentRoot, "courses", "ai.json"), "utf8")) as CourseManifest;
}

function locator(sourceRef: string, moduleId: string, sourceTitle: string, version: string, skillTitle: string): string {
  const sections = SOURCE_SECTIONS[sourceRef];
  const section = sections?.[moduleId];
  if (!section) throw new Error(`Missing AI source locator profile for ${sourceRef}:${moduleId}.`);
  return `${sourceTitle}; ${version}; ${section}; atomic topic: ${skillTitle}`;
}

function buildLesson(course: CourseManifest, courseModule: CourseModule, skill: AtomicSkill, seed: AiTeachingSeed): AuthoredLesson {
  const profile = MODULE_PROFILES[courseModule.id];
  if (!profile) throw new Error(`Missing AI module profile for ${courseModule.id}.`);
  const sourceById = new Map(course.authoritative_sources.map((source) => [source.id, source]));
  const misconceptionId = `${skill.id}.misconception`;
  return {
    $schema: "../../schema/authored-lesson.schema.json",
    format: "authored-lesson",
    schemaVersion: "1.0.0",
    id: `lesson.${skill.id}.v1`,
    courseId: course.id,
    courseVersion: course.version,
    moduleId: courseModule.id,
    skillId: skill.id,
    title: skill.title,
    publication: publication(`Source-linked AI Foundations draft for ${skill.title}; all claims, examples, metrics, code, safety boundaries, and answer oracles require independent human review.`),
    sources: skill.source_refs.map((sourceRef) => {
      const source = sourceById.get(sourceRef);
      if (!source) throw new Error(`${skill.id} references missing source ${sourceRef}.`);
      return { sourceRef, locator: locator(sourceRef, courseModule.id, source.title, source.version_or_date, skill.title), claim: seed.model };
    }),
    canonicalExplanation: {
      summary: seed.model,
      sections: [
        { heading: "Bounded operational model", body: `${seed.model} Any capability or quality claim remains limited to an explicit task, population, conditions, baseline, and recorded evidence.` },
        { heading: "Failure boundary and non-claim", body: `${seed.boundary} The learner must reject this overclaim: ${seed.misconception}` },
      ],
    },
    scope: { includes: [skill.description, ...skill.outcomes], excludes: [seed.boundary] },
    outcomes: skill.outcomes,
    examples: [
      { id: `${skill.id}.example.direct`, title: `${skill.title}: bounded direct case`, situation: seed.scenarioA, walkthrough: [`Observe the exact data, state, metric, or tool behavior: ${seed.scenarioA}`, `Apply the source-bounded model: ${seed.model}`, `Verify the claim boundary with: ${seed.correction}`], result: `This example supports only the atomic outcome because ${seed.correction}` },
      { id: `${skill.id}.example.stress`, title: `${skill.title}: stress and transfer case`, situation: seed.scenarioB, walkthrough: [`Name the changed population, input, assumption, or failure: ${seed.scenarioB}`, `Keep the non-claim visible: ${seed.boundary}`, `Reject the tempting overclaim: ${seed.misconception}`], result: `The stress case limits rather than expands the source-bounded model: ${seed.model}` },
    ],
    misconceptions: [{ id: misconceptionId, mistakenBelief: seed.misconception, correction: seed.correction, diagnosticPrompt: `Identify the first unsupported inference in this belief and the evidence required to narrow it: ${seed.misconception}` }],
    analogy: { optional: true, example: `${profile.frame} can introduce ${skill.title} only after its canonical technical definition and evidence boundary are stated.`, usefulFor: [profile.usefulFor], limitations: [profile.limitation, seed.boundary], canonicalExplanationStandsAlone: true },
    trace: {
      artifact: [seed.scenarioA, seed.model, seed.correction],
      steps: [
        { step: 1, focus: "Observe", state: { boundedEvidence: seed.scenarioA }, explanation: "Record the actual input, state, assumption, metric, or output without adding a capability or causal claim." },
        { step: 2, focus: "Model", state: { operationalRule: seed.model }, explanation: "Apply the declared technical model and retain its data, task, environment, stakeholder, and evaluation assumptions." },
        { step: 3, focus: "Limit", state: { correction: seed.correction }, explanation: `State what the evidence does not establish and reject the misconception: ${seed.misconception}` },
      ],
      textAlternative: `Observe this bounded case: ${seed.scenarioA} Apply this operational model: ${seed.model} Limit the conclusion using: ${seed.correction}`,
    },
    practice: {
      faded: { prompt: `Complete a claim-evidence-boundary trace for: ${seed.scenarioA}`, scaffold: ["Name only the observed evidence.", `Apply the ${skill.title} model.`, "State one supported claim and one non-claim."], expectedEvidence: [skill.outcomes[0]!, seed.correction] },
      nearTransfer: { prompt: `Apply the same skill to this changed case: ${seed.scenarioB}`, scaffold: ["Identify which assumption, population, input, or objective changed.", "Preserve provenance and the declared failure boundary."], expectedEvidence: [seed.model, seed.boundary] },
      farTransfer: { prompt: `Design a neutral-context example or evaluation for ${skill.title} and list the evidence that would support and falsify its bounded claim.`, scaffold: ["Do not reuse the optional analogy.", "Include baseline, conditions, affected stakeholders, and a stop or fallback condition where relevant."], expectedEvidence: [...skill.outcomes, seed.correction] },
    },
    remediation: [{ misconceptionId, explanation: seed.correction, retryPrompt: `Re-evaluate the stress case, replace the overclaim with a bounded claim, and name missing evidence: ${seed.scenarioB}` }],
    recap: { summary: `${seed.model} The critical limitation is: ${seed.boundary}`, retrievalPrompts: [`Explain ${skill.title} with one technical mechanism, one evidence requirement, and one non-claim.`, `Why is this overclaim invalid: ${seed.misconception}`, `Apply the boundary to: ${seed.scenarioB}`], nextReviewPrompt: `On delayed review, retrieve the model, checkpoint '${seed.checkpoint}', failure boundary, and one responsible stop condition without reopening the lesson.` },
  };
}

const blocked = "AI-assisted unreviewed draft; independent human technical, source, pedagogy, safety, accessibility, and answer-oracle review is required before formal-exam eligibility.";

function buildCodeItem(skill: AtomicSkill, item: JavaPythonCodeTask) {
  return {
    id: `${skill.id}.code.offline`, skillId: skill.id, title: `${skill.title}: deterministic offline Python lab`, kind: "code" as const, prompt: item.prompt, points: 8, evidenceLevel: "apply" as const,
    examEligibility: { eligible: false, rationale: blocked },
    hints: ["Implement only the stated offline contract, run the visible boundary, and do not infer a real model, safety, fairness, or deployment claim from this toy result."],
    feedback: { correct: "The deterministic offline reference checks match the bounded contract; this does not establish real-world AI quality or safety.", incorrect: "At least one deterministic check differs; inspect parsing, algorithm assumptions, boundary behavior, and exact output before retrying." },
    rubric: { passPoints: 8, criteria: [{ id: "offline-contract", description: "Passes all visible and hidden deterministic offline tests while preserving the stated evidence and non-claim boundary.", points: 8, critical: true }] },
    privateAuthorNotes: ["Offline stdlib-only task. Human reviewer must verify algorithm, fixtures, overclaim boundary, and educational validity before any exam use."],
    starterCode: item.starterCode,
    runtime: {
      engine: "isolated-runner" as const,
      language: "python" as const,
      version: "Python 3.14",
      imageDigest: PYTHON_RUNNER_IMAGE_DIGEST,
      entrypoint: "main.py",
      timeLimitMs: 2_000,
      memoryLimitMb: 128,
    },
    tests: item.tests.map((testCase, index) => ({ id: `${skill.id}.case.${index + 1}`, visibility: index === 0 ? "visible" as const : "hidden" as const, category: testCase.category, stdin: testCase.stdin, expectedStdout: testCase.expectedStdout, comparison: "trimmed" as const, critical: true })),
    answer: { referenceSolution: item.referenceSolution, explanation: item.explanation },
  };
}

function buildBank(course: CourseManifest, courseModule: CourseModule, skill: AtomicSkill, seed: AiTeachingSeed): AssessmentBank {
  if (!seed.correction.includes(seed.checkpoint)) throw new Error(`${skill.id}: checkpoint is absent from correction.`);
  const code = AI_CODE_TASKS[skill.id as keyof typeof AI_CODE_TASKS] as JavaPythonCodeTask | undefined;
  const items: AssessmentBank["items"][number][] = [
    { id: `${skill.id}.mcq.misconception`, skillId: skill.id, title: `${skill.title}: reject the overclaim`, kind: "mcq", prompt: `Which statement is source-bounded and corrects this AI misconception? ${seed.misconception}`, points: 4, evidenceLevel: "interpret", examEligibility: { eligible: false, rationale: blocked }, hints: ["Choose the statement that names mechanism, evidence conditions, and the boundary of the claim rather than a fluent or benchmark-based overgeneralization."], feedback: { correct: `Correct. ${seed.correction}`, incorrect: `That option preserves the overclaim. ${seed.correction}` }, rubric: { passPoints: 4, criteria: [{ id: "bounded-correction", description: "Selects the source-bounded correction and rejects the documented AI overclaim.", points: 4, critical: true }] }, privateAuthorNotes: ["Human reviewer must verify the correction against cited sources and ensure the distractor does not normalize unsafe or overstated claims."], options: [{ id: "bounded", text: seed.correction }, { id: "overclaim", text: seed.misconception }], answer: { correctOptionIds: ["bounded"], explanation: seed.correction } },
    { id: `${skill.id}.fill.checkpoint`, skillId: skill.id, title: `${skill.title}: canonical evidence boundary`, kind: "fill-gap", prompt: "Complete the exact source-bounded correction phrase; the complete sentence must remain an honest beginner-to-intermediate claim.", points: 4, evidenceLevel: "recall", examEligibility: { eligible: false, rationale: blocked }, hints: ["Retrieve the short checkpoint from the correction and ensure it narrows rather than expands the evidence claim."], feedback: { correct: `Correct. The checkpoint is '${seed.checkpoint}'. ${seed.correction}`, incorrect: `The phrase must preserve the technical and responsible-AI boundary. ${seed.correction}` }, rubric: { passPoints: 4, criteria: [{ id: "boundary-phrase", description: "Supplies the exact canonical phrase that completes the bounded source-aligned correction.", points: 4, critical: true }] }, privateAuthorNotes: ["Human reviewer must verify the accepted phrase and technically equivalent variants before learner use."], template: seed.correction.replace(seed.checkpoint, "[[checkpoint]]"), gaps: [{ id: "checkpoint", label: "Bounded canonical phrase" }], answer: { acceptedByGap: { checkpoint: [seed.checkpoint] }, caseSensitive: false, explanation: seed.correction } },
  ];
  if (code) items.push(buildCodeItem(skill, code));
  return { $schema: "../../schema/assessment-bank.schema.json", format: "assessment-bank", schemaVersion: "1.0.0", id: `bank.${skill.id}.v1`, courseId: course.id, courseVersion: course.version, moduleId: courseModule.id, skillId: skill.id, title: `${skill.title} deterministic AI draft bank`, publication: publication(`Misconception MCQ, evidence-boundary fill-gap${code ? ", and deterministic offline Python lab" : ""} for ${skill.title}; all items remain blocked from formal exams pending independent human review.`), sourceRefs: skill.source_refs, items };
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function writeGenerated(filePath: string, value: unknown, overwrite: boolean): Promise<void> {
  if (!overwrite && await exists(filePath)) throw new Error(`Refusing to overwrite existing AI authored content: ${filePath}`);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const course = await loadCourse();
  const targets = course.modules.flatMap((courseModule) => courseModule.skills.map((skill) => ({ courseModule, skill })));
  const expected = targets.map(({ skill }) => skill.id).sort();
  const supplied = Object.keys(AI_TRANCHE_SEEDS).sort();
  if (JSON.stringify(expected) !== JSON.stringify(supplied)) {
    const expectedSet = new Set(expected); const suppliedSet = new Set(supplied);
    throw new Error(`AI teaching seed mismatch. Missing: ${expected.filter((id) => !suppliedSet.has(id)).join(", ") || "none"}. Extra: ${supplied.filter((id) => !expectedSet.has(id)).join(", ") || "none"}.`);
  }
  const codeIds = Object.keys(AI_CODE_TASKS).sort();
  const invalidCodeIds = codeIds.filter((id) => !expected.includes(id));
  if (invalidCodeIds.length) throw new Error(`AI code task references non-AI skill: ${invalidCodeIds.join(", ")}.`);
  if (!process.argv.includes("--apply")) {
    console.log(`Validated ${targets.length} AI teaching seeds and ${codeIds.length} deterministic offline Python tasks. Re-run with --apply to generate drafts.`);
    return;
  }
  const overwrite = process.argv.includes("--overwrite");
  await Promise.all([mkdir(lessonRoot, { recursive: true }), mkdir(bankRoot, { recursive: true })]);
  for (const { courseModule, skill } of targets) {
    const seed = AI_TRANCHE_SEEDS[skill.id as keyof typeof AI_TRANCHE_SEEDS];
    const lesson = applyBeginnerQualityTemplate(
      buildLesson(course, courseModule, skill, seed),
      createBeginnerQualityContext(course, courseModule, skill),
    );
    await writeGenerated(path.join(lessonRoot, `${skill.id}.json`), lesson, overwrite);
    await writeGenerated(path.join(bankRoot, `${skill.id}.json`), buildBank(course, courseModule, skill, seed), overwrite);
  }
  console.log(`Generated ${targets.length} AI draft lessons and banks with ${codeIds.length} deterministic offline Python labs.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
