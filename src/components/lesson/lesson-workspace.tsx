"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CirclePlay,
  Code2,
  ExternalLink,
  Gamepad2,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  StepForward,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type {
  AtomicSkill,
  AuthoredLesson,
  AuthoredFallbackLessonBlueprint,
  DsaParityLanguage,
  LearnerAssessmentBank,
  LessonBlueprintBlock,
} from "@/lib/content";
import { draftCacheKey } from "@/lib/drafts/browser-cache";
import { useDraftCacheNamespace } from "@/lib/drafts/browser-cache-context";
import { useSyncedDraft, type DraftSyncStatus } from "@/lib/drafts/use-synced-draft";
import {
  acquirePracticeRunRequest,
  releasePracticeRunRequest,
  type PracticeRunRequestIdentity,
  type PracticeRunRequestPayload,
} from "@/lib/runner/practice-request-cache";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { DeterministicLogicGame } from "./deterministic-logic-game";
import { InteractiveLessonFlow } from "./interactive-lesson-flow";
import { PracticePanel } from "./practice-panel";
import styles from "./lesson-workspace.module.css";

const MonacoEditor = dynamic(() => import("./self-hosted-monaco-editor"), {
  ssr: false,
  loading: () => <div aria-live="polite" className={styles.editorLoading} role="status"><LoaderCircle className={styles.spin} /> Loading editor…</div>,
});

const codeLabLanguageOptions = [
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "java", label: "Java" },
  { value: "javascript", label: "JavaScript" },
  { value: "python", label: "Python" },
] as const;

type CodeLabLanguage = (typeof codeLabLanguageOptions)[number]["value"];
type CodeLabStarter = Readonly<{ language: CodeLabLanguage; source: string }>;
const CODE_LAB_STDIN_MAX_LENGTH = 16_384;

const codeLabStarters: Record<CodeLabLanguage, CodeLabStarter> = {
  c: { language: "c", source: "#include <stdio.h>\n\nint main(void) {\n    // Try the idea here\n    return 0;\n}\n" },
  cpp: { language: "cpp", source: "#include <iostream>\n\nint main() {\n    // Try the idea here\n    return 0;\n}\n" },
  java: { language: "java", source: "public class Main {\n    public static void main(String[] args) {\n        // Try the idea here\n    }\n}\n" },
  python: { language: "python", source: "# Try the idea here\n\n" },
  javascript: { language: "javascript", source: "// Try the idea here\n\nconsole.log('Ready');\n" },
};

const dsaStarters: Readonly<Record<DsaParityLanguage, CodeLabStarter>> = {
  c: {
    language: "c",
    source: "#include <stdio.h>\n\nint main(void) {\n    // Implement and test the data structure here\n    return 0;\n}\n",
  },
  cpp: {
    language: "cpp",
    source: "#include <iostream>\n#include <vector>\n\nint main() {\n    // Implement and test the data structure here\n    return 0;\n}\n",
  },
  java: {
    language: "java",
    source: "public class Main {\n    public static void main(String[] args) {\n        // Implement and test the data structure here\n    }\n}\n",
  },
  python: {
    language: "python",
    source: "# Implement and test the data structure here\n\n",
  },
};

function isCodeLabLanguage(value: string): value is CodeLabLanguage {
  return codeLabLanguageOptions.some((option) => option.value === value);
}

function lockedCodeLabStarter(courseId: string, dsaRunnerLanguage?: DsaParityLanguage) {
  if (courseId === "dsa") return dsaRunnerLanguage ? dsaStarters[dsaRunnerLanguage] : null;
  return isCodeLabLanguage(courseId) ? codeLabStarters[courseId] : codeLabStarters.python;
}

function codeLabLanguageLabel(language: CodeLabLanguage) {
  return codeLabLanguageOptions.find((option) => option.value === language)?.label ?? language;
}

function codeLabStdinStorageKey(
  namespace: string | null,
  courseId: string,
  skillId: string,
  language: CodeLabLanguage,
) {
  if (!namespace) return null;
  try {
    return `${draftCacheKey(namespace, { kind: "code", courseId, skillId, language })}:stdin`;
  } catch {
    return null;
  }
}

const fallbackVisualStates = [
  { line: 1, label: "Start", values: { count: "0", item: "—", total: "0" }, note: "Memory is allocated for the declared state." },
  { line: 2, label: "Read", values: { count: "0", item: "4", total: "0" }, note: "The current value enters the loop body." },
  { line: 3, label: "Update", values: { count: "1", item: "4", total: "4" }, note: "The assignment creates the next observable state." },
  { line: 2, label: "Repeat", values: { count: "1", item: "7", total: "4" }, note: "Control returns to the condition or iterator." },
  { line: 3, label: "Finish", values: { count: "2", item: "7", total: "11" }, note: "The invariant still holds when iteration finishes." },
];

function blockSummary(block: LessonBlueprintBlock) {
  switch (block.kind) {
    case "objective": return "What you will be able to demonstrate";
    case "mental-model": return "A durable way to think about the idea";
    case "source-linked-explanation-seed": return "Definition grounded in course sources";
    case "worked-example-specification": return "A verified example lab";
    case "misconception-prompts": return "Mistakes worth catching early";
    case "analogy-slot": return "Optional personal analogy";
    case "recap": return "Retrieve the idea in your own words";
    case "accessibility-text": return "Equivalent linear explanation";
    default: return "Practice the concept with evidence";
  }
}

