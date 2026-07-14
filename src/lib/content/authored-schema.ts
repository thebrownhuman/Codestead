import { z } from "zod";

import {
  ASSESSMENT_ITEM_KINDS,
  AUTHORED_CONTENT_SCHEMA_VERSION,
  PUBLICATION_STAGES,
  type AssessmentBank,
  type AuthoredLesson,
} from "./authored-types";

const nonEmpty = z.string().trim().min(1);
const meaningful = z.string().trim().min(12);
const identifier = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)*$/);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const timestamp = z.string().datetime({ offset: true });

const contributorSchema = z.object({
  id: identifier,
  displayName: nonEmpty,
  kind: z.enum(["human", "ai-assisted"]),
}).strict();

const reviewerSchema = z.object({
  id: identifier,
  displayName: nonEmpty,
  kind: z.literal("human"),
  reviewedAt: timestamp,
  reviewVersion: semver,
}).strict();

export const publicationRecordSchema = z.object({
  stage: z.enum(PUBLICATION_STAGES),
  author: contributorSchema,
  authoredAt: timestamp,
  aiAssisted: z.boolean(),
  reviewer: reviewerSchema.nullable(),
  changeSummary: meaningful,
}).strict().superRefine((publication, context) => {
  const reviewedStage = publication.stage === "approved" ||
    publication.stage === "published" || publication.stage === "retired";
  if (reviewedStage && publication.reviewer === null) {
    context.addIssue({
      code: "custom",
      path: ["reviewer"],
      message: `${publication.stage} content requires an attributable human review.`,
    });
  }
  if (publication.author.kind === "ai-assisted" && !publication.aiAssisted) {
    context.addIssue({
      code: "custom",
      path: ["aiAssisted"],
      message: "AI-assisted authorship cannot be labeled as non-AI-assisted.",
    });
  }
});

const sourceCitationSchema = z.object({
  sourceRef: identifier,
  locator: meaningful,
  claim: meaningful,
}).strict();

const practicePromptSchema = z.object({
  prompt: meaningful,
  scaffold: z.array(nonEmpty).min(1),
  expectedEvidence: z.array(nonEmpty).min(1),
}).strict();

export const authoredLessonSchema = z.object({
  $schema: nonEmpty,
  format: z.literal("authored-lesson"),
  schemaVersion: z.literal(AUTHORED_CONTENT_SCHEMA_VERSION),
  id: identifier,
  courseId: identifier,
  courseVersion: semver,
  moduleId: identifier,
  skillId: identifier,
  title: z.string().trim().min(3),
  publication: publicationRecordSchema,
  sources: z.array(sourceCitationSchema).min(1),
  canonicalExplanation: z.object({
    summary: meaningful,
    sections: z.array(z.object({
      heading: z.string().trim().min(3),
      body: meaningful,
    }).strict()).min(2),
  }).strict(),
  scope: z.object({
    includes: z.array(nonEmpty).min(1),
    excludes: z.array(nonEmpty).min(1),
  }).strict(),
  outcomes: z.array(meaningful).min(1),
  examples: z.array(z.object({
    id: identifier,
    title: z.string().trim().min(3),
    situation: meaningful,
    walkthrough: z.array(nonEmpty).min(2),
    result: meaningful,
  }).strict()).min(2),
  misconceptions: z.array(z.object({
    id: identifier,
    mistakenBelief: meaningful,
    correction: meaningful,
    diagnosticPrompt: meaningful,
  }).strict()).min(1),
  analogy: z.object({
    optional: z.literal(true),
    example: meaningful,
    usefulFor: z.array(nonEmpty).min(1),
    limitations: z.array(nonEmpty).min(1),
    canonicalExplanationStandsAlone: z.literal(true),
  }).strict(),
  trace: z.object({
    artifact: z.array(nonEmpty).min(1),
    steps: z.array(z.object({
      step: z.number().int().positive(),
      focus: nonEmpty,
      state: z.record(z.string(), z.string()),
      explanation: meaningful,
    }).strict()).min(2),
    textAlternative: meaningful,
  }).strict(),
  practice: z.object({
    faded: practicePromptSchema,
    nearTransfer: practicePromptSchema,
    farTransfer: practicePromptSchema,
  }).strict(),
  remediation: z.array(z.object({
    misconceptionId: identifier,
    explanation: meaningful,
    retryPrompt: meaningful,
  }).strict()).min(1),
  recap: z.object({
    summary: meaningful,
    retrievalPrompts: z.array(meaningful).min(2),
    nextReviewPrompt: meaningful,
  }).strict(),
}).strict().superRefine((lesson, context) => {
  const misconceptionIds = new Set(lesson.misconceptions.map((item) => item.id));
  for (const [index, branch] of lesson.remediation.entries()) {
    if (!misconceptionIds.has(branch.misconceptionId)) {
      context.addIssue({
        code: "custom",
        path: ["remediation", index, "misconceptionId"],
        message: "Remediation must reference a misconception declared by this lesson.",
      });
    }
  }
  const steps = lesson.trace.steps.map((step) => step.step);
  if (steps.some((step, index) => step !== index + 1)) {
    context.addIssue({
      code: "custom",
      path: ["trace", "steps"],
      message: "Trace step numbers must be contiguous and start at 1.",
    });
  }
});

