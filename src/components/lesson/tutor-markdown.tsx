"use client";

import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import styles from "./tutor-markdown.module.css";

// A small, dependency-free highlighter: tutor snippets are short, so a single
// regex pass over comments, strings, numbers and keywords is enough colour.
const KEYWORDS = new Set([
  "and", "as", "async", "await", "break", "case", "catch", "char", "class", "const", "continue", "def", "default",
  "do", "double", "elif", "else", "enum", "except", "export", "extends", "false", "False", "final", "finally", "float",
  "for", "fn", "from", "func", "function", "if", "import", "in", "int", "interface", "is", "lambda", "let", "long",
  "new", "None", "not", "null", "nullptr", "or", "pass", "private", "protected", "public", "raise", "return", "self",
  "static", "std", "struct", "switch", "this", "throw", "true", "True", "try", "type", "typedef", "undefined", "using",
  "var", "void", "while", "with", "yield", "include", "print", "printf", "cout", "cin", "endl", "bool", "string",
]);
const TOKEN = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;

function highlight(code: string, language: string): ReactNode[] {
  const hashComments = !["c", "cpp", "c++", "java", "javascript", "js", "typescript", "ts", "html", "css"].includes(language);
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of code.matchAll(TOKEN)) {
    const token = match[0];
    const index = match.index ?? 0;
    let kind: string | null = null;
    if (token.startsWith("//") || token.startsWith("/*") || (token.startsWith("#") && hashComments)) kind = "comment";
    else if (token.startsWith("#")) kind = "keyword";
    else if (/^["'`]/.test(token)) kind = "string";
    else if (/^\d/.test(token)) kind = "number";
    else if (KEYWORDS.has(token)) kind = "keyword";
    else if (code[index + token.length] === "(") kind = "call";
    if (!kind) continue;
    if (index > last) out.push(code.slice(last, index));
    out.push(<span className={styles[kind]} key={index}>{token}</span>);
    last = index + token.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function CodeBlock({ code, language }: Readonly<{ code: string; language: string }>) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return <div className={styles.codeBlock}>
    <div className={styles.codeHead}>
      <span>{language || "code"}</span>
      <button aria-label={copied ? "Copied" : "Copy code"} onClick={() => void copy()} type="button">
        {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
    <pre><code>{highlight(code, language)}</code></pre>
  </div>;
}

// Tutor replies are Markdown from a model: render it, but never raw HTML, and
// open links in a new tab without referrer.
export function TutorMarkdown({ children }: Readonly<{ children: string }>) {
  return <div className={styles.markdown}>
    <ReactMarkdown
      components={{
        h1: ({ children: inner }) => <h3>{inner}</h3>,
        h2: ({ children: inner }) => <h3>{inner}</h3>,
        h3: ({ children: inner }) => <h4>{inner}</h4>,
        a: ({ children: label, href }) => <a href={href} rel="noreferrer noopener" target="_blank">{label}</a>,
        pre: ({ node }) => {
          const code = node?.children?.[0];
          const className = code && "properties" in code ? String((code.properties?.className as string[] | undefined)?.[0] ?? "") : "";
          const text = code && "children" in code ? code.children.map((child) => ("value" in child ? child.value : "")).join("") : "";
          return <CodeBlock code={text.replace(/\n$/, "")} language={className.replace(/^language-/, "").toLowerCase()} />;
        },
      }}
      remarkPlugins={[remarkGfm]}
    >{children}</ReactMarkdown>
  </div>;
}