function LessonBlock({ block }: { block: LessonBlueprintBlock }) {
  if (block.kind === "objective") return <><p className={styles.lead}>By the end of this lesson, you should be able to:</p><ul className={styles.outcomes}>{block.outcomes.map((item) => <li key={item}><CheckCircle2 size={17} /> {item}</li>)}</ul><div className={styles.evidence}><span>Evidence we will look for</span>{block.evidenceTypes.map((item) => <i key={item}>{item}</i>)}</div></>;
  if (block.kind === "mental-model") return <><div className={styles.callout}><Lightbulb size={21} /><div><strong>The plain-language anchor</strong><p>{block.plainLanguageSeed}</p></div></div><p>{block.authorPrompt}</p><div className={styles.termRow}>{block.canonicalTerms.map((term) => <span key={term}>{term}</span>)}</div></>;
  if (block.kind === "source-linked-explanation-seed") return <><p className={styles.lead}>{block.seed}</p><p>This definition is intentionally short in the offline blueprint. Codestead may elaborate from this bounded source context, but cannot change the official skill or grading rule.</p><div className={styles.sourceList}>{block.sources.map((source) => <a href={source.url} key={source.id} target="_blank" rel="noreferrer"><ExternalLink size={14} /><span><strong>{source.title}</strong><small>{source.versionOrDate}</small></span></a>)}</div></>;
  if (block.kind === "worked-example-specification") { const spec = block.specification; return <><p className={styles.lead}>{spec.goal}</p><div className={styles.exampleGrid}><div><span>Start from</span><p>{spec.startingState}</p></div><div><span>Build</span><p>{spec.artifactType}</p></div></div><ol className={styles.steps}>{spec.requiredSteps.map((item) => <li key={item}>{item}</li>)}</ol><h3>Verification gate</h3><ul>{spec.validationRequirements.map((item) => <li key={item}>{item}</li>)}</ul></>; }
  if (block.kind === "misconception-prompts") return <><p className={styles.lead}>Before moving on, test these tempting assumptions.</p><div className={styles.misconceptions}>{block.prompts.map((prompt, index) => <details key={prompt}><summary><span>{index + 1}</span>{prompt}</summary><p>Write a prediction, then use a trace or a minimal run to confirm it. The application records the evidence; an AI guess never becomes mastery.</p></details>)}</div></>;
  if ("mode" in block) return <><div className={styles.activityHeader}><span>{block.mode}</span><i>{block.applicability}</i></div><p className={styles.lead}>{block.promptSeed}</p><h3>What counts as evidence</h3><ul>{block.acceptanceSignals.map((item) => <li key={item}>{item}</li>)}</ul>{block.neutralContextRequired && <p className={styles.callout}><Sparkles size={18} /> This transfer check removes the hobby analogy so we know the concept—not the story—was learned.</p>}</>;
  if (block.kind === "analogy-slot") return <><div className={styles.callout}><Sparkles size={20} /><div><strong>Analogy is optional</strong><p>The canonical lesson must stand alone. If you enabled interests, Codestead can offer one analogy, explain where it breaks, and ask you to confirm it helps.</p></div></div><button className="button button-secondary" type="button">Use my confirmed interests</button></>;
  if (block.kind === "recap") return <><p className={styles.lead}>Close the lesson without looking back first.</p><div className={styles.recap}>{block.prompts.map((prompt) => <label key={prompt}><span>{prompt}</span><textarea placeholder="Explain in your own words…" /></label>)}</div></>;
  if (block.kind === "accessibility-text") return <><p className={styles.lead}>{block.textAlternativeSeed}</p><ul>{block.requirements.map((item) => <li key={item}>{item}</li>)}</ul></>;
  return null;
}

export function Visualizer({ trace }: { trace?: AuthoredLesson["trace"] }) {
  const visualStates = trace
    ? trace.steps.map((step) => ({
        line: Math.max(1, Math.min(trace.artifact.length, step.step)),
        label: step.focus,
        values: step.state,
        note: step.explanation,
      }))
    : fallbackVisualStates;
  const artifact = trace?.artifact ?? ["count = 0", "for item in [4, 7]:", "    count += 1; total += item"];
  const [index, setIndex] = useState(0);
  const state = visualStates[index];
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing || visualStates.length < 2 || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
    const timer = window.setInterval(() => {
      setIndex((value) => Math.min(visualStates.length - 1, value + 1));
    }, 900);
    return () => window.clearInterval(timer);
  }, [playing, visualStates.length]);
  if (!state) return <div className={styles.visualizer}><p>No trace states are available for this draft.</p></div>;
  return <div className={styles.visualizer}><div className={styles.visualTop}><span><Sparkles size={16} /> {trace ? "Topic trace visualizer" : "State visualizer"}</span><div><button aria-label="Restart visualizer" onClick={() => { setIndex(0); setPlaying(false); }}><RotateCcw size={15} /></button><button aria-label={playing ? "Pause visualizer" : "Play visualizer"} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={15} /> : <Play size={15} />}</button><button aria-label="Next visualizer step" onClick={() => setIndex((value) => Math.min(visualStates.length - 1, value + 1))}><StepForward size={15} /></button></div></div><div className={styles.fakeCode}>{artifact.map((line, lineIndex) => <code className={state.line === lineIndex + 1 ? styles.activeLine : ""} key={`${lineIndex}-${line}`}><b>{lineIndex + 1}</b>{line}</code>)}</div><div className={styles.memoryTable}><span>Variable</span><span>Value now</span>{Object.entries(state.values).flatMap(([key, value]) => [<code key={`${key}-k`}>{key}</code>,<strong key={`${key}-v`}>{value}</strong>])}</div><div aria-live="polite" className={styles.visualNote}><b>Step {index + 1}: {state.label}</b><p>{state.note}</p></div><div className={styles.visualProgress}>{visualStates.map((_, item) => <i className={item <= index ? styles.doneStep : ""} key={item} />)}</div></div>;
}

function FallbackLogicGame({ skill }: { skill: AtomicSkill }) {
  const [stage, setStage] = useState(0);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const challenges = [
    { title: "Restore the control panel", prompt: `Name the observable result that proves ${skill.title} worked.`, token: "" },
    { title: "Power the next room", prompt: "Write one state change, condition, operation, or call that belongs in a minimal example.", token: "" },
    { title: "Explain the mechanism", prompt: `In one sentence, explain why your change demonstrates: ${skill.outcomes[0]}`, token: "" },
  ];
  const challenge = challenges[stage];
  function check() { if (answer.trim().length < 8) { setFeedback("Give a little more evidence—at least one complete idea."); return; } setFeedback("Evidence captured. The deterministic test still decides correctness in the practice or runner panel."); if (stage < challenges.length - 1) { setTimeout(() => { setStage((value) => value + 1); setAnswer(""); setFeedback(null); }, 500); } }
  return <div className={styles.game}><div className={styles.gameScene}><span className={styles.gameBot}>B</span><div className={styles.gamePath}>{challenges.map((_,index) => <i className={index <= stage ? styles.gameActive : ""} key={index}>{index + 1}</i>)}</div><span className={styles.gameGoal}>★</span></div><span className={styles.eyebrow}>Logic quest · stage {stage + 1} of {challenges.length}</span><h3>{challenge.title}</h3><p>{challenge.prompt}</p><textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Type your reasoning or code fragment…" /><div className={styles.gameActions}><button className="button button-primary" type="button" onClick={check}>{stage === challenges.length - 1 ? "Finish quest" : "Run action"}<ArrowRight size={15} /></button><button className="button button-ghost" type="button" onClick={() => setFeedback("Hint: start from the skill outcome and name a before-and-after state.")}>Use a hint</button></div>{feedback && <p className={styles.gameFeedback}>{feedback}</p>}</div>;
}

function LogicGame({ skill, bank }: { skill: AtomicSkill; bank?: LearnerAssessmentBank }) {
  return bank ? <DeterministicLogicGame bank={bank} skill={skill} /> : <FallbackLogicGame skill={skill} />;
}

const practiceRunnerStatuses = new Set([
  "compile_only",
  "accepted",
  "wrong_answer",
  "compile_error",
  "runtime_error",
  "timeout",
  "memory_limit",
  "output_limit",
  "infrastructure_error",
  "offline",
  "unavailable",
]);

type PracticeRunBody = {
  code?: unknown;
  requestId?: unknown;
  status?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  error?: unknown;
  indeterminate?: unknown;
  retryable?: unknown;
  queue?: { initialState?: unknown; position?: unknown };
};