const rubricSchema = z.object({
  passPoints: z.number().int().positive(),
  criteria: z.array(z.object({
    id: identifier,
    description: meaningful,
    points: z.number().int().positive(),
    critical: z.boolean(),
  }).strict()).min(1),
}).strict();

const examEligibilitySchema = z.object({
  eligible: z.boolean(),
  rationale: meaningful,
}).strict();

const feedbackSchema = z.object({
  correct: meaningful,
  incorrect: meaningful,
}).strict();

const misconceptionMappingSchema = z.object({
  tag: identifier,
  answers: z.array(nonEmpty).min(1),
}).strict();

const baseItemShape = {
  id: identifier,
  skillId: identifier,
  title: z.string().trim().min(3),
  kind: z.enum(ASSESSMENT_ITEM_KINDS),
  prompt: meaningful,
  points: z.number().int().positive(),
  evidenceLevel: z.enum(["recall", "interpret", "apply", "transfer"]),
  examEligibility: examEligibilitySchema,
  hints: z.array(meaningful).min(1),
  feedback: feedbackSchema,
  rubric: rubricSchema,
  privateAuthorNotes: z.array(nonEmpty),
  misconceptionMappings: z.array(misconceptionMappingSchema).min(1).optional(),
};

const mcqItemSchema = z.object({
  ...baseItemShape,
  kind: z.literal("mcq"),
  options: z.array(z.object({ id: identifier, text: nonEmpty }).strict()).min(2),
  answer: z.object({
    correctOptionIds: z.array(identifier).min(1),
    explanation: meaningful,
  }).strict(),
}).strict();

const traceItemSchema = z.object({
  ...baseItemShape,
  kind: z.literal("trace"),
  artifact: z.array(nonEmpty).min(1),
  answer: z.object({
    acceptedTraces: z.array(nonEmpty).min(1),
    caseSensitive: z.boolean(),
    explanation: meaningful,
  }).strict(),
}).strict();

const fillGapItemSchema = z.object({
  ...baseItemShape,
  kind: z.literal("fill-gap"),
  template: meaningful,
  gaps: z.array(z.object({ id: identifier, label: nonEmpty }).strict()).min(1),
  answer: z.object({
    acceptedByGap: z.record(z.string(), z.array(nonEmpty).min(1)),
    caseSensitive: z.boolean(),
    explanation: meaningful,
  }).strict(),
}).strict();

const runnerTestSchema = z.object({
  id: identifier,
  visibility: z.enum(["visible", "hidden"]),
  category: z.enum(["normal", "boundary", "invalid", "performance"]),
  stdin: z.string(),
  expectedStdout: z.string(),
  comparison: z.enum(["exact", "trimmed"]),
  critical: z.boolean(),
}).strict();

