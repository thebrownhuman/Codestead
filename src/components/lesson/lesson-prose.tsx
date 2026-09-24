"use client";

import { Check, Eye, X } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import styles from "./lesson-prose.module.css";

type PredictBlock = Readonly<{
  code?: string;
  question: string;
  options: readonly string[];
  answer: number;
  why: string;
}>;

type RevealBlock = Readonly<{ prompt: string; answer: string }>;

function parseBlock<T>(raw: string, valid: (value: Record<string, unknown>) => boolean): T | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && valid(value as Record<string, unknown>) ? value as T : null;
  } catch {
    return null;
  }
}

const isPredict = (v: Record<string, unknown>) =>
  typeof v.question === "string"
  && Array.isArray(v.options) && v.options.length >= 2 && v.options.every((o) => typeof o === "string")
  && Number.isInteger(v.answer) && (v.answer as number) >= 0 && (v.answer as number) < v.options.length
  && typeof v.why === "string"
  && (v.code === undefined || typeof v.code === "string");

const isReveal = (v: Record<string, unknown>) => typeof v.prompt === "string" && typeof v.answer === "string";

function Predict({ block }: Readonly<{ block: PredictBlock }>) {
  const [picked, setPicked] = useState<number | null>(null);
  const correct = picked === block.answer;
  return <div className={styles.widget} data-kind="predict">
    <span className={styles.widgetLabel}>Predict first</span>
    {block.code && <pre><code>{block.code}</code></pre>}
    <p className={styles.widgetQuestion}>{block.question}</p>
    <div className={styles.options} role="group" aria-label={block.question}>
      {block.options.map((option, index) => {
        const state = picked === null ? undefined : index === block.answer ? "right" : index === picked ? "wrong" : undefined;
        return <button aria-pressed={picked === index} data-state={state} key={option} onClick={() => setPicked(index)} type="button">
          {state === "right" && <Check aria-hidden="true" size={16} />}
          {state === "wrong" && <X aria-hidden="true" size={16} />}
          <code>{option}</code>
        </button>;
      })}
    </div>
    {picked !== null && <div aria-live="polite" className={styles.feedback} data-correct={correct}>
      <strong>{correct ? "Nailed it." : "Not quite — and that's the useful part."}</strong>
      <LessonProse>{block.why}</LessonProse>
      {!correct && <button className={styles.retry} onClick={() => setPicked(null)} type="button">Try again</button>}
    </div>}
  </div>;
}

function Reveal({ block }: Readonly<{ block: RevealBlock }>) {
  const [open, setOpen] = useState(false);
  return <div className={styles.widget} data-kind="reveal">
    <span className={styles.widgetLabel}>Think, then peek</span>
    <LessonProse>{block.prompt}</LessonProse>
    {open
      ? <div aria-live="polite" className={styles.feedback} data-correct="true"><LessonProse>{block.answer}</LessonProse></div>
      : <button className={styles.retry} onClick={() => setOpen(true)} type="button"><Eye aria-hidden="true" size={16} /> I&apos;ve got my answer — show me</button>}
  </div>;
}

// Authored lesson text is Markdown. Fenced ```predict / ```reveal blocks with a
// JSON body become interactive widgets; malformed blocks fall back to plain code.
// Raw HTML is never rendered.
export function LessonProse({ children }: Readonly<{ children: string }>) {
  return <div className={styles.prose}>
    <ReactMarkdown
      components={{
        h1: "strong",
        h2: "strong",
        h3: "strong",
        h4: "strong",
        h5: "strong",
        h6: "strong",
        a: ({ children: label, href }) => <a href={href} rel="noreferrer noopener" target="_blank">{label}</a>,
        pre: ({ children: inner, node }) => {
          const code = node?.children?.[0];
          const className = code && "properties" in code ? String((code.properties?.className as string[] | undefined)?.[0] ?? "") : "";
          const text = code && "children" in code ? code.children.map((child) => ("value" in child ? child.value : "")).join("") : "";
          if (className === "language-predict") {
            const block = parseBlock<PredictBlock>(text, isPredict);
            if (block) return <Predict block={block} />;
          }
          if (className === "language-reveal") {
            const block = parseBlock<RevealBlock>(text, isReveal);
            if (block) return <Reveal block={block} />;
          }
          return <pre>{inner}</pre>;
        },
      }}
      remarkPlugins={[remarkGfm]}
    >{children}</ReactMarkdown>
  </div>;
}

// Short lesson strings (list items, choices, results): Markdown without block wrappers.
export function LessonInline({ children }: Readonly<{ children: string }>) {
  return <ReactMarkdown
    allowedElements={["p", "code", "strong", "em", "del", "a"]}
    components={{
      p: ({ children: inner }) => <>{inner}</>,
      a: ({ children: label, href }) => <a href={href} rel="noreferrer noopener" target="_blank">{label}</a>,
    }}
    remarkPlugins={[remarkGfm]}
    unwrapDisallowed
  >{children}</ReactMarkdown>;
}