type PracticeRunView = {
  status: string;
  message?: string;
  retryable?: boolean;
  retryLabel?: string;
  stdout?: string;
  stderr?: string;
  queueNotice?: string;
};

type PracticeRunTone = "busy" | "success" | "warning" | "error" | "neutral";

const practiceRunStatusMeta: Record<string, { label: string; title: string; tone: PracticeRunTone }> = {
  queued: { label: "Waiting", title: "Waiting for a runner slot", tone: "busy" },
  compile_only: { label: "Compiled", title: "Compilation completed", tone: "success" },
  accepted: { label: "Completed", title: "Run completed", tone: "success" },
  practice_result: { label: "Completed", title: "Run completed", tone: "success" },
  wrong_answer: { label: "Check result", title: "The result needs another look", tone: "warning" },
  compile_error: { label: "Compile error", title: "The code did not compile", tone: "error" },
  runtime_error: { label: "Runtime error", title: "The program stopped with an error", tone: "error" },
  timeout: { label: "Time limit", title: "The program exceeded its time limit", tone: "warning" },
  memory_limit: { label: "Memory limit", title: "The program used too much memory", tone: "warning" },
  output_limit: { label: "Output limit", title: "The program produced too much output", tone: "warning" },
  infrastructure_error: { label: "Runner issue", title: "The runner could not confirm a result", tone: "error" },
  client_timeout: { label: "Runner timeout", title: "The runner took too long to respond", tone: "error" },
  invalid_response: { label: "Invalid response", title: "The runner returned an unreadable response", tone: "error" },
  unavailable: { label: "Unavailable", title: "A trusted result is not available", tone: "error" },
  offline: { label: "Runner offline", title: "The runner could not be reached", tone: "error" },
  error: { label: "Run failed", title: "The run could not start", tone: "error" },
};

const PRACTICE_RUN_CLIENT_TIMEOUT_MS = 45_000;

class PracticeRunClientError extends Error {
  constructor(readonly kind: "timeout" | "invalid-response") {
    super(kind);
    this.name = "PracticeRunClientError";
  }
}

function practiceRunMeta(status: string) {
  return practiceRunStatusMeta[status] ?? { label: "Result ready", title: "Runner result", tone: "neutral" as const };
}

function practiceRunAnnouncement(result: PracticeRunView | null) {
  if (!result) return "";
  const meta = practiceRunMeta(result.status);
  if (result.status === "queued") return "Waiting for an isolated runner slot.";

  const title = /[.!?]$/.test(meta.title) ? meta.title : `${meta.title}.`;
  const parts = [title];
  if (result.message) parts.push("More details are available in Program output.");
  if (result.stdout) parts.push("Standard output is ready.");
  if (result.stderr) parts.push("Standard error is ready.");
  if (!result.message && !result.stdout && !result.stderr) {
    parts.push(meta.tone === "success" ? "The program finished with no output." : "No trusted output is available.");
  }
  return parts.join(" ");
}

function practiceInputGuidance(
  language: CodeLabLanguage,
  status: string,
  stderr: string | undefined,
  stdin: string,
) {
  if (status !== "runtime_error" || !stderr) return null;

  const exhaustedInput = language === "python"
    ? /EOFError:\s*EOF when reading a line/i.test(stderr)
    : language === "java"
      ? /(?:java\.util\.)?NoSuchElementException|No line found/i.test(stderr)
      : false;

  if (!exhaustedInput) return null;
  return stdin.length === 0
    ? "Your program asked for input, but Program input is empty. Add each expected value there—one value per line—then run again."
    : "Your program asked for more input than you supplied. Add the missing value on a new line under Program input, then run again.";
}

function safeRunnerMessage(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const message = value.trim();
  return /^[A-Z][A-Z0-9_]{2,}$/.test(message)
    ? "The isolated runner could not complete this run. Your code is still saved."
    : message;
}

async function requestPracticeRun(payload: PracticeRunRequestPayload, requestId: string) {
  const controller = new AbortController();
  let timeoutId: number | undefined;
  const request = (async () => {
    const response = await fetch("/api/code/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, clientRequestId: requestId }),
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PracticeRunClientError("invalid-response");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new PracticeRunClientError("invalid-response");
    }
    return { response, body: body as PracticeRunBody };
  })();
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new PracticeRunClientError("timeout"));
      controller.abort();
    }, PRACTICE_RUN_CLIENT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function practiceStatus(value: unknown, responseOk: boolean) {
  if (typeof value === "string" && practiceRunnerStatuses.has(value.toLowerCase())) {
    return value.toLowerCase();
  }
  return responseOk ? "practice_result" : "error";
}

function practiceQueueNotice(queue: PracticeRunBody["queue"]) {
  if (!queue || typeof queue.initialState !== "string") return undefined;
  const state = queue.initialState.toLowerCase();
  if (!["queued", "running", "completed", "failed"].includes(state)) return undefined;
  const position = typeof queue.position === "number" && Number.isSafeInteger(queue.position) && queue.position > 0
    ? queue.position
    : null;
  return state === "queued"
    ? `The bounded two-slot runner accepted this job${position ? ` at queue position ${position}` : " in its queue"}.`
    : `The bounded two-slot runner accepted this job in ${state} state.`;
}