const codeItemSchema = z.object({
  ...baseItemShape,
  kind: z.literal("code"),
  starterCode: z.string().min(1),
  runtime: z.discriminatedUnion("engine", [
    z.object({
      engine: z.literal("isolated-runner"),
      language: z.enum(["c", "cpp", "java", "python", "javascript"]),
      version: nonEmpty,
      imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
      entrypoint: nonEmpty,
      timeLimitMs: z.number().int().min(100).max(30_000),
      memoryLimitMb: z.number().int().min(16).max(1024),
    }).strict(),
    z.object({
      engine: z.literal("browser-verifier"),
      language: z.enum(["html", "css", "javascript", "react"]),
      version: nonEmpty,
      entrypoint: nonEmpty,
      timeLimitMs: z.number().int().min(100).max(30_000),
      memoryLimitMb: z.number().int().min(16).max(1024),
      browser: z.object({
        name: z.literal("chromium"),
        revision: nonEmpty,
        version: nonEmpty,
        playwrightVersion: semver,
      }).strict(),
      bundler: z.object({
        name: z.literal("esbuild"),
        version: semver,
      }).strict().optional(),
    }).strict(),
  ]),
  parity: z.object({
    parityId: identifier,
    contractVersion: semver,
    language: z.enum(["c", "cpp", "java", "python"]),
    equivalentLanguages: z.tuple([
      z.literal("c"),
      z.literal("cpp"),
      z.literal("java"),
      z.literal("python"),
    ]),
    testContractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    facet: z.literal("executable-contract"),
  }).strict().optional(),
  tests: z.array(runnerTestSchema).min(2),
  answer: z.object({
    referenceSolution: z.string().min(1),
    explanation: meaningful,
  }).strict(),
}).strict();

const assessmentItemSchema = z.discriminatedUnion("kind", [
  mcqItemSchema,
  traceItemSchema,
  fillGapItemSchema,
  codeItemSchema,
]).superRefine((item, context) => {
  const rubricPoints = item.rubric.criteria.reduce((total, criterion) => total + criterion.points, 0);
  if (rubricPoints !== item.points || item.rubric.passPoints > item.points) {
    context.addIssue({
      code: "custom",
      path: ["rubric"],
      message: "Rubric criteria must total item points and passPoints cannot exceed item points.",
    });
  }
  const misconceptionMappings = item.misconceptionMappings ?? [];
  const misconceptionTags = misconceptionMappings.map((mapping) => mapping.tag);
  if (new Set(misconceptionTags).size !== misconceptionTags.length) {
    context.addIssue({
      code: "custom",
      path: ["misconceptionMappings"],
      message: "Misconception mapping tags must be unique within an item.",
    });
  }
  if (item.kind === "mcq") {
    const optionIds = new Set(item.options.map((option) => option.id));
    if (item.answer.correctOptionIds.some((id) => !optionIds.has(id))) {
      context.addIssue({
        code: "custom",
        path: ["answer", "correctOptionIds"],
        message: "Every correct option must exist in options.",
      });
    }
    if (misconceptionMappings.length > 0 && item.answer.correctOptionIds.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["misconceptionMappings"],
        message: "Misconception mappings support only single-answer MCQ items.",
      });
    }
    for (const [mappingIndex, mapping] of misconceptionMappings.entries()) {
      for (const [answerIndex, answer] of mapping.answers.entries()) {
        if (!optionIds.has(answer) || item.answer.correctOptionIds.includes(answer)) {
          context.addIssue({
            code: "custom",
            path: ["misconceptionMappings", mappingIndex, "answers", answerIndex],
            message: "An MCQ misconception answer must reference an existing incorrect option.",
          });
        }
      }
    }
  } else if (item.kind === "trace") {
    const normalize = (value: string) => {
      const trimmed = value.trim();
      return item.answer.caseSensitive ? trimmed : trimmed.toLocaleLowerCase("en-US");
    };
    const accepted = new Set(item.answer.acceptedTraces.map(normalize));
    for (const [mappingIndex, mapping] of misconceptionMappings.entries()) {
      for (const [answerIndex, answer] of mapping.answers.entries()) {
        if (accepted.has(normalize(answer))) {
          context.addIssue({
            code: "custom",
            path: ["misconceptionMappings", mappingIndex, "answers", answerIndex],
            message: "A misconception answer cannot also be an accepted trace.",
          });
        }
      }
    }
  } else if (misconceptionMappings.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["misconceptionMappings"],
      message: "Misconception mappings are supported only by deterministic choice and trace graders.",
    });
  }
  if (item.kind === "fill-gap") {
    const gapIds = item.gaps.map((gap) => gap.id).sort();
    const answerIds = Object.keys(item.answer.acceptedByGap).sort();
    if (JSON.stringify(gapIds) !== JSON.stringify(answerIds)) {
      context.addIssue({
        code: "custom",
        path: ["answer", "acceptedByGap"],
        message: "Accepted answers must define exactly every declared gap.",
      });
    }
  }
  if (item.kind === "code") {
    if (!item.tests.some((test) => test.visibility === "visible") ||
        !item.tests.some((test) => test.visibility === "hidden")) {
      context.addIssue({
        code: "custom",
        path: ["tests"],
        message: "Code items require at least one visible and one hidden deterministic test.",
      });
    }
    if (item.parity) {
      if (item.runtime.engine !== "isolated-runner") {
        context.addIssue({
          code: "custom",
          path: ["runtime", "engine"],
          message: "Parity items require the official isolated runner.",
        });
      } else if (item.parity.language !== item.runtime.language) {
        context.addIssue({
          code: "custom",
          path: ["parity", "language"],
          message: "Parity language must match the runner language.",
        });
      }
      if (item.runtime.engine !== "isolated-runner" || !item.runtime.imageDigest) {
        context.addIssue({
          code: "custom",
          path: ["runtime", "imageDigest"],
          message: "Parity items require an immutable runtime image digest.",
        });
      }
      if (item.examEligibility.eligible) {
        context.addIssue({
          code: "custom",
          path: ["examEligibility", "eligible"],
          message: "AI-assisted parity items remain ineligible until human review.",
        });
      }
    }
  }
});