export function CodeLab({
  allowLanguageSelection = false,
  courseId,
  dsaRunnerLanguage,
  skillId,
}: {
  allowLanguageSelection?: boolean;
  courseId: string;
  dsaRunnerLanguage?: DsaParityLanguage;
  skillId: string;
}) {
  const lockedStarter = lockedCodeLabStarter(courseId, dsaRunnerLanguage);
  const resolvedLockedStarter = lockedStarter ?? codeLabStarters.python;
  const [selectedLanguage, setSelectedLanguage] = useState<CodeLabLanguage>(
    isCodeLabLanguage(courseId) ? courseId : resolvedLockedStarter.language,
  );
  const [running, setRunning] = useState(false);
  if (!lockedStarter) {
    return <div className={styles.codeLabLanguageGate} role="alert">
      <AlertTriangle aria-hidden="true" size={20} />
      <div>
        <strong>DSA language setup is required</strong>
        <p>This practice runner stays locked until your DSA enrollment has C, C++, Java, or Python selected.</p>
        <Link className="button button-secondary" href="/roadmap">Return to roadmap</Link>
      </div>
    </div>;
  }
  const starter = allowLanguageSelection ? codeLabStarters[selectedLanguage] : lockedStarter;
  const draftCourseId = allowLanguageSelection ? selectedLanguage : courseId;

  return <div className={styles.codeLab}>
    {allowLanguageSelection && <div className={styles.codeLanguageSelector}>
      <label>
        <span>Runner language</span>
        <select
          aria-label="Runner language"
          disabled={running}
          onChange={(event) => {
            if (isCodeLabLanguage(event.target.value)) setSelectedLanguage(event.target.value);
          }}
          value={selectedLanguage}
        >
          {codeLabLanguageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <small>Each language keeps a separate saved draft.</small>
    </div>}
    <CodeLabSession
      courseId={draftCourseId}
      key={`${draftCourseId}:${starter.language}`}
      onRunningChange={setRunning}
      skillId={skillId}
      starter={starter}
    />
  </div>;
}

function CodeLabSession({
  courseId,
  onRunningChange,
  skillId,
  starter,
}: {
  courseId: string;
  onRunningChange: (running: boolean) => void;
  skillId: string;
  starter: CodeLabStarter;
}) {
  const outputId = useId();
  const stdinId = useId();
  const stdinHelpId = useId();
  const resetTitleId = useId();
  const resetDescriptionId = useId();
  const requestCacheNamespace = useDraftCacheNamespace();
  const stdinStorageKey = codeLabStdinStorageKey(
    requestCacheNamespace,
    courseId,
    skillId,
    starter.language,
  );
  const draft = useSyncedDraft({
    key: { kind: "code", courseId, skillId },
    language: starter.language,
    initialContent: starter.source,
  });
  const source = draft.content;
  const setSource = draft.setContent;
  const [running, setRunning] = useState(false);
  const [stdin, setStdin] = useState("");
  const [stdinRestoring, setStdinRestoring] = useState(Boolean(stdinStorageKey));
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false);
  const [result, setResult] = useState<PracticeRunView | null>(null);
  const [resultSource, setResultSource] = useState<string | null>(null);
  const [resultStdin, setResultStdin] = useState<string | null>(null);
  const draftBlocksEditing = ["loading", "reauthenticate", "exam-locked"].includes(draft.status);
  const inputBlocksEditing = draftBlocksEditing || stdinRestoring;
  const runDisabled = running || inputBlocksEditing;
  const visibleResult = resultSource === source && resultStdin === stdin ? result : null;
  const visibleResultMeta = visibleResult ? practiceRunMeta(visibleResult.status) : null;
  const sourceChanged = source !== starter.source;
  const stdinChanged = stdin !== "";
  const resetWouldDiscardInput = sourceChanged || stdinChanged;
  const resetDescription = sourceChanged && stdinChanged
    ? `This replaces your saved source code with the ${codeLabLanguageLabel(starter.language)} starter and clears program input (stdin). This cannot be undone.`
    : sourceChanged
      ? `This replaces your saved source code with the ${codeLabLanguageLabel(starter.language)} starter. This cannot be undone.`
      : "This clears your program input (stdin). This cannot be undone.";
  const runAnnouncement = practiceRunAnnouncement(visibleResult);
  const inputGuidance = visibleResult
    ? practiceInputGuidance(starter.language, visibleResult.status, visibleResult.stderr, stdin)
    : null;
  const showTutorHelp = Boolean(
    visibleResult
    && visibleResultMeta
    && (visibleResultMeta.tone === "error" || visibleResultMeta.tone === "warning")
    && (visibleResult.message || visibleResult.stderr),
  );

  useEffect(() => {
    if (!stdinStorageKey) return;
    const restoreTimer = window.setTimeout(() => {
      try {
        const restored = window.sessionStorage.getItem(stdinStorageKey);
        if (restored !== null) {
          const bounded = restored.slice(0, CODE_LAB_STDIN_MAX_LENGTH);
          setStdin(bounded);
          if (bounded !== restored) window.sessionStorage.setItem(stdinStorageKey, bounded);
        }
      } catch {
        // The input remains usable in memory when browser tab storage is blocked.
      } finally {
        setStdinRestoring(false);
      }
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [stdinStorageKey]);

  function updateRunning(next: boolean) {
    setRunning(next);
    onRunningChange(next);
  }

  function changeSource(next: string) {
    if (running || draftBlocksEditing || next === source) return;
    setResult(null);
    setResultSource(null);
    setResultStdin(null);
    setSource(next);
  }

  function changeStdin(next: string) {
    if (running || inputBlocksEditing || next === stdin) return;
    setResult(null);
    setResultSource(null);
    setResultStdin(null);
    setStdin(next);
    if (stdinStorageKey) {
      try {
        if (next === "") window.sessionStorage.removeItem(stdinStorageKey);
        else window.sessionStorage.setItem(stdinStorageKey, next);
      } catch {
        // The controlled input still works for the current page lifecycle.
      }
    }
  }

  function performReset() {
    if (running || inputBlocksEditing) return;
    setResult(null);
    setResultSource(null);
    setResultStdin(null);
    setStdin("");
    if (stdinStorageKey) {
      try { window.sessionStorage.removeItem(stdinStorageKey); } catch { /* in-memory reset still succeeds */ }
    }
    setSource(starter.source);
    setResetConfirmationOpen(false);
  }

  function requestReset() {
    if (running || inputBlocksEditing) return;
    if (resetWouldDiscardInput) {
      setResetConfirmationOpen(true);
      return;
    }
    performReset();
  }

  async function run() {
    if (runDisabled) return;
    updateRunning(true);
    setResultSource(source);
    setResultStdin(stdin);
    setResult({
      status: "queued",
      message: "Waiting for one of two isolated runner slots. The queue is bounded, so this screen will not wait forever.",
    });
    const payload: PracticeRunRequestPayload = {
      language: starter.language,
      source,
      skillId,
      mode: "quick_run",
      ...(stdin === "" ? {} : { stdin }),
    };
    let identity: PracticeRunRequestIdentity;
    try {
      identity = await acquirePracticeRunRequest(
        window.sessionStorage,
        requestCacheNamespace,
        payload,
      );
    } catch {
      setResult({
        status: "unavailable",
        message: "This browser cannot safely preserve a runner retry identifier, so no code was dispatched. Allow session storage, then try again.",
      });
      updateRunning(false);
      return;
    }
    try {
      const { response, body } = await requestPracticeRun(payload, identity.requestId);
      if (body.requestId !== identity.requestId) {
        if (!response.ok && typeof body.requestId !== "string") {
          releasePracticeRunRequest(window.sessionStorage, identity);
          setResult({
            status: practiceStatus(body.status, false),
            message: safeRunnerMessage(body.error) ?? "The server rejected this run before it reached the isolated runner.",
            retryable: body.retryable === true,
            retryLabel: "Retry run",
          });
          return;
        }
        setResult({
          status: "unavailable",
          message: "The response did not match this saved run, so its output was ignored. Check the same run again to reconcile it safely.",
          retryable: true,
          retryLabel: "Check run again",
        });
        return;
      }
      if (body.indeterminate !== true) {
        releasePracticeRunRequest(window.sessionStorage, identity);
      }
      const status = practiceStatus(body.status, response.ok);
      const retryable = typeof body.retryable === "boolean"
        ? body.retryable
        : status === "infrastructure_error" && response.status >= 500;
      setResult({
        status,
        message: body.indeterminate === true
          ? "The runner may have finished, but its result is not confirmed yet. Check this same run again; the saved request will be reused instead of creating a duplicate."
          : safeRunnerMessage(body.error)
            ?? (!response.ok && typeof body.stderr !== "string"
              ? "The runner could not complete this run. Your code is still saved."
              : undefined),
        retryable,
        retryLabel: body.indeterminate === true ? "Check run again" : "Retry run",
        stdout: typeof body.stdout === "string" ? body.stdout : undefined,
        stderr: typeof body.stderr === "string"
          ? body.stderr
          : undefined,
        queueNotice: practiceQueueNotice(body.queue),
      });
    } catch (error) {
      const clientError = error instanceof PracticeRunClientError ? error.kind : "transport";
      setResult({
        status: clientError === "timeout"
          ? "client_timeout"
          : clientError === "invalid-response"
            ? "invalid_response"
            : "offline",
        message: clientError === "timeout"
          ? "The runner did not answer within 45 seconds. Check this same run again; your code and retry identity are still saved."
          : clientError === "invalid-response"
            ? "No output was trusted because the runner response could not be read. Check this same run again."
            : "The isolated runner could not be reached. Check your connection or ask the administrator to verify the runner, then retry. Your code is still saved.",
        retryable: true,
        retryLabel: clientError === "transport" ? "Retry run" : "Check run again",
      });
    } finally {
      updateRunning(false);
    }
  }

  return <>
    <div className={styles.codeToolbar}>
      <span><Code2 size={15} /> {codeLabLanguageLabel(starter.language)} practice · isolated NUC runner · no mastery award</span>
      <div>
        <button disabled={running || inputBlocksEditing} onClick={requestReset} type="button"><RotateCcw size={14} /> Reset</button>
        <button aria-busy={running} aria-controls={outputId} className={styles.runButton} disabled={runDisabled} onClick={run} type="button">{running ? <LoaderCircle className={styles.spin} size={15} /> : <CirclePlay size={15} />} {running ? "Running…" : "Run"}</button>
      </div>
    </div>
    <DraftSyncNotice
      status={draft.status}
      hasServerCopy={Boolean(draft.serverCopy)}
      onKeepLocal={draft.keepLocalCopy}
      onRetry={draft.retry}
      onUseServer={draft.useServerCopy}
    />
    <MonacoEditor height="clamp(260px, 38vh, 340px)" language={starter.language} value={source} onChange={(value) => changeSource(value ?? "")} options={{ ariaLabel: "Practice source code editor", minimap: { enabled: false }, fontSize: 14, lineNumbersMinChars: 3, tabSize: 4, automaticLayout: true, scrollBeyondLastLine: false, accessibilitySupport: "auto", readOnly: running || draftBlocksEditing }} theme="vs-dark" />
    <div className={styles.stdinPanel}>
      <label htmlFor={stdinId}>
        <span>Program input <i>stdin</i></span>
        <small id={stdinHelpId}>
          Optional. Put each value on the line where your program expects it. {stdinStorageKey
            ? `Browser tab storage keeps this ${codeLabLanguageLabel(starter.language)} input through refresh when available; normal sign-out or closing the tab clears it. Sent only when you run.`
            : "Temporary on this page. Sent only when you run."}
        </small>
      </label>
      <textarea
        aria-describedby={stdinHelpId}
        disabled={runDisabled}
        id={stdinId}
        maxLength={CODE_LAB_STDIN_MAX_LENGTH}
        onChange={(event) => changeStdin(event.target.value)}
        placeholder={"Example:\n10\n20"}
        rows={3}
        spellCheck={false}
        value={stdin}
      />
      <small>{stdin.length.toLocaleString()} / 16,384 characters</small>
    </div>
    <span aria-atomic="true" aria-label="Run status" aria-live="polite" className="sr-only" role="status">{runAnnouncement}</span>
    <div aria-busy={running} className={styles.console} id={outputId}>
      <span><TerminalSquare size={14} /> Output {visibleResultMeta && <i aria-hidden="true" data-run-tone={visibleResultMeta.tone}>{running && <LoaderCircle className={styles.spin} size={12} />}{visibleResultMeta.label}</i>}</span>
      <div aria-label="Program output" className={styles.consoleStreams} role="region" tabIndex={visibleResult ? 0 : undefined}>
        {!visibleResult && <pre>Run your code to see compiler output and program results.</pre>}
        {visibleResult?.message && visibleResultMeta && <section className={styles.runFeedback} data-run-tone={visibleResultMeta.tone}>
          {visibleResultMeta.tone === "busy" ? <LoaderCircle className={styles.spin} size={17} /> : <AlertTriangle size={17} />}
          <div>
            <strong>{visibleResultMeta.title}</strong>
            <p>{visibleResult.message}</p>
            {visibleResult.retryable && <button disabled={runDisabled} onClick={run} type="button"><RotateCcw size={14} /> {visibleResult.retryLabel ?? "Retry run"}</button>}
          </div>
        </section>}
        {inputGuidance && <section className={styles.inputGuidance}>
          <Lightbulb aria-hidden="true" size={17} />
          <div><strong>Program input needed</strong><p>{inputGuidance}</p></div>
        </section>}
        {visibleResult?.stdout && <section><b>stdout</b><pre>{visibleResult.stdout}</pre></section>}
        {visibleResult?.stderr && <section><b>stderr</b><pre>{visibleResult.stderr}</pre></section>}
        {visibleResult && !visibleResult.message && !visibleResult.stdout && !visibleResult.stderr && <pre>{visibleResultMeta?.tone === "success" ? "Program finished with no output." : "The runner returned no trusted output."}</pre>}
        {showTutorHelp && <div className={styles.consoleHelp}>
          <Link href="/tutor"><Bot aria-hidden="true" size={15} /> Ask Codestead about this error <ArrowRight aria-hidden="true" size={14} /></Link>
          <small>Your code and output are not sent automatically. Paste only what you want Codestead to see.</small>
        </div>}
      </div>
      {visibleResult?.queueNotice && <small className={styles.queueNotice}>{visibleResult.queueNotice}</small>}
      <small className={styles.practiceNotice}>Practice only: this panel cannot award mastery, badges, exam credit, or leaderboard points.</small>
    </div>
    {resetConfirmationOpen && (
      <ModalDialog
        backdropClassName={styles.resetBackdrop}
        describedBy={resetDescriptionId}
        dialogClassName={`${styles.resetDialog} card`}
        labelledBy={resetTitleId}
        onClose={() => setResetConfirmationOpen(false)}
        role="alertdialog"
      >
        <span aria-hidden="true" className={styles.resetDialogIcon}><AlertTriangle size={22} /></span>
        <div className={styles.resetDialogCopy}>
          <h2 id={resetTitleId}>Reset {codeLabLanguageLabel(starter.language)} draft?</h2>
          <p id={resetDescriptionId}>{resetDescription}</p>
        </div>
        <div className={styles.resetDialogActions}>
          <button
            className="button button-secondary"
            data-dialog-initial-focus
            onClick={() => setResetConfirmationOpen(false)}
            type="button"
          >
            Keep my work
          </button>
          <button className={`button ${styles.resetConfirm}`} onClick={performReset} type="button">
            <RotateCcw size={15} /> Reset {codeLabLanguageLabel(starter.language)} draft
          </button>
        </div>
      </ModalDialog>
    )}
  </>;
}

const draftStatusCopy: Record<DraftSyncStatus, string> = {
  loading: "Loading the authoritative server draft…",
  local: "Local changes are waiting to sync. This browser copy is not a backup.",
  syncing: "Syncing this draft to the server…",
  synced: "Saved on the server. Clearing this browser cache will not lose it.",
  offline: "Offline: changes exist only in this browser session until sync succeeds.",
  conflict: "A newer server draft exists. Choose which copy to keep; neither was overwritten.",
  reauthenticate: "Your session expired or was revoked. Local draft access was cleared; sign in before syncing.",
  "exam-locked": "Draft access is locked during a closed-book exam.",
  "scope-unavailable": "This editor is outside an available server draft scope. Changes stay only in this browser session.",
  unavailable: "Server draft sync is unavailable. Unsynced text is not durably backed up.",
};

function DraftSyncNotice({
  status,
  hasServerCopy,
  onKeepLocal,
  onRetry,
  onUseServer,
}: {
  status: DraftSyncStatus;
  hasServerCopy: boolean;
  onKeepLocal(): void;
  onRetry(): void;
  onUseServer(): void;
}) {
  return <div className={styles.draftSync} data-draft-status={status} role="status">
    <span><strong>Draft · {status.replaceAll("-", " ")}</strong><small>{draftStatusCopy[status]}</small></span>
    {status === "conflict" && hasServerCopy && <div><button type="button" onClick={onKeepLocal}>Keep my draft</button><button type="button" onClick={onUseServer}>Use server draft</button></div>}
    {status === "unavailable" && <button type="button" onClick={onRetry}>Retry sync</button>}
    {status === "reauthenticate" && <Link href="/login">Sign in</Link>}
  </div>;
}

function TutorPanel({ courseId, skillId, onClose }: { courseId: string; skillId: string; onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Array<{ id: string; role: "user" | "assistant"; content: string }>>([{ id: "buddy-welcome", role: "assistant", content: "Hey buddy—what part feels unclear? I’ll start with one small question, not dump the answer." }]);
  const [busy, setBusy] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const messageListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, busy]);

  async function send() {
    const text = message.trim();
    if (!text || busy) return;

    const requestId = crypto.randomUUID();
    const userMessageId = `user-${requestId}`;
    const requestInit: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        requestId,
        courseId,
        skillId,
        message: text,
        ...(threadId ? { threadId } : {}),
      }),
    };

    setMessage("");
    setMessages((items) => [...items, { id: userMessageId, role: "user", content: text }]);
    setBusy(true);
    try {
      let response: Response;
      try {
        response = await fetch("/api/ai/tutor", requestInit);
      } catch {
        // A provider call may have committed before its response was lost.
        // Reusing the exact request ID makes this one retry replay-safe.
        response = await fetch("/api/ai/tutor", requestInit);
      }
      const body = await response.json().catch(() => ({})) as {
        acceptedMessage?: string;
        callId?: string;
        content?: string;
        error?: string;
        threadId?: string;
      };
      if (!response.ok || !body.content || !body.threadId) {
        throw new Error(body.error ?? "Codestead is unavailable; the authored lesson and practice still work.");
      }
      const assistantContent = body.content;
      setThreadId(body.threadId);
      setMessages((items) => [
        ...items.map((item) => item.id === userMessageId && body.acceptedMessage
          ? { ...item, content: body.acceptedMessage }
          : item),
        {
          id: body.callId ? `assistant-${body.callId}` : `assistant-${requestId}`,
          role: "assistant",
          content: assistantContent,
        },
      ]);
    } catch (cause) {
      setMessages((items) => [...items, {
        id: `error-${requestId}`,
        role: "assistant",
        content: cause instanceof Error
          ? cause.message
          : "Codestead is offline right now. Keep going with the authored lesson, visualizer, or practice.",
      }]);
    } finally {
      setBusy(false);
    }
  }

  return <aside
    aria-labelledby="lesson-buddy-title"
    className={styles.tutorPanel}
    id="lesson-buddy-tutor"
    onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    role="dialog"
  >
    <div className={styles.tutorHead}><span><Bot size={18} /><span><strong id="lesson-buddy-title">Codestead mentor</strong><small>Friendly and grounded in this skill</small></span></span><button aria-label="Close tutor" onClick={onClose}><X size={17} /></button></div>
    <div aria-live="polite" className={styles.chatMessages} ref={messageListRef} role="log">{messages.map((item) => <div className={item.role === "user" ? styles.userMessage : styles.aiMessage} key={item.id}>{item.content}</div>)}{busy && <div className={styles.aiMessage}>Thinking from your course context…</div>}</div>
    <div className={styles.chatInput}><textarea aria-label="Message Codestead" autoFocus disabled={busy} placeholder="Ask why, request another example, or paste an error…" value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} /><button aria-label="Send message" onClick={send} disabled={busy || !message.trim()}><Send size={16} /></button></div>
    <p>Codestead uses this lesson’s context. Hidden tests and keys are never included.</p>
  </aside>;
}

export function AuthoredLessonCard({ lesson }: { lesson: AuthoredLesson }) {
  const reviewLabel = lesson.publication.reviewer
    ? `Human-reviewed by ${lesson.publication.reviewer.displayName}`
    : "No human editorial review yet";
  return <article className={styles.lessonCard} data-testid="authored-lesson">
    <div className={styles.provenanceBanner} role="status">
      <ListChecks size={18} />
      <span>
        <strong>{lesson.publication.stage.replace("-", " ")} preview · {lesson.publication.aiAssisted ? "AI-assisted draft" : "human-authored"}</strong>
        <small>{reviewLabel}. This status is provenance, not a mastery or accuracy claim.</small>
      </span>
    </div>
    <h1>{lesson.title}</h1>
    <p className={styles.lead}>{lesson.canonicalExplanation.summary}</p>
    <InteractiveLessonFlow key={lesson.id} lesson={lesson} />
    <details className={styles.referenceDisclosure}>
      <summary>Open the complete reading reference</summary>
    <section aria-labelledby="reference-canonical-explanation"><h2 id="reference-canonical-explanation">Canonical explanation</h2>{lesson.canonicalExplanation.sections.map((section) => <div key={section.heading}><h3>{section.heading}</h3><p>{section.body}</p></div>)}</section>
    <section className={styles.scopeGrid} aria-labelledby="reference-lesson-boundaries"><h2 id="reference-lesson-boundaries">Lesson boundaries</h2><div><h3>In scope</h3><ul>{lesson.scope.includes.map((item) => <li key={item}>{item}</li>)}</ul></div><div><h3>Not in scope</h3><ul>{lesson.scope.excludes.map((item) => <li key={item}>{item}</li>)}</ul></div></section>
    <section aria-labelledby="reference-worked-examples"><h2 id="reference-worked-examples">Worked examples</h2><div className={styles.authoredExamples}>{lesson.examples.map((example) => <article key={example.id}><h3>{example.title}</h3><p>{example.situation}</p><ol>{example.walkthrough.map((step) => <li key={step}>{step}</li>)}</ol><strong>{example.result}</strong></article>)}</div></section>
    <section aria-labelledby="reference-trace"><h2 id="reference-trace">Trace and text alternative</h2><pre className={styles.traceArtifact}>{lesson.trace.artifact.join("\n")}</pre><ol className={styles.traceSteps}>{lesson.trace.steps.map((step) => <li key={step.step}><strong>{step.step}. {step.focus}</strong><code>{Object.entries(step.state).map(([name, value]) => `${name}=${value}`).join(" · ")}</code><p>{step.explanation}</p></li>)}</ol><div className={styles.callout}><BookOpen size={18} /><div><strong>Linear text alternative</strong><p>{lesson.trace.textAlternative}</p></div></div></section>
    <section aria-labelledby="reference-misconceptions"><h2 id="reference-misconceptions">Misconceptions and correction</h2><div className={styles.misconceptions}>{lesson.misconceptions.map((item) => <details key={item.id}><summary>{item.mistakenBelief}</summary><p><strong>Correction:</strong> {item.correction}</p><p><strong>Check:</strong> {item.diagnosticPrompt}</p></details>)}</div></section>
    <section aria-labelledby="reference-analogy-limits"><h2 id="reference-analogy-limits">Optional analogy and its limits</h2><div className={styles.callout}><Sparkles size={18} /><div><p>{lesson.analogy.example}</p><strong>Where it stops helping</strong><ul>{lesson.analogy.limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul></div></div></section>
    <section aria-labelledby="reference-transfer-practice"><h2 id="reference-transfer-practice">Practice for transfer</h2><div className={styles.practiceGrid}>{([ ["Faded", lesson.practice.faded], ["Near transfer", lesson.practice.nearTransfer], ["Far transfer", lesson.practice.farTransfer] ] as const).map(([label, practice]) => <article key={label}><span>{label}</span><p>{practice.prompt}</p><h3>Scaffold</h3><ul>{practice.scaffold.map((item) => <li key={item}>{item}</li>)}</ul><h3>Evidence</h3><ul>{practice.expectedEvidence.map((item) => <li key={item}>{item}</li>)}</ul></article>)}</div></section>
    <section aria-labelledby="reference-remediation"><h2 id="reference-remediation">Targeted remediation</h2>{lesson.remediation.map((branch) => <div className={styles.remediationCard} key={branch.misconceptionId}><p>{branch.explanation}</p><strong>Retry: {branch.retryPrompt}</strong></div>)}</section>
    <section aria-labelledby="reference-recap"><h2 id="reference-recap">Recap and retrieval</h2><p>{lesson.recap.summary}</p><ul>{lesson.recap.retrievalPrompts.map((prompt) => <li key={prompt}>{prompt}</li>)}</ul><p><strong>Delayed review:</strong> {lesson.recap.nextReviewPrompt}</p></section>
    <section aria-labelledby="reference-source-provenance"><h2 id="reference-source-provenance">Source provenance</h2><div className={styles.sourceList}>{lesson.sources.map((source) => <div key={`${source.sourceRef}:${source.locator}`}><strong>{source.sourceRef}</strong><small>{source.locator}</small><p>{source.claim}</p></div>)}</div></section>
    </details>
  </article>;
}

export type LessonWorkspaceProps = {
  blueprint: AuthoredFallbackLessonBlueprint;
  authoredLesson?: AuthoredLesson;
  assessmentBank?: LearnerAssessmentBank;
  skill: AtomicSkill;
  courseTitle: string;
  moduleTitle: string;
  dsaRunnerLanguage?: DsaParityLanguage;
  previousHref?: string;
  nextHref?: string;
};

type LearningMode = "lesson" | "practice" | "code" | "visual" | "game";

const learningModes = [
  { id: "lesson", label: "Lesson", icon: BookOpen },
  { id: "practice", label: "Practice", icon: ListChecks },
  { id: "code", label: "Code", icon: Code2 },
  { id: "visual", label: "Visualize", icon: Sparkles },
  { id: "game", label: "Quest", icon: Gamepad2 },
] as const;

function LearningModeTabs({ mode, onChange }: { mode: LearningMode; onChange: (mode: LearningMode) => void }) {
  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = learningModes.findIndex((item) => item.id === mode);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? learningModes.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + learningModes.length) % learningModes.length;
    const selected = learningModes[next]!;
    onChange(selected.id);
    queueMicrotask(() => document.getElementById(`learning-mode-tab-${selected.id}`)?.focus());
  }

  return <nav aria-label="Learning modes" className={styles.modeTabs} onKeyDown={handleKeyDown} role="tablist">
    {learningModes.map(({ id, label, icon: Icon }) => <button
      aria-selected={mode === id}
      className={mode === id ? styles.activeMode : ""}
      id={`learning-mode-tab-${id}`}
      key={id}
      onClick={() => onChange(id)}
      role="tab"
      tabIndex={mode === id ? 0 : -1}
      type="button"
    ><Icon aria-hidden="true" size={15} /> {label}</button>)}
  </nav>;
}