export const assessmentBankSchema = z.object({
  $schema: nonEmpty,
  format: z.literal("assessment-bank"),
  schemaVersion: z.literal(AUTHORED_CONTENT_SCHEMA_VERSION),
  id: identifier,
  courseId: identifier,
  courseVersion: semver,
  moduleId: identifier,
  skillId: identifier,
  title: z.string().trim().min(3),
  publication: publicationRecordSchema,
  sourceRefs: z.array(identifier).min(1),
  items: z.array(assessmentItemSchema).min(1),
}).strict().superRefine((bank, context) => {
  const reviewed = bank.publication.stage === "approved" || bank.publication.stage === "published";
  bank.items.forEach((item, index) => {
    if (item.skillId !== bank.skillId) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "skillId"],
        message: "Every item must map to the bank's declared atomic skill.",
      });
    }
    if (item.examEligibility.eligible && !reviewed) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "examEligibility", "eligible"],
        message: "Only human-reviewed approved or published banks may contain exam-eligible items.",
      });
    }
  });
});

export class AuthoredContentParseError extends Error {
  readonly issues: readonly string[];

  constructor(readonly context: string, error: z.ZodError) {
    const issues = error.issues.map((issue) =>
      `${issue.path.length ? `/${issue.path.join("/")}` : "/"}: ${issue.message}`,
    );
    super(`Invalid authored content in ${context}: ${issues.join("; ")}`);
    this.name = "AuthoredContentParseError";
    this.issues = issues;
  }
}

export function parseAuthoredLesson(value: unknown, context: string): AuthoredLesson {
  const result = authoredLessonSchema.safeParse(value);
  if (!result.success) throw new AuthoredContentParseError(context, result.error);
  return result.data as AuthoredLesson;
}

export function parseAssessmentBank(value: unknown, context: string): AssessmentBank {
  const result = assessmentBankSchema.safeParse(value);
  if (!result.success) throw new AuthoredContentParseError(context, result.error);
  return result.data as AssessmentBank;
}