function InlineTopicCheckpoint({
  draftPreviewCount,
  skillId,
}: {
  readonly draftPreviewCount: number;
  readonly skillId: string;
}) {
  return (
    <details className={styles.inlineCheckpoint} open>
      <summary>
        <span aria-hidden="true"><ListChecks size={18} /></span>
        <div>
          <strong>Topic checkpoint · one reviewed MCQ</strong>
          <small>Only an independently human-reviewed question from the current publication can create official evidence here.</small>
        </div>
        <ChevronRight aria-hidden="true" size={18} />
      </summary>
      <div className={styles.inlineCheckpointBody}>
        <PracticePanel draftPreviewCount={draftPreviewCount} purpose="checkpoint" skillId={skillId} />
      </div>
    </details>
  );
}

export function DsaLanguageRequired() {
  return <div className={styles.languageGatePage}>
    <section aria-labelledby="dsa-language-required-title" className={`${styles.languageGateCard} card`} role="alert">
      <div className={styles.languageGateIcon}><AlertTriangle aria-hidden="true" size={24} /></div>
      <div>
        <span className={styles.eyebrow}>DSA setup required</span>
        <h1 id="dsa-language-required-title">Choose an implementation language before opening this lesson.</h1>
        <p>Your concepts can transfer between languages, but code drafts and syntax evidence must stay locked to one active DSA language. Select C, C++, Java, or Python in your learning plan.</p>
        <p className={styles.languageGateHelp}>Return to your roadmap. If DSA is already enrolled, ask the administrator to repair the missing language selection.</p>
        <Link className="button button-primary" href="/roadmap">Return to roadmap <ArrowRight aria-hidden="true" size={15} /></Link>
      </div>
    </section>
  </div>;
}

function AuthoredLessonWorkspace({ authoredLesson, assessmentBank, blueprint, skill, courseTitle, moduleTitle, dsaRunnerLanguage, previousHref, nextHref }: LessonWorkspaceProps & { authoredLesson: AuthoredLesson }) {
  const [mode, setMode] = useState<LearningMode>("lesson");
  const [tutor, setTutor] = useState(false);
  return <div className={`${styles.workspace} ${tutor ? styles.withTutor : ""}`}>
    <header className={styles.header}>
      <Link href={`/courses/${blueprint.courseId}`}><ArrowLeft size={16} /> {courseTitle}</Link>
      <div className={styles.lessonTitle}><span>{moduleTitle}</span><strong>{skill.title}</strong></div>
      <div className={styles.headerProgress}><span>Draft preview</span></div>
      <button className={styles.askButton} onClick={() => setTutor(!tutor)} type="button"><Bot size={16} /> Ask Codestead</button>
    </header>
    <div className={styles.body}>
      <aside className={styles.outline}>
        <span>AUTHORED PILOT</span>
        {["canonical-explanation", "worked-examples", "trace", "misconceptions", "transfer-practice", "remediation", "recap", "source-provenance"].map((id, index) => <a href={`#${id}`} key={id}><b>{index + 1}</b><span><strong>{id.replaceAll("-", " ")}</strong></span></a>)}
      </aside>
      <main className={styles.content}>
        <LearningModeTabs mode={mode} onChange={setMode} />
        <section aria-labelledby={`learning-mode-tab-${mode}`} id="learning-mode-panel" role="tabpanel" tabIndex={0}>
          {mode === "lesson" && <><AuthoredLessonCard lesson={authoredLesson} /><InlineTopicCheckpoint draftPreviewCount={assessmentBank?.items.length ?? 0} skillId={skill.id} /></>}
          {mode === "practice" && <PracticePanel skillId={skill.id} draftPreviewCount={assessmentBank?.items.length ?? 0} />}
          {mode === "code" && <CodeLab courseId={blueprint.courseId} dsaRunnerLanguage={dsaRunnerLanguage} skillId={skill.id} />}
          {mode === "visual" && <Visualizer trace={authoredLesson.trace} />}
          {mode === "game" && <LogicGame bank={assessmentBank} skill={skill} />}
        </section>
        <footer className={styles.lessonNav}>
          {previousHref ? <Link className="button button-secondary" href={previousHref}><ArrowLeft size={15} /> Previous skill</Link> : <span />}
          {nextHref ? <Link className="button button-primary" href={nextHref}>Next skill <ArrowRight size={15} /></Link> : <Link className="button button-primary" href={`/courses/${blueprint.courseId}`}>Return to roadmap <CheckCircle2 size={15} /></Link>}
        </footer>
      </main>
      {tutor && <TutorPanel courseId={blueprint.courseId} skillId={skill.id} onClose={() => setTutor(false)} />}
    </div>
  </div>;
}

function BlueprintLessonWorkspace({ assessmentBank, blueprint, skill, courseTitle, moduleTitle, dsaRunnerLanguage, nextHref }: LessonWorkspaceProps) {
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<LearningMode>("lesson");
  const [tutor, setTutor] = useState(false);
  const block = blueprint.blocks[active];
  const progress = Math.round(((active + 1) / blueprint.blocks.length) * 100);
  return <div className={`${styles.workspace} ${tutor ? styles.withTutor : ""}`}>
    <header className={styles.header}>
      <Link href={`/courses/${blueprint.courseId}`}><ArrowLeft size={16} /> {courseTitle}</Link>
      <div className={styles.lessonTitle}><span>{moduleTitle}</span><strong>{skill.title}</strong></div>
      <div className={styles.headerProgress}><span>{progress}%</span><div><i style={{ width: `${progress}%` }} /></div></div>
      <button className={styles.askButton} onClick={() => setTutor(!tutor)} type="button"><Bot size={16} /> Ask Codestead</button>
    </header>
    <div className={styles.body}>
      <aside className={styles.outline}>
        <span>LESSON PATH</span>
        {blueprint.blocks.map((item, index) => <button
          className={index === active ? styles.activeOutline : index < active ? styles.completeOutline : ""}
          key={item.id}
          onClick={() => { setActive(index); setMode("lesson"); }}
          type="button"
        ><b>{index < active ? <Check size={13} /> : index + 1}</b><span><strong>{item.title}</strong><small>{blockSummary(item)}</small></span></button>)}
      </aside>
      <main className={styles.content}>
        <LearningModeTabs mode={mode} onChange={setMode} />
        <section aria-labelledby={`learning-mode-tab-${mode}`} id="learning-mode-panel" role="tabpanel" tabIndex={0}>
          {mode === "lesson" && <><article className={styles.lessonCard}><div className={styles.blockMeta}><span>{String(active + 1).padStart(2, "0")} / {String(blueprint.blocks.length).padStart(2, "0")}</span><i>{block.kind.replaceAll("-", " ")}</i></div><h1>{block.title}</h1><p className={styles.blockSummary}>{blockSummary(block)}</p><LessonBlock block={block} /><div className={styles.draftNotice}><ListChecks size={17} /><span><strong>Beta authored fallback</strong><small>{blueprint.provenance.notice}</small></span></div></article><InlineTopicCheckpoint draftPreviewCount={assessmentBank?.items.length ?? 0} skillId={skill.id} /></>}
          {mode === "practice" && <PracticePanel skillId={skill.id} draftPreviewCount={assessmentBank?.items.length ?? 0} />}
          {mode === "code" && <CodeLab courseId={blueprint.courseId} dsaRunnerLanguage={dsaRunnerLanguage} skillId={skill.id} />}
          {mode === "visual" && <Visualizer />}
          {mode === "game" && <LogicGame bank={assessmentBank} skill={skill} />}
        </section>
        <footer className={styles.lessonNav}>
          <button className="button button-secondary" disabled={active === 0} onClick={() => setActive((value) => Math.max(0, value - 1))} type="button"><ArrowLeft size={15} /> Previous</button>
          {active < blueprint.blocks.length - 1
            ? <button className="button button-primary" onClick={() => setActive((value) => value + 1)} type="button">Mark read &amp; continue <ChevronRight size={15} /></button>
            : nextHref
              ? <Link className="button button-primary" href={nextHref}>Next skill <ArrowRight size={15} /></Link>
              : <Link className="button button-primary" href={`/courses/${blueprint.courseId}`}>Return to roadmap <CheckCircle2 size={15} /></Link>}
        </footer>
      </main>
      {tutor && <TutorPanel courseId={blueprint.courseId} skillId={skill.id} onClose={() => setTutor(false)} />}
    </div>
  </div>;
}

export function LessonWorkspace(props: LessonWorkspaceProps) {
  if (props.blueprint.courseId === "dsa" && !props.dsaRunnerLanguage) return <DsaLanguageRequired />;
  return props.authoredLesson
    ? <AuthoredLessonWorkspace {...props} authoredLesson={props.authoredLesson} />
    : <BlueprintLessonWorkspace {...props} />;
}
